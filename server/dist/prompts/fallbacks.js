/** 按情绪 × 场景挑一条 */
export function pickFallback(input) {
    const { mood, strategy, isReturningUser, budgetOk, safetyMode, store } = input;
    if (safetyMode) {
        return {
            hook: '今天不用勉强自己。我给你挑了热乎的，不用你决定什么。',
            quote: '不用谢我，吃饭这件事，能有人陪着一起想就够了。',
        };
    }
    if (input.clarifyOnly) {
        return {
            hook: '我还不太确定你想吃什么。**想被安慰**，还是**想发泄一下**？',
            quote: '你说一句，我就知道你该吃什么。',
        };
    }
    if (isReturningUser) {
        return {
            hook: `哟，**${strategy.starSign?.name ?? '老朋友'}**。上次那份我还记着，今天要不要换个口味？`,
            quote: '用得越久我越懂你——这话别的助手说不出，因为它们没记性。',
        };
    }
    switch (mood) {
        case '烦躁':
            return {
                hook: `**${strategy.solarTerm.name}**，${strategy.solarTerm.imagery}。` +
                    (strategy.retrograde?.active
                        ? `**水逆第 ${strategy.retrograde.dayIndex} 天**，这天的锅不该你背。`
                        : '天一冷人就容易烦，这不是你的问题。') +
                    '先吃点带劲的。',
                quote: '宇宙没善待你，但优惠券有。吃完这顿，明天再说。',
            };
        case '疲惫':
            return {
                hook: `累成这样还知道要吃饭，已经很有出息了。我挑了**不用你选**的那种，${strategy.timeSlot}正好。`,
                quote: '今天不用做得更好，吃完就算通关。',
            };
        case '低落':
            return {
                hook: '今天不用勉强自己开心。我挑了热乎的，不用你决定什么。',
                quote: '不用谢我，吃饭这件事，能有人陪着一起想就够了。',
            };
        case '开心':
            return {
                hook: `**${strategy.solarTerm.name}**，好日子配大份。今天值得多点一样。`,
                quote: '开心的时候要吃得比平时多一点，这是常识。',
            };
        case '庆祝':
            return {
                hook: `这种事必须吃甜的啊。**${strategy.solarTerm.name}**这天，正好给你加个仪式感。`,
                quote: '值得庆祝的事不多，今天算一件。',
            };
        default:
            break;
    }
    if (strategy.birthdayMonth && strategy.starSign) {
        return {
            hook: `**${strategy.starSign.name}**的生日月，本来就该吃点好的。${strategy.solarTerm.blurb}`,
            quote: '生日月不打折，但待遇可以加。',
        };
    }
    if (budgetOk === false) {
        return {
            hook: `**${strategy.solarTerm.name}**这天，预算得看着点花。我把该有的都留着了。`,
            quote: '省下来的钱，下次还能再吃一顿。',
        };
    }
    return {
        hook: `**${strategy.solarTerm.name}**，${strategy.solarTerm.imagery}。${strategy.solarTerm.blurb}给你配好了${store ? `，${store}现在能取` : ''}。`,
        quote: '今天这顿，算我请你想的。',
    };
}
/** 离线兜底（MCP 挂了）时在 hook 前加一句 */
export const OFFLINE_NOTE = '麦当劳那边有点忙，先给你看个参考版本，价格以门店为准。';
/** 反问兜底池 */
export const CLARIFY_POOL = [
    '听起来你现在有点说不上来的状态——是想吃点带劲的发泄一下，还是想吃点舒服的被安慰一下？',
    '今天是想给自己加个油，还是想被安慰一下？',
    '要不要先告诉我：是饿得慌，还是烦得慌？这两个我给的答案不一样。',
];
//# sourceMappingURL=fallbacks.js.map