/**
 * 日志 + 脱敏
 * 所有日志必须走这里。token / 密钥在输出前统一打码。
 */

type Replace = string | ((substring: string, ...args: string[]) => string);

const SENSITIVE_PATTERNS: Array<[RegExp, Replace]> = [
  // Bearer xxx
  [/Bearer\s+[A-Za-z0-9\-._~+/]{12,}=*/gi, 'Bearer ****'],
  // "token": "xxx" / "token":"xxx"
  [/("(?:token|token_enc|password|secret|api[_-]?key|authorization)"\s*:\s*")([^"]{8,})(")/gi, '$1****$3'],
  // 长 hex / base64 串（>=40 连续字符）
  [/\b[A-Za-z0-9+/_\-]{40,}={0,2}\b/g, (m: string) => mask(m)],
  // sk- 开头
  [/\bsk-[A-Za-z0-9\-_]{16,}/g, (m: string) => mask(m)],
  // 查询串里的 token
  [/([?&](?:token|access_token|key)=)([^&\s]{8,})/gi, '$1****'],
];

/** 保留前 4 后 4，中间打码。太短的整体打码。 */
export function mask(raw: string): string {
  if (!raw) return '';
  if (raw.length <= 12) return '****';
  return `${raw.slice(0, 4)}****${raw.slice(-4)}`;
}

export function sanitize(input: unknown): string {
  let text: string;
  if (typeof input === 'string') text = input;
  else if (input instanceof Error) text = `${input.name}: ${input.message}\n${input.stack ?? ''}`;
  else {
    try {
      text = JSON.stringify(input);
    } catch {
      text = String(input);
    }
  }
  if (typeof text !== 'string') text = String(text);

  for (const [re, rep] of SENSITIVE_PATTERNS) {
    if (typeof rep === 'string') text = text.replace(re, rep);
    else text = text.replace(re, rep);
  }
  return text;
}

/** 判断是否在脱敏后仍可能残留敏感信息（仅调试用） */
export function looksClean(text: string): boolean {
  return sanitize(text) === text;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): Level {
  const env = (process.env.LOG_LEVEL ?? '').toLowerCase();
  if (env === 'debug' || env === 'info' || env === 'warn' || env === 'error') return env;
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

function ts(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;
  const line = `${ts()} ${level.toUpperCase().padEnd(5)} [${scope}] ${sanitize(msg)}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra !== undefined) {
    out(line, sanitize(extra));
  } else {
    out(line);
  }
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
  };
}

export const logger = createLogger('app');
