-- 「麦门知己」SQLite 建表 DDL
-- WAL 模式，所有时间戳为毫秒整数

-- 用户与凭证（token 永不明文）
CREATE TABLE IF NOT EXISTS users (
  user_id       TEXT PRIMARY KEY,          -- sha256(token)[0:16]
  token_enc     TEXT NOT NULL,             -- AES-256-GCM(原始 token)
  token_fp      TEXT,                      -- sha256(token)[0:8]，检测换 token
  nickname      TEXT,
  birthday      TEXT,                      -- ISO 日期；星座由此推算
  star_sign     TEXT,
  taboo         TEXT,                      -- JSON 数组：忌口/过敏
  auto_confirm  INTEGER NOT NULL DEFAULT 0,-- 免确认一键下单，默认关闭
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 用户记忆（结构化大 JSON + 乐观锁版本号）
CREATE TABLE IF NOT EXISTS memories (
  user_id    TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  data       TEXT NOT NULL,                -- JSON: {schemaVersion,version,profile,taste,habits,moodDiary,rituals}
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- 情绪日记（护城河，独立成表便于回溯统计）
CREATE TABLE IF NOT EXISTS mood_diary (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  mood         TEXT NOT NULL,              -- 烦躁/疲惫/低落/开心/平淡/庆祝
  trigger_text TEXT,                       -- 用户原话（脱敏截断 200 字）
  recommended  TEXT,                       -- 推荐了什么（JSON 摘要）
  feedback     TEXT,                       -- 用户反馈，如"治愈"
  created_at   INTEGER NOT NULL
);

-- 订单留痕（对账 + 记忆回钩素材）
CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,            -- MCP 返回的 orderId
  user_id     TEXT NOT NULL,
  chat_id     TEXT,
  menu_json   TEXT NOT NULL,
  menu_hash   TEXT,                        -- 菜单快照 hash，confirm 时校验
  total       REAL NOT NULL,
  status      TEXT NOT NULL,               -- created/paid/progress/done/canceled
  pay_url     TEXT,
  store       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 对话留痕（供 confirm 取快照；轮询清理 30 天前）
CREATE TABLE IF NOT EXISTS chats (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,                         -- 访客为 NULL
  messages   TEXT NOT NULL,                -- JSON 数组
  reply_json TEXT,                         -- 最后一次 ChatReply 快照
  menu_hash  TEXT,
  created_at INTEGER NOT NULL
);

-- 访客用量（每 IP 每日 1 次）
CREATE TABLE IF NOT EXISTS guest_usage (
  ip       TEXT NOT NULL,
  day      TEXT NOT NULL,                  -- YYYY-MM-DD
  used     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, day)
);

-- 购物车（每个用户 × 每种履约方式一份「当前在配的那单」）
--
-- 为什么不用「一行一个 SKU」而是把整份购物车存成 JSON 一列：
--   购物车的读写永远整体进行（看全部、改一件、清空），不会有人只查某一行；
--   存 JSON 一次读写就够，也天然保序（用户看着列表顺序改，顺序不能乱跳）。
--
-- 为什么按 fulfillment 分开：
--   到店和外送是**两套商品编码**（实测同一门店 75/88 个 code 不通用），
--   同一个购物车混着放，切方式下单必然失败。分开放才不至于串。
CREATE TABLE IF NOT EXISTS carts (
  user_id      TEXT NOT NULL,
  fulfillment  TEXT NOT NULL,              -- 自取 / 外送 / 堂食
  items_json   TEXT NOT NULL,              -- JSON 数组：CartItem[]
  store        TEXT,                       -- 门店名（下单要用）
  store_code   TEXT,
  be_code      TEXT,
  address_id   TEXT,                       -- 外送：配送地址
  address_text TEXT,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, fulfillment)
);

CREATE INDEX IF NOT EXISTS idx_mood_diary_user_time ON mood_diary(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_user          ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_chat          ON orders(chat_id);
CREATE INDEX IF NOT EXISTS idx_chats_user           ON chats(user_id);
CREATE INDEX IF NOT EXISTS idx_chats_created        ON chats(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_token_fp       ON users(token_fp);
