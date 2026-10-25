/**
 * SQLite 连接单例 + 建表迁移
 *
 * 使用 Node 22.5+ 内置的 node:sqlite（DatabaseSync），
 * 零原生依赖、免编译 —— 这正是"个人服务器自部署"想要的。
 *
 * 对外暴露一层薄封装，API 形状与 better-sqlite3 接近，便于后续替换。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { createLogger } from '../lib/logger.js';
const log = createLogger('db');
let db = null;
function resolveSchemaPath() {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(here, 'schema.sql'),
        join(here, '../../src/db/schema.sql'),
        resolve(process.cwd(), 'src/db/schema.sql'),
    ];
    for (const p of candidates)
        if (existsSync(p))
            return p;
    throw new Error(`找不到 schema.sql，已尝试：\n${candidates.join('\n')}`);
}
function wrap(raw) {
    return {
        raw,
        exec: (sql) => raw.exec(sql),
        prepare: (sql) => {
            const stmt = raw.prepare(sql);
            return {
                run: (...params) => {
                    const r = stmt.run(...params);
                    return {
                        changes: Number(r.changes ?? 0),
                        lastInsertRowid: Number(r.lastInsertRowid ?? 0),
                    };
                },
                get: (...params) => stmt.get(...params),
                all: (...params) => stmt.all(...params),
            };
        },
        close: () => raw.close(),
    };
}
export function getDb() {
    if (db)
        return db;
    const cfg = loadConfig();
    const file = join(cfg.dataDir, 'mcd.db');
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec('PRAGMA busy_timeout = 5000');
    raw.exec('PRAGMA synchronous = NORMAL');
    raw.exec(readFileSync(resolveSchemaPath(), 'utf8'));
    db = wrap(raw);
    migrate(db);
    let size = 0;
    try {
        size = statSync(file).size;
    }
    catch {
        /* ignore */
    }
    log.info(`数据库就绪：${file}（${(size / 1024).toFixed(1)} KB, WAL）`);
    return db;
}
/** 内存库（测试用） */
export function createMemoryDb() {
    const raw = new DatabaseSync(':memory:');
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec(readFileSync(resolveSchemaPath(), 'utf8'));
    const d = wrap(raw);
    migrate(d);
    return d;
}
/** 轻量迁移：补列（幂等） */
function migrate(d) {
    const cols = (table) => {
        const rows = d.prepare(`PRAGMA table_info(${table})`).all();
        return rows.map((r) => r.name);
    };
    const ensure = (table, name, type) => {
        if (!cols(table).includes(name)) {
            d.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
            log.warn(`迁移：${table} 补列 ${name}`);
        }
    };
    ensure('users', 'token_fp', 'TEXT');
    ensure('users', 'auto_confirm', 'INTEGER NOT NULL DEFAULT 0');
    ensure('chats', 'reply_json', 'TEXT');
    ensure('chats', 'menu_hash', 'TEXT');
    /**
     * 履约方式与配送地址。
     *
     * 必须在 chats 上留痕：下单时要用**和选品时完全一样**的履约方式，
     * 否则会出现"按外送菜单选的品，却按到店去下单"——商品编码对不上，必然失败。
     */
    ensure('chats', 'fulfillment', 'TEXT');
    ensure('chats', 'address_id', 'TEXT');
    ensure('chats', 'address_text', 'TEXT');
    ensure('chats', 'store_code', 'TEXT');
    ensure('chats', 'be_code', 'TEXT');
    /** 订单侧同样留痕，便于订单详情/售后知道这单是自取还是外送、送到哪 */
    ensure('orders', 'fulfillment', 'TEXT');
    ensure('orders', 'address_id', 'TEXT');
    ensure('orders', 'address_text', 'TEXT');
}
export function closeDb() {
    if (db) {
        try {
            db.close();
        }
        catch {
            /* ignore */
        }
        db = null;
    }
}
export function resetDbForTest() {
    closeDb();
}
//# sourceMappingURL=index.js.map