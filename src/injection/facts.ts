// tool 结果回流 —— 让「上一轮发生了什么」成为下一轮提示词的输入。
//
// 为什么需要：模型容易忽略 tool 返回结果里的 WARNING（它只看自己想看的部分），
// 典型症状是「上一轮 write 报『没有 page』，这一轮原样再 write 一次」。
// 把结果抽成一条事实塞进**易变层**，模型下一轮就带着它决策。
//
// 纪律：
//   1. 只采集自家前缀的 tool（别人的 tool 不该进你的上下文）
//   2. 摘要必须截断（易变层每轮都进上下文，宁可少说）
//   3. 「成功计数」要能配置——不是每个扩展的「写入」都叫 write

/** 最近一次自家 tool 的结果 */
export interface ToolOutcome {
  /** tool 名（如 pition_write） */
  tool: string;
  /** 是否失败（抛错 / isError） */
  failed: boolean;
  /** 成功时的关键返回片段，已截断 */
  summary?: string;
  /** 工具自己回的 warning（结构化 details.warning 或文案里的 WARNING），已截断 */
  warning?: string;
  /** 采集时刻 HH:MM */
  at: string;
}

/** 一次会话内累计的事实（session_start 清零） */
export interface SessionFacts {
  /** 成功写入的次数（由 `applyOutcome` 的 countTool 判定是否计数） */
  writes: number;
  last?: ToolOutcome;
}

export function emptySessionFacts(): SessionFacts {
  return { writes: 0 };
}

/** 摘要截断上限 */
export const OUTCOME_SUMMARY_MAX = 120;

/** 从事件里取出给模型看的文本（形状容错：字符串 / {content:[{type,text}]}） */
export function outcomeText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) =>
      c && typeof c === "object" && (c as { type?: string }).type === "text" ? (c as { text?: string }).text : "",
    )
    .filter((t): t is string => typeof t === "string")
    .join(" ");
}

/** 从 pi 的 `tool_execution_end` 里抽一条自家结果；不是自家 tool 返回 null */
export function outcomeFromEvent(opts: {
  event: { toolName?: unknown; result?: unknown; isError?: unknown };
  /** tool 名前缀（如 `pition_`） */
  prefix: string;
  now?: Date;
  summaryMax?: number;
}): ToolOutcome | null {
  const { event, prefix, now = new Date(), summaryMax = OUTCOME_SUMMARY_MAX } = opts;
  const tool = typeof event.toolName === "string" ? event.toolName : "";
  if (!tool?.startsWith(prefix)) return null;

  const text = outcomeText(event.result).replace(/\s+/g, " ").trim();
  const details = ((event.result as { details?: unknown } | undefined)?.details ?? {}) as Record<string, unknown>;
  const structuredWarning = typeof details.warning === "string" ? details.warning : undefined;
  // 兼容未带 details 的实现：文案里出现 WARNING/警告 也算
  const textualWarning = /(?:^|\b)WARNING[:：]|警告[:：]/.test(text) ? text.slice(0, summaryMax) : undefined;

  return {
    tool,
    failed: event.isError === true,
    summary: text.slice(0, summaryMax) || undefined,
    warning: structuredWarning ?? textualWarning,
    at: hhmmOf(now),
  };
}

/**
 * 把一条结果并入会话事实。
 * @param countTool 计入 `writes` 的 tool 名；只有「成功且无 warning」才计数
 *                  （写失败 / 带警告不该让模型以为已经记过了）。
 */
export function applyOutcome(session: SessionFacts, outcome: ToolOutcome, countTool?: string): SessionFacts {
  const counted = !!countTool && outcome.tool === countTool && !outcome.failed && !outcome.warning;
  return { writes: session.writes + (counted ? 1 : 0), last: outcome };
}

function hhmmOf(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
