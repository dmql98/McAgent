/**
 * 环境变量加载与启动时校验
 * 缺关键项直接退出并打印缺失项，绝不带病启动。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function need(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    fail(`${name} 未设置`);
  }
  return v!.trim();
}

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

/* ---------- 加载 .env（不引 dotenv，手写解析，避免多一个依赖） ---------- */
function loadDotEnv(): void {
  const path = resolve(process.cwd(), '.env');
  if (!existsSync(path)) return;
  const raw = readFileSafe(path);
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function readFileSafe(p: string): string {
  return readFileSync(p, 'utf8');
}

const errors: string[] = [];
function fail(msg: string): never {
  errors.push(msg);
  throw new Error('CONFIG_ERROR');
}

export interface AppConfig {
  port: number;
  nodeEnv: 'development' | 'production' | 'test';
  jwtSecret: string;
  tokenEncKey: Buffer;
  dataDir: string;
  mcpEndpoint: string;
  mcpVerifySkip: boolean;
  debugMcp: boolean;
  guestDailyLimit: number;
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
  };
  cookieName: string;
  jwtTtlSeconds: number;
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;

  loadDotEnv();
  errors.length = 0;

  const isTest = process.env.NODE_ENV === 'test';

  const jwtSecret = (() => {
    const v = process.env.JWT_SECRET?.trim();
    if (!v) {
      if (isTest) return 'test-secret-key-at-least-32-characters-long!!';
      return fail('JWT_SECRET 未设置（生成方式：openssl rand -hex 32）') as never;
    }
    if (v.length < 32) {
      return fail(`JWT_SECRET 太短（${v.length} 字符），至少 32 字符。生成方式：openssl rand -hex 32`) as never;
    }
    return v;
  })();

  const tokenEncKey = (() => {
    const v = process.env.TOKEN_ENC_KEY?.trim();
    if (!v) {
      if (isTest) return Buffer.alloc(32, 7);
      return fail('TOKEN_ENC_KEY 未设置（必须是 64 位 hex，生成方式：openssl rand -hex 32）') as never;
    }
    if (!/^[0-9a-fA-F]{64}$/.test(v)) {
      return fail(
        `TOKEN_ENC_KEY 格式错误：需要 64 位 hex（32 字节），当前长度 ${v.length}。生成方式：openssl rand -hex 32`,
      ) as never;
    }
    return Buffer.from(v, 'hex');
  })();

  const dataDir = resolve(process.cwd(), opt('DATA_DIR', './data'));
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (e) {
    fail(`DATA_DIR 无法创建或不可写：${dataDir}（${(e as Error).message}）`);
  }

  const port = Number(opt('PORT', '3000'));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fail(`PORT 非法：${process.env.PORT}`);
  }

  if (errors.length > 0) {
    console.error('\n❌ 配置校验失败，服务不会启动：\n');
    for (const e of errors) console.error('   • ' + e);
    console.error('');
    process.exit(1);
  }

  cached = {
    port,
    nodeEnv: (opt('NODE_ENV', 'development') as AppConfig['nodeEnv']) ?? 'development',
    jwtSecret,
    tokenEncKey,
    dataDir,
    mcpEndpoint: opt('MCP_ENDPOINT', 'https://mcp.mcd.cn'),
    mcpVerifySkip: opt('MCP_VERIFY_SKIP', '0') === '1',
    debugMcp: opt('DEBUG_MCP', '0') === '1',
    guestDailyLimit: Number(opt('GUEST_DAILY_LIMIT', '1')),
    llm: {
      baseUrl: opt('LLM_BASE_URL', 'https://api.deepseek.com/v1'),
      apiKey: opt('LLM_API_KEY', ''),
      model: opt('LLM_MODEL', 'deepseek-chat'),
      timeoutMs: Number(opt('LLM_TIMEOUT_MS', '20000')),
    },
    cookieName: 'mcd_sid',
    jwtTtlSeconds: 7 * 24 * 3600,
  };

  return cached;
}

/** 测试用：重置缓存 */
export function resetConfigCache(): void {
  cached = null;
}
