/**
 * 点餐 Agent 主 loop（架构重构版）
 *
 * ⓘ 身份与记忆（静默，不占 stage）
 * ① 意图解析          → stage: intent    （LLM 主导，顺带判 clarity）
 * ①.5 购物车直改      → 命中则直接结束
 * ①.6 旁路背景判断    → stage: context   （**仅 clarity=vague 时跑**）
 * ② 导入 MCP 真实数据 → stage: menu
 * ③ 选品（规则）      → 紧跟出单判断 → stage: review
 * ④ 算价              → stage: coupon
 * ⑤ 文案生成          → stage: compose
 * ⑥ 落盘 + 同步购物车
 *
 * 架构原则（用户定的）：
 *   - **意图解析直接用 LLM**，规则降级成"确定性约束抽取 + 兜底"，
 *     不再由规则决定"这句话够不够清楚"；
 *   - **模糊意图走旁路**：用用户知识 + 当下时间推出判断结论，导入主 loop，
 *     而不是把问题反问回去；
 *   - **明确意图跳过旁路**（「我要吃辣」「3 个人 50 块」直接进第 ② 步）；
 *   - 模型始终没有选品权和定价权：菜单由规则产出，模型只做判断和说话，
 *     所有纠偏动作都由本地白名单执行。
 */
import { createLogger } from '../lib/logger.js';
import { AuthError, McpDownError, NeedLocationError, RateLimitError, toApiError, } from '../lib/errors.js';
import { parseIntentWithLlm, analyzeContext, applyContextToIntent } from './llm-intent.service.js';
import { composeStrategy } from './knowledge.service.js';
import { getMemoryService, InMemoryStore, MemoryService } from './memory.service.js';
import { callTool } from '../mcp/gateway.js';
import { adaptProducts, adaptStores, adaptNutrition, adaptCoupons, } from './mcp-adapter.js';
import { fulfillmentArgs, pickAddress, resolveDeliveryStore, calcDeliveryPrice, } from './delivery.service.js';
import { selectProducts, buildMenuItems } from './selector.service.js';
import { reviewMenu, applyReviewFixes, decideAction } from './menu-review.service.js';
import { replaceFromMenu, getCart, addItem, updateItem, removeItem, clearCart, resolveProduct, searchProducts } from './cart.service.js';
import { parseCartIntent, findItemByName } from './cart-intent.service.js';
import { renderReply, renderClarify, computeTotals } from './reply.renderer.js';
import { buildSystemPrompt, buildUserPrompt } from '../prompts/system.js';
import { pickFallback } from '../prompts/fallbacks.js';
import { pickStageText } from '../prompts/stage-texts.js';
import { chat } from './llm.client.js';
import { getDb } from '../db/index.js';
import { stableHash } from '../lib/crypto.js';
import { randomBytes } from 'node:crypto';
const log = createLogger('orchestrator');
/* ------------------------------------------------------------------ */
/* 主流程                                                            */
/* ------------------------------------------------------------------ */
export async function* runChat(input) {
    const { userId, message, guest = false } = input;
    const now = new Date();
    const memory = guest || !userId ? new MemoryService(new InMemoryStore()) : getMemoryService();
    const snapshot = userId && !guest ? memory.snapshot(userId, now) : null;
    /* ---------------- ① 意图解析（LLM 主导） ---------------- */
    yield { type: 'stage', stage: 'intent', text: pickStageText('intent') };
    /**
     * 现在是「直接用 LLM 做意图解析」。
     *
     * `parseIntentWithLlm` 内部已经处理了全部降级：模型挂了/超时/返回乱码，
     * 会自动退回规则解析并给出 clarity —— 所以这里不需要再写一层 try/catch。
     *
     * 与旧版最大的区别：`clarity` 由**模型**判定，不由规则判定。
     * 旧版靠「有没有 people/budget/taboo/taste」推"够不够清楚"，
     * 于是「今天好烦」因为有"今天"被判成清楚，直接硬选品；
     * 而「帮我点个午餐」因为什么都没有被判成模糊，被反问一句
     * 「想吃带劲的还是舒服的」。两头的判断都不对，根子在这个位置。
     */
    let intent = await parseIntentWithLlm(message, { now });
    /**
     * 履约方式以**前端显式选择为准**（对话开局选的那一下），
     * 只有前端没传时才退回到从文本里解析（如用户直接说「点个外卖」）。
     */
    const fulfillment = input.fulfillment ?? intent.explicit.fulfillment ?? '自取';
    intent.explicit.fulfillment = fulfillment;
    const delivery = fulfillment === '外送';
    /**
     * ---------------- ①.5 购物车直改 ----------------
     *
     * 「薯条删掉」「可乐来两杯」这类话**不是**在重新点餐，
     * 而是在改右边那份已经在配的单。
     *
     * 必须放在旁路和选品之前：
     *   · 放在反问之前 —— 这类句子通常很短、情绪很平，正好会命中"太模糊"的规则，
     *     于是用户说"删掉薯条"，系统回一句"你想吃带劲的还是舒服的"；
     *   · 放在选品之前 —— 走选品会把整份菜单换掉，
     *     用户只想删一份薯条，结果一单被重配。
     *
     * 也必须放在旁路之前：改车是确定性操作，让模型去分析"用户为什么想删薯条"
     * 纯属浪费一次调用，还会拖慢几百毫秒。
     */
    const cartAction = parseCartIntent(message);
    if (cartAction.kind !== 'none' && userId && !guest) {
        const result = await tryHandleCartAction(userId, cartAction, fulfillment, input.addressId);
        if (result) {
            yield { type: 'reply', payload: result };
            const chatId = persistChat(userId, message, result, now, { fulfillment });
            yield { type: 'done', chatId };
            return;
        }
    }
    /* ---------------- ② 知识匹配（静默，不占 stage） ---------------- */
    /**
     * 记忆里的忌口要**让位给当轮明说的口味**。
     *
     * 真实场景踩到的：记忆里记着「忌辣」（用户以前说过不吃辣），
     * 这一轮 ta 说「我要吃辣的」。如果两边都当真，系统会陷入自相矛盾 ——
     * 选品因为 taste=辣 挑了一份龙焰鸡腿堡，文案却写
     * 「辣的我得拦一下——你忌辣这事儿我记着」，一边给一边拦，用户直接懵。
     *
     * 规则：**当轮原话 > 历史记忆**。
     * 但有个不能碰的例外：过敏类绝对不让位。所以这里只让"口味型忌口"
     * （辣/甜/冰/咖啡这类）退让，真正的过敏源（花生/海鲜/坚果…）永远保留。
     * 区分方式很朴素：当轮用户明确要的那个词，如果属于口味维度，就把它从记忆忌口里摘掉。
     */
    const memoryTaboo = dropOverriddenTaboo(snapshot?.taboo ?? [], intent.explicit.taste);
    if (memoryTaboo.length !== (snapshot?.taboo ?? []).length) {
        log.info(`用户本轮明确想吃「${intent.explicit.taste.join('、')}」，` +
            `记忆里的同类忌口已让位（保留：${memoryTaboo.join('、') || '无'}）`);
    }
    let strategyCtx;
    try {
        strategyCtx = composeStrategy({
            now,
            ...(getProfileBirthday(userId, guest) ? { birthday: getProfileBirthday(userId, guest) } : {}),
            mood: intent.mood,
            taboo: [...intent.explicit.taboo, ...memoryTaboo],
            safetyMode: intent.safetyMode,
        });
    }
    catch (err) {
        log.warn(`知识匹配失败，用兜底：${err.message}`);
        strategyCtx = composeStrategy({ now, mood: intent.mood, taboo: [] });
    }
    /**
     * ---------------- ①.6 旁路：用户知识 + 时间背景 ----------------
     *
     * **只在意图模糊时跑。**
     *
     * 用户原话：「如果是模糊意图，比如说是很烦，今天心情不错，或者说类似就是
     * 给我点个午餐没有明确的。旁路根据用户知识（包括当下时间判断），
     * 判断结论导入主loop。……如果有明确意图 比如我要吃辣，3个人50块这种，
     * 就不需要旁路进行用户知识背景分析，直接第二步」
     *
     * 旁路的产物**不是菜单**，是一份判断结论（方向标签 + 推定人数/预算 + 该避开的），
     * 由 `applyContextToIntent` 合并进 intent，再交给确定性选品引擎去真实菜单里落地。
     * 这样"模糊"就不会变成"再问一遍用户"，而是变成"系统替你多想了想"。
     */
    /**
     * 旁路结论（`contextRead` / `contextAvoid`）已经由 `applyContextToIntent`
     * 写进 intent 了，这里不需要再单独持有 —— 少一份并行状态，少一处漏改。
     */
    if (intent.clarity === 'vague' && !intent.safetyMode) {
        yield { type: 'stage', stage: 'context', text: pickStageText('context') };
        const ctx = await analyzeContext({
            message,
            now,
            timeFacts: {
                slot: strategyCtx.timeSlot,
                week: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()],
                solarTerm: strategyCtx.solarTerm.name,
                solarTermImagery: strategyCtx.solarTerm.imagery,
                retrograde: strategyCtx.retrograde?.active
                    ? `第 ${strategyCtx.retrograde.dayIndex} 天`
                    : null,
            },
            snapshot: snapshot
                ? {
                    ...(snapshot.nickname ? { nickname: snapshot.nickname } : {}),
                    taboo: snapshot.taboo,
                    tasteTags: snapshot.tasteTags,
                    topItems: snapshot.topItems,
                    customs: snapshot.customs,
                    recentMoods: snapshot.recentMoods.map((m) => ({ date: m.date, mood: m.mood })),
                    ...(snapshot.budgetRange ? { budgetRange: snapshot.budgetRange } : {}),
                    ...(snapshot.usualStore ? { usualStore: snapshot.usualStore } : {}),
                }
                : null,
        });
        if (ctx.ran) {
            intent = applyContextToIntent(intent, ctx);
            // 旁路推出情绪后，知识层要跟着重算（情绪策略直接影响选品打分）
            if (intent.mood && strategyCtx.mood !== intent.mood) {
                try {
                    strategyCtx = composeStrategy({
                        now,
                        ...(getProfileBirthday(userId, guest)
                            ? { birthday: getProfileBirthday(userId, guest) }
                            : {}),
                        mood: intent.mood,
                        taboo: [...intent.explicit.taboo, ...memoryTaboo],
                        safetyMode: intent.safetyMode,
                    });
                }
                catch {
                    /* 上面已经兜住，这里失败就沿用旧的 strategyCtx */
                }
            }
        }
    }
    else if (intent.clarity === 'clear') {
        log.info('意图明确，跳过旁路直接查菜单');
    }
    /* ---------------- 反问分支（降级路径） ---------------- */
    /**
     * 新架构下反问是**降级路径**，不是常规路径。
     *
     * 判据变了：只有"旁路都判断不出来"才问 —— 也就是意图模糊、
     * 旁路又没给出任何方向（没 tasteHints、没 mood、没人数），
     * 说明这句话真的什么信息都没有（"嗯……"「随便」）。
     *
     * 而且**只问一次**。这是修「反复问同一句话」的地方：
     * 如果上一轮已经反问过，这一轮无论多模糊都必须给菜单。
     * 反问文案是固定的，用户很可能照着这句话回答甚至复读，
     * 只要解析层漏认其中任何一个词就会再问一遍 —— 用户被困在一个出不去的问题里。
     * 与其指望"用户说的每个词都能认"，不如从规则上禁止连问两次。
     */
    const askedBefore = lastTurnWasClarify(userId, guest);
    const sideChannelEmpty = intent.explicit.taste.length === 0 &&
        intent.mood === null &&
        intent.explicit.people === undefined &&
        intent.explicit.budget === undefined;
    if (intent.clarity === 'vague' && sideChannelEmpty && !askedBefore && !intent.safetyMode) {
        const question = pickClarifyBySlot(strategyCtx.timeSlot);
        const reply = renderClarify(question);
        if (guest)
            reply.upsell = 'login';
        const chatId = persistChat(userId, message, reply, now, { fulfillment });
        yield { type: 'reply', payload: reply };
        yield { type: 'done', chatId };
        return;
    }
    if (intent.needsClarify && askedBefore) {
        log.info('上一轮已反问过，本轮不再追问，直接出菜单');
        intent.needsClarify = false;
        delete intent.clarifyQuestion;
    }
    /* ---------------- ③ MCP 现实校准 ---------------- */
    yield { type: 'stage', stage: 'menu', text: pickStageText('menu') };
    /**
     * 数据来源只有 mcp / cache 两种。
     *
     * 「离线兜底菜单」已按产品要求**移除**：
     * 拿不到真实门店/真实菜单就明确告诉用户"没拿到"，绝不编一份看起来像真的菜单。
     * 理由：假菜单会把用户引到一次下不了单的对话，比直接报错更糟。
     */
    let dataSource = 'mcp';
    let store = { storeCode: '', name: '' };
    let products = [];
    let nutrition;
    let coupons = [];
    let deliveryAddress;
    let deliveryBeCode;
    if (!userId || guest) {
        // 访客没有 Token，拿不到任何真实数据 —— 直接说清楚，不编菜单
        yield {
            type: 'error',
            error: 'NEED_LOGIN',
            message: '要先粘贴你的麦当劳 Token，我才能查到你附近门店的真实菜单',
        };
        return;
    }
    /**
     * 外送前置校验：没有地址就没法查可配送门店，更没法算价下单。
     * 这里必须**提前**拦住并给出专用错误码，让前端弹「选地址/新建地址」，
     * 而不是等一路跑到算价才报一个看不懂的 MCP 错误。
     */
    if (delivery) {
        try {
            const addr = await pickAddress(userId, input.addressId);
            if (!addr) {
                yield {
                    type: 'error',
                    error: 'NEED_ADDRESS',
                    message: '麦乐送要先选一个配送地址，告诉我送哪儿',
                };
                return;
            }
            deliveryAddress = [addr.contactName, addr.phone, addr.fullAddress].filter(Boolean).join(' · ');
            input.addressId = addr.addressId;
        }
        catch (err) {
            if (err instanceof AuthError) {
                yield { type: 'error', error: 'TOKEN_INVALID', message: err.message };
                return;
            }
            const api = toApiError(err);
            yield { type: 'error', error: api.body.error, message: api.body.message };
            return;
        }
    }
    try {
        const result = await withStageTimeout(fetchFromMcp(userId, strategyCtx, snapshot, now, fulfillment, input.addressId, input.signal), 45_000);
        store = result.store;
        products = result.products;
        nutrition = result.nutrition;
        coupons = result.coupons;
        deliveryBeCode = result.beCode;
    }
    catch (err) {
        if (err instanceof AuthError) {
            yield { type: 'error', error: 'TOKEN_INVALID', message: err.message };
            return;
        }
        // 其它失败：如实上报，不给假菜单
        const api = toApiError(err);
        log.warn(`MCP 阶段失败，如实报错：${err.message}`);
        yield { type: 'error', error: api.body.error, message: api.body.message };
        return;
    }
    if (products.length === 0) {
        yield {
            type: 'error',
            error: 'MCP_DOWN',
            message: '这家店现在没有查到可点的商品，换个门店或稍后再试',
        };
        return;
    }
    /* ---------------- 选品（确定性） ---------------- */
    /**
     * 人数：**没说就按 1 个人**。
     *
     * 产品口径（用户明确要求）：没提人数一律当一个人，不给"你是不是两个人吃"
     * 这种反问 —— 一个人点餐是最常见的场景，多问一句只是打断。
     * 这里也接收旁路推断的人数（用户原话没说时由旁路按场景估）：
     * 优先级是「用户明说 > 旁路推断 > 默认 1 人」。
     * `peopleExplicit` 区分的是"用户是否真的说了"，供判断环节决定措辞严厉程度。
     */
    const peopleExplicit = intent.explicit.people !== undefined;
    const people = intent.explicit.people ?? 1;
    const budget = intent.explicit.budget;
    /**
     * 购物车结论（**先于选品读取**）。
     *
     * 为什么要在选品前读：
     *   里面有一条「用户手动删掉了什么」的信号，必须在选品时就生效 ——
     *   用户删了薯条，这一轮不该再把薯条配回来。
     *   如果等选完品再读，就只能靠模型事后"建议删掉"，
     *   那是补救而不是避免，而且模型未必看得出。
     */
    const existingCart = await readCartQuietly(userId, guest, fulfillment);
    const userRemovals = detectUserRemovals(userId, guest, existingCart.lines);
    if (userRemovals.length > 0) {
        log.info(`购物车显示用户删掉了：${userRemovals.join('、')}，本轮不再配回来`);
    }
    /**
     * 选品时要避开的商品名：两路合并。
     *   1. 旁路判断说"刚吃过/别推"的
     *   2. 用户手动从购物车删掉的（最强信号 —— 这是用户的明确行为）
     *
     * ⚠️ 这里不拦截，只是降权（selector 里 avoidNames 命中会打负分但不删池）。
     * 理由：万一避开后凑不出一单，兜底逻辑还得有东西可选 ——
     * 宁可推一个"理论上该避开"的，也不能让用户拿到空菜单。
     */
    const avoidNames = [...new Set([...(intent.contextAvoid ?? []), ...userRemovals])];
    let selection = selectProducts({
        products,
        strategy: strategyCtx.solarTerm,
        moodStrategy: strategyCtx.moodStrategy,
        snapshot,
        intent,
        people,
        ...(budget !== undefined ? { budget } : {}),
        ...(avoidNames.length > 0 ? { avoidNames } : {}),
    });
    let menu = buildMenuItems({
        picked: selection.items,
        details: selection.details,
        people,
        snapshot,
    });
    if (menu.length === 0) {
        yield {
            type: 'error',
            error: 'MCP_DOWN',
            message: '这家店的菜单没法用这单的条件挑出合适的组合，换个说法或放宽预算试试',
        };
        return;
    }
    /**
     * ---------------- ③ 出单判断（模型判断，本地执行） ----------------
     *
     * 用户原话：「另外调用 llm 根据用户输入和**购物车结论**做判断」
     *
     * 所以这一步必须同时把「这一单」和「车里已有什么」交给模型 ——
     * 只看这一单内部是否自洽是不够的：
     *   车里已经有一份麦辣鸡腿堡套餐，这一轮又配出一个麦辣鸡腿堡，
     *   单看这一单没毛病，放进车里就是重复。
     *
     * 判断结论分三档处理（本地白名单执行，模型无选品权）：
     *   keep   不动
     *   prune  **本地做减法**：删掉多出来的那杯饮料/那份甜品。
     *          只删不加，价格必然只降不升，不会冲破预算。
     *   major  **整单重配**：骨架就不对（1 个人 3 个主食这种），
     *          删一样救不回来。把"最该换掉的名字"带回选品，
     *          让规则在同一批真实商品里重新组一单 —— 仍然不用模型选品。
     *
     * 任何一种处理都**只跑一次**：判断本身要几百毫秒到几秒，
     * 反复来回既慢又可能配得更乱。改完就收，宁可差一点也不要抖。
     *
     * 全程 try/catch 兜住：判断是锦上添花，绝不允许它让用户拿不到菜单。
     */
    yield { type: 'stage', stage: 'review', text: pickStageText('review') };
    try {
        const review = await reviewMenu({
            message,
            people,
            peopleExplicit,
            ...(budget !== undefined ? { budget } : {}),
            taboo: intent.explicit.taboo,
            taste: intent.explicit.taste,
            menu,
            ...(existingCart.lines.length > 0 ? { cart: existingCart.lines } : {}),
            ...(existingCart.lines.length > 0 ? { cartTotal: existingCart.total } : {}),
            /**
             * 关系判定：主 loop 出单是**整体替换**购物车（见文件末尾的 replaceFromMenu）。
             * 所以默认 replace —— 判断环节的重点是"用户手动删过的东西别配回来"，
             * 而不是"跨车去重"。语义搞反会让模型建议无效动作，白烧一次调用。
             */
            cartRelation: 'replace',
            ...(intent.contextRead ? { contextRead: intent.contextRead } : {}),
            ...(avoidNames.length > 0 ? { avoidFromContext: avoidNames } : {}),
        });
        const decision = decideAction(review);
        if (decision.action === 'prune') {
            const fixed = applyReviewFixes(menu, decision.issues);
            if (fixed.applied.length > 0) {
                log.info(`复核纠正（减法）：${fixed.applied.join('；')}`);
                menu = fixed.menu;
            }
        }
        else if (decision.action === 'rebuild') {
            const retry = selectProducts({
                products,
                strategy: strategyCtx.solarTerm,
                moodStrategy: strategyCtx.moodStrategy,
                snapshot,
                intent,
                people,
                ...(budget !== undefined ? { budget } : {}),
                avoidNames: decision.avoidNames,
            });
            const retryMenu = buildMenuItems({
                picked: retry.items,
                details: retry.details,
                people,
                snapshot,
            });
            /**
             * 重配结果要**确实不一样**才采纳。
             * 如果避开了还是挑回同一套（比如全店只有一款套餐），
             * 那就是没得换，此时保留原菜单 + 做减法兜一下，别把菜单换空。
             */
            const same = retryMenu.length === menu.length &&
                retryMenu.every((m, i) => m.name === menu[i]?.name && m.price === menu[i]?.price);
            if (retryMenu.length > 0 && !same) {
                log.info(`复核判定不合理，已重配：避开「${decision.avoidNames.join('、')}」` +
                    ` → ${retryMenu.map((m) => m.name).join('、')}`);
                menu = retryMenu;
            }
            else {
                log.warn('重配挑回了同一套菜单，改为在原菜单上做减法');
                const fixed = applyReviewFixes(menu, decision.issues);
                if (fixed.applied.length > 0)
                    menu = fixed.menu;
            }
        }
    }
    catch (err) {
        // 复核链路的任何失败都不影响主链路
        log.warn(`选品复核异常（已忽略）：${err.message}`);
    }
    /* ---------------- 优惠券 ---------------- */
    let originalTotal;
    if (coupons.length > 0) {
        yield { type: 'stage', stage: 'coupon', text: pickStageText('coupon') };
    }
    // 金额一律由「真实商品价 × 数量」算出（price 字段即小计），不信任任何外部金额
    let finalMenu = menu;
    let finalTotal = computeTotals(menu, budget).total;
    let deliveryFee;
    /**
     * 外送定价：以 calculate-price 为准（total 已含配送费 + 打包费）。
     *
     * 商品单价相加会**少算**这两项，用户看到 77 块、结算页变 84 块，
     * 这是最伤信任的一种错，所以外送一律以 MCP 算价结果为准。
     */
    const priceDelivery = async (m) => {
        if (!delivery || !deliveryBeCode)
            return;
        const priced = await calcDeliveryPrice(userId, {
            storeCode: store.storeCode,
            beCode: deliveryBeCode,
            addressId: input.addressId,
            items: m.map((x) => ({ productCode: x.productId, quantity: parseMenuQty(x.spec) })),
        });
        if (!priced) {
            log.warn(`外送算价失败，退回商品价合计 ${finalTotal}`);
            return;
        }
        finalTotal = priced.total;
        if (priced.original !== undefined)
            originalTotal = priced.original;
        /**
         * 把配送费/打包费如实透出。
         * 拿不到明细时就不显示，绝不写 0 假装免费。
         */
        if (priced.deliveryFee !== undefined || priced.packingFee !== undefined) {
            deliveryFee = {
                delivery: priced.deliveryFee ?? 0,
                packing: priced.packingFee ?? 0,
                ...(priced.minOrder !== undefined ? { minOrder: priced.minOrder } : {}),
            };
        }
    };
    await priceDelivery(finalMenu);
    /**
     * 预算校验（**含外送费**）。
     *
     * 关键点：外送的可用预算不是 budget，而是 budget − 配送费 − 打包费。
     * 早期版本直接拿 budget 去选品，结果商品价刚好 80、加大 9 元运费后
     * 变成 89 —— 用户明确说了 80，就必须真的落在 80 以内。
     *
     * 第一轮拿到的实付总额可以反推出真实费用（实付 − 商品价合计），
     * 用它去收紧第二轮的选品预算。最多重选一次，避免反复烧 MCP 额度。
     */
    if (budget !== undefined && finalTotal > budget + 0.01) {
        const goodsSum = computeTotals(finalMenu).total;
        const feeActual = Math.max(0, Math.round((finalTotal - goodsSum) * 100) / 100);
        // 到店没有额外费用，feeActual = 0；外送就是运费+打包费
        const goodsBudget = budget - feeActual;
        if (goodsBudget >= 10) {
            const retry = selectProducts({
                products,
                strategy: strategyCtx.solarTerm,
                moodStrategy: strategyCtx.moodStrategy,
                snapshot,
                intent,
                people,
                budget: goodsBudget * 0.97, // 留一点余量，避免卡在临界值
            });
            const retryMenu = buildMenuItems({
                picked: retry.items,
                details: retry.details,
                people,
                snapshot,
            });
            if (retryMenu.length > 0) {
                finalMenu = retryMenu;
                finalTotal = computeTotals(retryMenu).total;
                await priceDelivery(finalMenu);
            }
            else {
                log.warn(`预算 ¥${budget} 扣掉外送费 ¥${feeActual} 后不足以组单，保留原方案`);
            }
        }
        else {
            log.warn(`预算 ¥${budget} 扣掉外送费 ¥${feeActual} 后不够 ¥10，无法组单`);
        }
    }
    const finalTotals = computeTotals(finalMenu, budget);
    originalTotal = finalTotals.original;
    const finalBudget = budget !== undefined
        ? {
            limit: budget,
            ok: finalTotal <= budget + 0.001,
            remaining: Math.max(0, Math.round((budget - finalTotal) * 100) / 100),
        }
        : undefined;
    /* ---------------- ④ 输出生成 ---------------- */
    yield { type: 'stage', stage: 'compose', text: pickStageText('compose') };
    const title = pickTitle(intent, strategyCtx, snapshot);
    const slotText = delivery
        ? `${strategyCtx.timeSlot} · 送到你手上`
        : `${strategyCtx.timeSlot} · 现在取`;
    // 先构造一个"事实壳"，给 LLM 看，也作为最终渲染基础
    const replyShell = {
        hook: '',
        meta: { store: store.name, slot: slotText, title, fulfillment },
        menu: finalMenu,
        total: finalTotal,
        ...(originalTotal !== undefined && originalTotal > finalTotal ? { original: originalTotal } : {}),
        ...(finalBudget ? { budget: finalBudget } : {}),
        ...(nutrition ? { nutrition } : {}),
        ...(deliveryFee ? { deliveryFee } : {}),
        ...(deliveryAddress ? { address: deliveryAddress } : {}),
        quote: '',
        actions: ['confirm', 'refine'],
        dataSource,
    };
    let hook = '';
    let quote = '';
    const isReturningUser = Boolean(snapshot && (snapshot.topItems.length > 0 || snapshot.recentMoods.length > 0));
    if (memory && userId && !guest) {
        try {
            const { text } = await generateCopy({
                snapshot,
                strategyCtx,
                intent,
                reply: replyShell,
            });
            const parsed = parseCopy(text);
            if (parsed) {
                hook = parsed.hook;
                quote = parsed.quote;
            }
        }
        catch (err) {
            log.warn(`LLM 生成失败，走模板兜底：${err.message}`);
        }
    }
    if (!hook || !quote) {
        const fb = pickFallback({
            mood: intent.mood,
            strategy: strategyCtx,
            isReturningUser,
            ...(finalBudget ? { budgetOk: finalBudget.ok } : {}),
            safetyMode: intent.safetyMode,
            store: store.name,
        });
        if (!hook)
            hook = fb.hook;
        if (!quote)
            quote = fb.quote;
    }
    const reply = renderReply({
        hook,
        quote,
        store: store.name,
        slot: slotText,
        title,
        menu: finalMenu,
        total: finalTotal,
        ...(originalTotal !== undefined && originalTotal > finalTotal ? { original: originalTotal } : {}),
        ...(finalBudget ? { budget: finalBudget } : {}),
        ...(nutrition ? { nutrition } : {}),
        fulfillment,
        ...(deliveryFee ? { deliveryFee } : {}),
        ...(deliveryAddress ? { address: deliveryAddress } : {}),
        ...(guest ? { upsell: 'login' } : {}),
        dataSource,
    });
    yield { type: 'reply', payload: reply };
    /* ---------------- ⑤ 落盘 ---------------- */
    const chatId = persistChat(userId, message, reply, now, {
        fulfillment,
        ...(input.addressId ? { addressId: input.addressId } : {}),
        ...(deliveryAddress ? { addressText: deliveryAddress } : {}),
        storeCode: store.storeCode,
        ...(deliveryBeCode ? { beCode: deliveryBeCode } : {}),
    });
    /**
     * ⑥ 菜单同步进购物车。
     *
     * 产品改动：菜单不再是聊天气泡里的一张只读卡片，而是右边可编辑的购物车。
     * 用户说「两个人 100 块」→ 这里生成一份菜单 → **整体替换**购物车。
     *
     * 为什么是替换：这句话的语义是"重新组一单"，不是"再加一单"。
     * 合并会变成「上一轮的点餐 + 这一轮的点餐」叠一起，越点越多。
     * 用户明确说「再加」时才走 addItem（见下面的 handleCartIntent）。
     *
     * 失败不影响主链路：菜单已经在 reply 里返回了，购物车写失败最多是
     * 用户手动加一次，不该让他连回复都收不到。
     */
    if (userId && !guest && finalMenu.length > 0) {
        try {
            await replaceFromMenu(userId, finalMenu, {
                fulfillment,
                ...(input.addressId ? { addressId: input.addressId } : {}),
                store: store.name ?? '',
                storeCode: store.storeCode,
                ...(deliveryBeCode ? { beCode: deliveryBeCode } : {}),
            });
        }
        catch (err) {
            log.warn(`购物车同步失败（已忽略）：${err.message}`);
        }
    }
    if (userId && !guest) {
        try {
            await memory.addMoodEntry(userId, {
                date: isoDate(now),
                mood: intent.mood ?? '平淡',
                trigger: message,
                recommended: title,
            });
            await memory.updateRitual(userId, {
                lastSolarTerm: strategyCtx.solarTerm.name,
                ...(strategyCtx.retrograde?.active
                    ? {
                        retrograde: {
                            active: true,
                            dayIndex: strategyCtx.retrograde.dayIndex,
                            startDate: strategyCtx.retrograde.startDate,
                        },
                    }
                    : { retrograde: { active: false } }),
            });
            if (intent.explicit.taboo.length > 0) {
                await memory.appendFact(userId, 'taboo', intent.explicit.taboo);
            }
        }
        catch (err) {
            // 记忆落盘失败不能影响用户
            log.warn(`记忆落盘失败（已忽略）：${err.message}`);
        }
    }
    yield { type: 'done', chatId };
}
/* ------------------------------------------------------------------ */
/* MCP 取数                                                          */
/* ------------------------------------------------------------------ */
async function fetchFromMcp(userId, ctx, snapshot, now, fulfillment = '自取', addressId, signal) {
    throwIfAborted(signal);
    const { orderType, beType, delivery } = fulfillmentArgs(fulfillment);
    /**
     * --- 门店 ---
     *
     * 到店与外送是**两套门店查询**，绝对不能混用：
     *
     * 【到店】query-nearby-stores { beType:1, searchType:1|2, city?, keyword? }
     *   · searchType=1 → 只搜「收藏餐厅」，没收藏就返回空
     *   · searchType=2 → 按 城市 + 关键词 搜，这才是普通用户能用的
     *   · 这个工具**不接受经纬度**。浏览器定位拿到的坐标
     *     已经在 POST /api/location 时反查成 city + district 存进记忆
     *
     * 【外送】delivery-query-stores { addressId, beType:2 }
     *   · 只认地址，不认城市/关键词
     *   · 返回的门店就是这个地址**能送到**的店，且必带 beCode
     */
    let store;
    if (delivery) {
        if (!addressId)
            throw new McpDownError('外送缺少配送地址');
        // 外送门店直接由地址决定，优先沿用记忆里的常去店（若在配送范围内）
        store = await resolveDeliveryStore(userId, addressId, snapshot?.usualStore ?? undefined);
    }
    else {
        store = await resolveNearbyStore(userId, snapshot);
    }
    /* --- 菜单：必须按对应场景查，商品编码是两套 --- */
    throwIfAborted(signal);
    /**
     * orderType / beCode 传递规则（catalog 明确要求，错一个就报错）：
     *   到店自取(beType=1)   → orderType=1，不传 beCode（传了会报错）
     *   外送(beType=2)       → orderType=2，必传 beCode
     */
    const mealArgs = {
        storeCode: store.storeCode,
        orderType,
        beType,
    };
    if (delivery) {
        if (!store.beCode) {
            throw new McpDownError('这家外送门店没给业务编码，换个地址试试');
        }
        mealArgs.beCode = store.beCode;
    }
    else if (store.beCode) {
        // 得来速等场景才有；到店自取时 store.beCode 通常为空
        mealArgs.beCode = store.beCode;
    }
    const mealsRaw = await callTool(userId, 'query-meals', mealArgs);
    const products = adaptProducts(mealsRaw);
    if (products.length === 0) {
        log.warn(`query-meals 未解析出商品 store=${store.storeCode} orderType=${orderType}`);
        throw new McpDownError(delivery ? '这家外送店现在没有可点的商品' : '这家店现在没有可点的商品');
    }
    /* --- 优惠券（失败不阻塞） --- */
    let coupons = [];
    try {
        const raw = await callTool(userId, 'available-coupons', {});
        coupons = adaptCoupons(raw);
    }
    catch {
        /* ignore */
    }
    /* --- 营养（失败不阻塞） --- */
    let nutrition;
    try {
        const raw = await callTool(userId, 'list-nutrition-foods', {});
        nutrition = adaptNutrition(raw);
    }
    catch {
        /* ignore */
    }
    return {
        store,
        products,
        ...(nutrition ? { nutrition } : {}),
        coupons,
        ...(delivery && store.beCode ? { beCode: store.beCode } : {}),
    };
}
/**
 * 到店门店查询（城市 + 关键词语义搜索）。
 *
 * 抽出来是因为下单时 order.service 也要用同一套逻辑回查 storeCode，
 * 两处各写一份必然漂移。
 */
export async function resolveNearbyStore(userId, snapshot) {
    const city = snapshot?.usualCity ?? '';
    const keyword = snapshot?.usualKeyword ?? snapshot?.usualStore ?? '';
    let stores = [];
    const queries = [];
    if (city) {
        if (keyword)
            queries.push({ beType: 1, searchType: 2, city, keyword });
        // 商圈搜不到就放宽到整个城市
        if (keyword !== '麦当劳') {
            queries.push({ beType: 1, searchType: 2, city, keyword: '麦当劳' });
        }
    }
    for (const q of queries) {
        try {
            const raw = await callTool(userId, 'query-nearby-stores', q);
            const got = adaptStores(raw);
            if (got.length > 0) {
                stores = got;
                break;
            }
        }
        catch (err) {
            if (err instanceof AuthError)
                throw err;
            if (err instanceof RateLimitError)
                throw err;
            log.warn(`门店查询失败（${JSON.stringify(q)}）：${err.message}`);
        }
    }
    // 一条都没搜到 → 需要用户给城市，明确告知（不猜、不编门店）
    if (stores.length === 0) {
        if (!city) {
            /**
             * 没有任何城市信息 —— 这是最常见的首次使用场景。
             * 给一个专门的错误码，前端据此弹"允许定位"引导，
             * 而不是干巴巴一句"没搜到门店"。
             */
            throw new NeedLocationError('打开定位，我才能查到离你最近的门店');
        }
        throw new McpDownError(`没在「${city}」搜到可点餐门店，换个关键词试试`);
    }
    // 优先记忆里的常去门店
    let store = stores[0];
    if (snapshot?.usualStore) {
        const matched = stores.find((s) => s.name.includes(snapshot.usualStore) || snapshot.usualStore.includes(s.name));
        if (matched)
            store = matched;
    }
    return store;
}
/**
 * 上一轮是不是"反问"。
 *
 * 读 chats 表最近一条的 reply_json，看 clarifyOnly 标记。
 * 读不到就按 false 处理 —— 宁可多问一次，也不要因为查库失败把该问的吞了。
 */
function lastTurnWasClarify(userId, guest) {
    if (!userId || guest)
        return false;
    try {
        const row = getDb()
            .prepare(`SELECT reply_json FROM chats
         WHERE user_id = ? AND reply_json IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`)
            .get(userId);
        if (!row?.reply_json)
            return false;
        const reply = JSON.parse(row.reply_json);
        return reply.clarifyOnly === true;
    }
    catch {
        return false;
    }
}
/* ------------------------------------------------------------------ */
/* LLM 生成 hook / quote                                              */
/* ------------------------------------------------------------------ */
async function generateCopy(input) {
    const system = buildSystemPrompt({
        snapshot: input.snapshot,
        strategy: input.strategyCtx,
        safetyMode: input.intent.safetyMode,
    });
    const user = buildUserPrompt({
        message: input.intent.raw,
        intent: {
            ...(input.intent.explicit.people !== undefined ? { people: input.intent.explicit.people } : {}),
            ...(input.intent.explicit.budget !== undefined ? { budget: input.intent.explicit.budget } : {}),
            taboo: input.intent.explicit.taboo,
            taste: input.intent.explicit.taste,
            ...(input.intent.explicit.timeHint ? { timeHint: input.intent.explicit.timeHint } : {}),
        },
        reply: input.reply,
    });
    const text = await chat([
        { role: 'system', content: system },
        { role: 'user', content: user },
    ], { json: true, temperature: 0.9, maxTokens: 600 });
    return { text };
}
function parseCopy(text) {
    const t = (text ?? '').trim();
    if (!t)
        return null;
    const tryParse = (s) => {
        try {
            const o = JSON.parse(s);
            if (typeof o.hook === 'string' && typeof o.quote === 'string' && o.hook.trim()) {
                return { hook: o.hook.trim(), quote: o.quote.trim() };
            }
        }
        catch {
            /* ignore */
        }
        return null;
    };
    const direct = tryParse(t);
    if (direct)
        return direct;
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fence?.[1]) {
        const p = tryParse(fence[1]);
        if (p)
            return p;
    }
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
        const p = tryParse(t.slice(start, end + 1));
        if (p)
            return p;
    }
    return null;
}
/**
 * 让记忆里的"口味型忌口"给当轮明说的口味让位。
 *
 * 真实场景：记忆记着「忌辣」，这一轮用户说「我要吃辣的」。
 * 两边都当真会让系统自相矛盾 —— 选品按 taste=辣 挑出龙焰鸡腿堡，
 * 文案却写「辣的我得拦一下，你忌辣我记着」，一边给一边拦。
 *
 * **只有口味维度让位**（辣/甜/冰/热/咖啡/清淡…），过敏源永远不让。
 * 判断依据：用户当轮明确要的那个词，如果本身是个"口味标签"，
 * 就把它从记忆忌口里摘掉 —— 因为它此刻是用户的诉求，不是禁忌。
 * 花生、坚果、海鲜这类不在口味词表里，所以永远不会被摘掉。
 */
function dropOverriddenTaboo(memoryTaboo, currentTaste) {
    if (memoryTaboo.length === 0 || currentTaste.length === 0)
        return memoryTaboo;
    /**
     * 可让位的口味维度。
     * 注意这里刻意**不包含**过敏源类词汇 —— 哪怕用户说"我要吃花生"，
     * 记忆里的花生过敏也绝不能摘，安全永远优先于顺从。
     */
    const SOFT_TASTE_DIMS = ['辣', '甜', '冰', '热', '咖啡', '清淡', '减肥', '大份', '薯条', '可乐'];
    return memoryTaboo.filter((t) => {
        const hit = SOFT_TASTE_DIMS.find((d) => currentTaste.includes(d) && (t.includes(d) || d.includes(t)));
        return !hit;
    });
}
/**
 * 检测「用户手动删掉了什么」。
 *
 * 这是购物车结论里**信息量最大**的一条，也是最容易被忽略的一条。
 *
 * 场景：上一轮系统给了「麦辣鸡腿堡套餐 + 薯条 + 可乐」，用户手动把薯条删了。
 * 这一轮他说「来点辣的」—— 如果系统不看购物车，会重新配一份
 * 含薯条的菜单，整份替换购物车。用户的删除操作被无声抹掉，
 * ta 会觉得"我删的东西你怎么又给我加回来了"。
 *
 * 为什么不能只看购物车（要看上一轮的单）：购物车里只有"现在有什么"，
 * 没有"本来有什么"。少的那样是用户主动删的，还是上一轮本来就没有 ——
 * 必须和上一轮的菜单比才知道。所以读 chats 表最近一条的 reply_json。
 *
 * 保守策略：只在能明确对上名字时才认定为"用户删掉的"。
 * 对不上（比如商品改名、门店换了）就当没这回事，不猜。
 */
function detectUserRemovals(userId, guest, cart) {
    if (!userId || guest)
        return [];
    try {
        const row = getDb()
            .prepare(`SELECT reply_json FROM chats
         WHERE user_id = ? AND reply_json IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`)
            .get(userId);
        if (!row?.reply_json)
            return [];
        const prev = JSON.parse(row.reply_json);
        // 上一轮是反问（没有菜单）→ 无对比基准
        if (prev.clarifyOnly || !Array.isArray(prev.menu) || prev.menu.length === 0)
            return [];
        const prevNames = prev.menu
            .map((m) => (typeof m?.name === 'string' ? m.name.trim() : ''))
            .filter((n) => n !== '');
        if (prevNames.length === 0)
            return [];
        const cartNames = cart.map((c) => c.name);
        // 购物车为空 → 用户可能全删了，也可能这轮还没同步。不认定为删除。
        if (cartNames.length === 0)
            return [];
        return prevNames.filter((n) => !cartNames.some((c) => c.includes(n) || n.includes(c)));
    }
    catch (err) {
        log.warn(`检测购物车删除痕迹失败（已忽略）：${err.message}`);
        return [];
    }
}
/**
 * 读一眼购物车，转成判断环节能用的最小结构。
 *
 * **静默失败**：读不到就当空车。
 * 判断环节不该因为一次读车失败而拿不到购物车结论 —— 那就退化回"只看这一单"，
 * 也比直接崩掉强。
 *
 * 只取名字和数量：不给 productId，从根上避免模型"顺手"返回商品编码。
 * 价格**用真实合计**（getCart 现算），绝不在这里瞎估 ——
 * 判断环节要靠这个数字判断"合并后会不会爆预算"，估错了判断就废了。
 */
async function readCartQuietly(userId, guest, fulfillment) {
    if (!userId || guest)
        return { lines: [], total: 0 };
    try {
        const cart = await getCart(userId, fulfillment);
        return {
            lines: cart.items.map((it) => ({ name: it.name, qty: it.qty })),
            total: Math.round(cart.total * 100) / 100,
        };
    }
    catch (err) {
        log.warn(`读购物车失败（判断环节将只看本单）：${err.message}`);
        return { lines: [], total: 0 };
    }
}
/* ------------------------------------------------------------------ */
/* 反问文案（按当下面向，不用固定一句）                                */
/* ------------------------------------------------------------------ */
/**
 * 反问只在"真的什么信息都没有"时才发生，所以文案不要再用通用的
 * 「想吃带劲的还是舒服的」—— 那句话在早餐和深夜都不合适，
 * 而且被用户原样复读时会撞上解析器（历史上正是这么死循环的）。
 *
 * 按时段给不同选项，用户照着回答的任何一句都是解析层认得的词。
 */
function pickClarifyBySlot(slot) {
    if (slot === '早餐')
        return '早上想吃点热的垫一下，还是清淡好带走的？';
    if (slot === '午餐')
        return '想吃点辣的顶一顶，还是清爽点的？';
    if (slot === '下午茶')
        return '来点甜的配杯咖啡，还是咸的？';
    if (slot === '夜市')
        return '今晚想吃重口的解压，还是热乎清淡的？';
    return '这么晚了，想吃点热的暖一下，还是随便来点小食？';
}
/* ------------------------------------------------------------------ */
/* 辅助                                                              */
/* ------------------------------------------------------------------ */
function getProfileBirthday(userId, guest) {
    if (!userId || guest)
        return undefined;
    try {
        const row = getDb()
            .prepare('SELECT birthday FROM users WHERE user_id = ?')
            .get(userId);
        return row?.birthday ?? undefined;
    }
    catch {
        return undefined;
    }
}
function pickTitle(intent, ctx, snapshot) {
    if (intent.explicit.people && intent.explicit.people >= 3) {
        return `「${ctx.solarTerm.name}贴膘${intent.explicit.people}人餐」`;
    }
    if (intent.mood === '烦躁')
        return '你的「水逆急救单」';
    if (intent.mood === '疲惫')
        return '「今晚不用思考套餐」';
    if (intent.mood === '低落')
        return '「今天先吃热的」';
    if (intent.mood === '庆祝')
        return '「值得庆祝的一单」';
    if (ctx.birthdayMonth)
        return '「寿星专属」本命单';
    if (snapshot && snapshot.topItems.length > 0)
        return '「老规矩」本命单';
    return `「${ctx.solarTerm.name}推荐」`;
}
function persistChat(userId, message, reply, now, extra = {}) {
    const chatId = `c_${randomBytes(6).toString('hex')}`;
    try {
        const db = getDb();
        const menuHash = stableHash(reply.menu);
        /**
         * 履约方式、地址、门店编码、外送 beCode 全部落库。
         *
         * 为什么必须存：下单那一刻要按**同一套**编码重查价格并建单。
         * 只存门店名是不够的 —— 外送必须有 beCode + addressId，
         * 重新查一遍还可能查到的不是同一家店。
         */
        db.prepare(`INSERT INTO chats (id, user_id, messages, reply_json, menu_hash, created_at,
                          fulfillment, address_id, address_text, store_code, be_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(chatId, userId, JSON.stringify([{ role: 'user', content: message }]), JSON.stringify(reply), menuHash, now.getTime(), extra.fulfillment ?? null, extra.addressId ?? null, extra.addressText ?? null, extra.storeCode ?? null, extra.beCode ?? null);
    }
    catch (err) {
        log.warn(`对话留痕失败（已忽略）：${err.message}`);
    }
    return chatId;
}
/**
 * 执行一条购物车指令，并把结果渲染成一句人话。
 *
 * 三种返回：
 *   ChatReply  → 已经改完（或改不动但要说清楚），直接返回给用户
 *   null       → 这不是购物车指令，或者车里压根没有东西可改，走正常选品
 *
 * 注意「改不动」也要返回 ChatReply 而不是 null：
 * 用户说"把薯条删了"但车里没有薯条，如果走选品，
 * 他会收到一整份新菜单 —— 看起来像系统根本没听懂。
 * 老老实实回一句"车里没有薯条，现在有这些"才是对的。
 */
async function tryHandleCartAction(userId, action, fulfillment, addressId) {
    if (action.kind === 'none')
        return null;
    const ctx = {
        fulfillment,
        ...(addressId ? { addressId } : {}),
    };
    let cart;
    try {
        cart = await getCart(userId, fulfillment, { price: false });
    }
    catch (err) {
        log.warn(`读购物车失败：${err.message}`);
        return null;
    }
    /**
     * 空车 + 加购指令 → 交给选品。
     * 「来杯可乐」在空车语境下更像"给我配一单"，不该只加一杯可乐就结束。
     */
    if (cart.items.length === 0) {
        if (action.kind === 'add' || action.kind === 'swap')
            return null;
        // 空车却要删/改 → 说清楚
        return renderClarify('你还没点东西呢，先说说想吃什么？');
    }
    const nameList = cart.items.map((it) => it.name).join('、');
    /* ---- 清空 ---- */
    if (action.kind === 'clear') {
        await clearCart(userId, fulfillment);
        return cartReply('好，购物车清空了。', '想重新配一单就说「两个人 100 块不辣」这种，我直接给你搭。');
    }
    /* ---- 删 ---- */
    if (action.kind === 'remove') {
        const hit = findItemByName(cart.items, action.query);
        if (!hit) {
            return cartReply(`车里没有「${action.query}」。`, `现在有：${nameList}。要删哪个直接说名字就行。`, cart);
        }
        await removeItem(userId, hit.id, ctx);
        const after = await getCart(userId, fulfillment);
        return cartReply(`删掉了「${hit.name}」。`, summarizeCart(after), after);
    }
    /* ---- 改数量 ---- */
    if (action.kind === 'setQty') {
        const hit = findItemByName(cart.items, action.query);
        if (!hit) {
            return cartReply(`车里没有「${action.query}」。`, `现在有：${nameList}。`, cart);
        }
        await updateItem(userId, hit.id, { qty: action.qty }, ctx);
        const after = await getCart(userId, fulfillment);
        return cartReply(`「${hit.name}」改成 ${action.qty} 份了。`, summarizeCart(after), after);
    }
    /* ---- 换成 ---- */
    if (action.kind === 'swap') {
        const from = findItemByName(cart.items, action.from);
        if (!from) {
            return cartReply(`车里没有「${action.from}」。`, `现在有：${nameList}。`, cart);
        }
        const found = await pickProduct(userId, action.to, fulfillment, {
            ...(addressId ? { addressId } : {}),
            ...(cart.storeCode ? { storeCode: cart.storeCode } : {}),
            ...(cart.beCode ? { beCode: cart.beCode } : {}),
        });
        if (!found) {
            return cartReply(`菜单里搜不到「${action.to}」。`, '换个说法试试，比如「换成麦辣鸡翅」。', cart);
        }
        // 先删后加：顺序反了会短暂多出一件，若加购失败还能保住原来那份
        const qty = from.qty;
        await removeItem(userId, from.id, ctx);
        await addItem(userId, found, {
            qty,
            ...(from.spec ? { spec: from.spec } : {}),
            ...ctx,
            ...(cart.storeCode ? { storeCode: cart.storeCode } : {}),
            ...(cart.beCode ? { beCode: cart.beCode } : {}),
        });
        const after = await getCart(userId, fulfillment);
        return cartReply(`「${from.name}」换成「${found.name}」了。`, summarizeCart(after), after);
    }
    /* ---- 加 ---- */
    const picked = await pickProduct(userId, action.query, fulfillment, {
        ...(addressId ? { addressId } : {}),
        ...(cart.storeCode ? { storeCode: cart.storeCode } : {}),
        ...(cart.beCode ? { beCode: cart.beCode } : {}),
    });
    if (!picked) {
        return cartReply(`菜单里没找到「${action.query}」。`, '换个说法试试，比如「加个苹果片」「加杯可乐」。', cart);
    }
    await addItem(userId, picked, {
        qty: action.qty,
        ...ctx,
        ...(cart.storeCode ? { storeCode: cart.storeCode } : {}),
        ...(cart.beCode ? { beCode: cart.beCode } : {}),
    });
    const after = await getCart(userId, fulfillment);
    return cartReply(`加了 ${action.qty} 份「${picked.name}」。`, summarizeCart(after), after);
}
/**
 * 在「当前门店菜单」里找一个商品。
 *
 * 两道查法，顺序不能反：
 *   1. 按商品编码精确查 —— 内部/搜索结果回传时走这条，最准；
 *   2. 退回按名字模糊搜 —— 用户说的是「麦乐鸡」「可乐」，永远不是编码。
 *
 * ⚠️ 第 2 步不能省。「换成 X」早期只做了第 1 步，于是：
 *   用户说「把汉堡换成麦乐鸡」，菜单里明明有「麦乐鸡」，
 *   却回「菜单里搜不到」—— 因为它拿「麦乐鸡」去比 productId。
 * 加购分支一直有这两步，换货分支漏了，两条路行为不一致。
 */
async function pickProduct(userId, query, fulfillment, opts) {
    const resolved = await resolveProduct(userId, query, fulfillment, {
        ...(opts.addressId ? { addressId: opts.addressId } : {}),
        ...(opts.storeCode ? { storeCode: opts.storeCode } : {}),
        ...(opts.beCode ? { beCode: opts.beCode } : {}),
    });
    if (resolved)
        return resolved.product;
    const byName = await searchProducts(userId, query, fulfillment, {
        ...(opts.addressId ? { addressId: opts.addressId } : {}),
        ...(opts.storeCode ? { storeCode: opts.storeCode } : {}),
    });
    return byName[0] ?? null;
}
/** 一句话概括购物车现状 */
function summarizeCart(cart) {
    if (cart.items.length === 0)
        return '购物车现在是空的。';
    const parts = cart.items.map((it) => `${it.name}×${it.qty}`).join('、');
    return `现在车里是：${parts}，合计 ¥${cart.total.toFixed(1)}。`;
}
/**
 * 改车后的回复：**不带菜单**。
 *
 * 菜单已经在右边购物车里了，回复里再列一遍就是重复；
 * 而且这一轮的回复卡如果带 menu，前端会以为"这是新的一单"。
 */
function cartReply(hook, detail, cart) {
    const total = cart ? Math.round(cart.total * 100) / 100 : 0;
    return {
        hook,
        meta: { store: cart?.store ?? '', slot: cart?.fulfillment ?? '', title: '购物车' },
        menu: [],
        total,
        quote: detail,
        actions: cart && cart.items.length > 0 ? ['confirm'] : [],
        dataSource: 'mcp',
    };
}
/** 从 "×2 · 去冰" 里取数量（与 order.service.parseQty 保持一致） */
function parseMenuQty(spec) {
    const m = (spec ?? '').match(/×\s*(\d+)/);
    if (m?.[1]) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > 0 && n <= 50)
            return n;
    }
    return 1;
}
function isoDate(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function withStageTimeout(p, ms) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new McpDownError('查菜单超时了')), ms);
        p.then((v) => {
            clearTimeout(t);
            resolve(v);
        }, (e) => {
            clearTimeout(t);
            reject(e);
        });
    });
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw new McpDownError('客户端已断开');
}
export const __orchestratorInternal = {
    parseCopy,
    pickTitle,
    /** 仅供诊断脚本取真实商品池，验证"复核→重配"链路 */
    fetchFromMcp,
};
//# sourceMappingURL=orchestrator.js.map