// 开发脚本共享的 Notion HTTP 客户端：与扩展 extensions/pition.ts 里的 fetchNotion() 同款抗抖动策略。
//
// 为什么需要：国内到 api.notion.com 链路有 ~25% 丢包，pi/Node 进程内 keep-alive 连接被 RST 后
// fetch 直接抛 `TypeError: fetch failed`（无 code、无 HTTP 阶段）。开发脚本若不做重试会随机失败。
//
// 策略（与扩展保持一致，避免两处行为漂移）：
//   (a) Connection: close —— 每次新建连接，不用死掉的 keep-alive socket
//   (b) AbortController.timeout(5s) —— 单次请求超时上限
//   (c) 指数退避 3 次 [500, 1500, 4500]ms，仅重试网络层错误，不重试 HTTP 4xx/5xx
//   (d) 网络层错误白名单
const NOTION_BASE = "https://api.notion.com";
const NOTION_VERSION = "2022-06-28";

const NETWORK_ERR_PATTERNS = [
  "fetch failed",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ECONNREFUSED",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
];
const RETRY_DELAYS_MS = [500, 1500, 4500];

function isNetworkError(err) {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  return NETWORK_ERR_PATTERNS.some((p) => err.message.includes(p));
}

/** 带重试的 fetch。失败时抛最后一次错误。 */
export async function resilientFetch(url, init, { timeoutMs = 5000, label = "" } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ac.signal });
    } catch (e) {
      lastErr = e;
      if (!isNetworkError(e)) throw e;
      if (attempt === RETRY_DELAYS_MS.length) break;
      const wait = RETRY_DELAYS_MS[attempt];
      console.warn(`[dev] ${label || url} 网络层失败 (第 ${attempt + 1} 次)：${e.message}；${wait}ms 后重试`);
      await new Promise((r) => setTimeout(r, wait));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/**
 * 创建一个绑定 token 的 Notion API 客户端。
 * 用法：const api = createNotionClient(token); await api("GET", "/v1/users/me");
 */
export function createNotionClient(token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
  return async function api(method, path, body) {
    const res = await resilientFetch(
      NOTION_BASE + path,
      {
        method,
        // 无 body 时显式 close，避免复用可能已死的 keep-alive socket
        headers: body ? headers : { ...headers, Connection: "close" },
        body: body ? JSON.stringify(body) : undefined,
      },
      { label: `${method} ${path}` },
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Notion ${method} ${path} → ${res.status} ${json.code || ""}: ${json.message || "未知错误"}`);
    }
    return json;
  };
}
