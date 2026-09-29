// Notion HTTP 客户端：网络层抗抖动（指数退避），HTTP 层不重试（4xx/5xx 让 Notion 自己说）
//
// 为什么要重试：国内到 api.notion.com 链路有 ~25% 丢包，pi 进程内 keep-alive 连接被 RST 后
// fetch 直接抛 `TypeError: fetch failed`（无 code、无 HTTP 阶段）。
//
// 策略：
//   (a) 无 body 时 Connection: close —— 每次新建连接，不用可能已死的 keep-alive socket
//   (b) AbortController 5s 超时 —— 单次请求上限
//   (c) 指数退避 3 次 [500, 1500, 4500]ms —— 仅重试网络层错误，不重试 HTTP 4xx/5xx
//   (d) 网络层错误白名单（见 NETWORK_ERR_PATTERNS）
import { loadConfig } from "./config.ts";
import type { PitionConfig } from "./types.ts";

const NOTION_BASE = "https://api.notion.com";
const NOTION_VERSION = "2022-06-28";

const NETWORK_ERR_PATTERNS = [
  "fetch failed", // Node 18+ undici 网络层
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ECONNREFUSED",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
];

/** 退避序列：首次 + 2 次重试，共 3 次尝试 */
const RETRY_DELAYS_MS = [500, 1500, 4500];

/** 判断错误是否属于「可重试的网络层错误」 */
export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true; // 超时也按网络错误处理
  return NETWORK_ERR_PATTERNS.some((p) => err.message.includes(p));
}

/** 带重试的 fetch；仅重试网络层错误，HTTP 层错误原样返回给调用方判断 */
export async function fetchNotion(
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  baseUrl = NOTION_BASE,
): Promise<Response> {
  const url = baseUrl + path;
  const payload = body ? JSON.stringify(body) : undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    try {
      return await fetch(url, {
        method,
        headers: body ? headers : { ...headers, Connection: "close" },
        body: payload,
        signal: ac.signal,
      });
    } catch (e) {
      lastErr = e;
      if (!isNetworkError(e)) throw e;
      if (attempt === RETRY_DELAYS_MS.length) break;
      const wait = RETRY_DELAYS_MS[attempt];
      console.warn(
        `[pition] ${method} ${path} 网络层失败 (第 ${attempt + 1} 次)：${(e as Error).message}；${wait}ms 后重试`,
      );
      await new Promise((r) => setTimeout(r, wait));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function notionHeaders(token: string, hasBody: boolean): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
  return hasBody ? h : { ...h, Connection: "close" };
}

async function parseOrThrow(res: Response, method: string, path: string): Promise<any> {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json as { code?: string; message?: string };
    throw new Error(`Notion ${method} ${path} → ${res.status} ${err.code || ""}: ${err.message || "未知错误"}`);
  }
  return json;
}

/** 用给定 token 调 Notion（与 notion() 分开：配置向导要用「尚未保存的 token」试连） */
export async function notionWith(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetchNotion(method, path, body, notionHeaders(token, !!body));
  return parseOrThrow(res, method, path);
}

/**
 * 用配置里的 token 调 Notion。
 *
 * 第一个参数传 **null** 表示「现读配置拿 token」——保证切库/换 token 后立刻生效，
 * 而不是用工厂启动时闭包捕获的旧 cfg（踩过「切库后仍查旧库」的 bug）。
 */
export async function notion(cfg: PitionConfig | null, method: string, path: string, body?: unknown): Promise<any> {
  const real = cfg ?? loadConfig();
  if (!real?.token) throw new Error("pition 未配置（没有 pition.config.json）");
  const res = await fetchNotion(method, path, body, notionHeaders(real.token, !!body));
  return parseOrThrow(res, method, path);
}
