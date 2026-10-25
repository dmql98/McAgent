/**
 * MCP Token 有效性验证（M1 用一次性连接）
 *
 * M3 会把完整网关做出来，届时 gateway 复用此处的连接工厂。
 * 这里的职责很单一：给一个 token，判断它能不能用。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { AuthError, McpDownError, looksLikeAuthError } from '../lib/errors.js';

const log = createLogger('mcp-verify');

export interface VerifyResult {
  ok: boolean;
  /** now-time-info 的原始返回，便于调试 */
  raw?: unknown;
}

export function buildTransport(token: string, timeoutMs = 10_000) {
  const cfg = loadConfig();
  return new StreamableHTTPClientTransport(new URL(cfg.mcpEndpoint), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
}

export function buildClient(name = 'mcd-soulmate') {
  return new Client({ name, version: '1.0.0' }, { capabilities: {} });
}

/** 带超时的工具调用 */
export async function callOnce<T = unknown>(
  token: string,
  toolName: string,
  args: Record<string, unknown> = {},
  timeoutMs = 10_000,
): Promise<T> {
  const client = buildClient('mcd-soulmate-verify');
  const transport = buildTransport(token, timeoutMs);

  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new McpDownError('连麦当劳超时了，稍后再试')), timeoutMs),
  );

  const work = (async () => {
    await client.connect(transport);
    const res = await client.callTool({ name: toolName, arguments: args });
    return res as unknown as T;
  })();

  try {
    return (await Promise.race([work, timer])) as T;
  } finally {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 验证 token 是否有效。
 *
 * - MCP_VERIFY_SKIP=1 时跳过真实校验（仅开发期应急，日志会明确警告）
 * - 401/403 → AuthError
 * - 其它失败 → McpDownError（可重试）
 */
export async function verifyToken(token: string): Promise<VerifyResult> {
  const cfg = loadConfig();

  if (cfg.mcpVerifySkip) {
    log.warn('⚠️ MCP_VERIFY_SKIP=1，跳过真实 Token 校验（仅限开发期，生产必须关闭）');
    return { ok: true };
  }

  try {
    const raw = await callOnce(token, 'now-time-info', {}, 10_000);
    return { ok: true, raw };
  } catch (err) {
    const e = err as { status?: number; message?: string; code?: string };
    const msg = e?.message ?? String(err);

    // 麦当劳 MCP 的鉴权文案是中文的（「当前鉴权码不存在或已失效!」），
    // 只匹配英文会漏判，导致用户看到"服务出错"而不是"Token 失效"。
    if (e?.status === 401 || e?.status === 403 || looksLikeAuthError(msg)) {
      throw new AuthError('这个 Token 失效了，去 open.mcd.cn 重新生成一个');
    }
    if (/timeout|timed out|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(msg)) {
      throw new McpDownError('连不上麦当劳服务，稍后再试');
    }

    log.warn(`Token 验证失败：${msg}`);
    throw new McpDownError('验证 Token 时出错，稍后再试');
  }
}
