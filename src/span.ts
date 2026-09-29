// 区间事件（span）：start 落盘、end 时把整段写成一条正文。
// 进行中的 span 会被渲染成全局提示词片段，持续提醒 agent「用户正在做什么、已多久」。
//
// 设计要点：
//   - **支持并行多个事件**（边养神边听歌是真实生活）——_activeSpans 是数组
//   - **无需心跳**：累计时长由 startedAt 现算（每次 before_agent_start 重算），跨轮次自动增长
//   - **end 需精确指定**：有多个进行中事件时必须传 eventName，否则报错列出全部
import { formatSpanRange } from "./time.ts";
import type { ActiveSpan, PitionConfig } from "./types.ts";

/** 生成唯一 span id（时间戳 + 随机后缀，无需 uuid 依赖） */
export function newSpanId(now: Date = new Date()): string {
  return `span_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 开一段新 span（可并行多个）。返回新配置 + 该 span + 并行总数 */
export function startSpan(
  cfg: PitionConfig,
  eventName: string,
  note: string | undefined,
  now: Date = new Date(),
): { cfg: PitionConfig; span: ActiveSpan; totalActive: number } {
  if (!eventName) throw new Error("action=start 必须传 eventName");
  const spans = cfg._activeSpans ?? [];
  const span: ActiveSpan = { spanId: newSpanId(now), eventName, note, startedAt: now.toISOString() };
  return {
    cfg: { ...cfg, _activeSpans: [...spans, span] },
    span,
    totalActive: spans.length + 1,
  };
}

export interface EndSpanResult {
  cfg: PitionConfig;
  span: ActiveSpan;
  /** 要写进 Notion 的整段正文，如 `[14:32-15:00 持续 28 分钟] 跑步（公园）— 感觉很好` */
  paragraphText: string;
  elapsedMin: number;
  /** 收尾后仍在进行的事件 */
  stillActive: ActiveSpan[];
}

/**
 * 结束一段 span。
 * eventName 精确匹配；省略时**仅当只有一个进行中事件**才允许，否则报错列出全部候选项。
 */
export function endSpan(
  cfg: PitionConfig,
  eventName: string | undefined,
  note: string | undefined,
  summary: string | undefined,
  now: Date = new Date(),
): EndSpanResult {
  const spans = cfg._activeSpans ?? [];
  if (!spans.length) throw new Error("没有进行中的 span 可以 end——直接调 pition_write 即可");

  const matched = eventName ? spans.find((s) => s.eventName === eventName) : undefined;
  if (eventName && !matched) {
    const names = spans.map((s) => `「${s.eventName}」`).join("、") || "无";
    throw new Error(`没有名为「${eventName}」的进行中事件。当前进行中：${names}`);
  }
  if (!eventName && spans.length > 1) {
    const names = spans.map((s) => `「${s.eventName}」`).join("、");
    throw new Error(`有 ${spans.length} 个进行中的事件，必须传 eventName 指定收尾哪个：${names}`);
  }
  const target = matched ?? spans[0];

  const started = new Date(target.startedAt);
  const head = formatSpanRange(started, now);
  const finalNote = note ?? target.note;
  const tail: string[] = [];
  if (finalNote) tail.push(`（${finalNote}）`);
  if (summary) tail.push(`— ${summary}`);

  const rest = spans.filter((s) => s.spanId !== target.spanId);
  return {
    cfg: { ...cfg, _activeSpans: rest },
    span: target,
    paragraphText: `${head} ${target.eventName}${tail.join("")}`,
    elapsedMin: Math.round((now.getTime() - started.getTime()) / 60000),
    stillActive: rest,
  };
}

/**
 * 把进行中的 spans 渲染成注入 system prompt 的文本（支持并行多事件）。
 *
 * 例：
 * ```
 * 📍 进行中 2 件事：
 * - 养神，已 3 分钟（01:38 开始）
 * - 调试 pition，已 12 分钟（01:29 开始）
 *    结束某个：调 pition_span action=end eventName=<事件名>。
 * ```
 */
export function renderSpansStatus(spans: ActiveSpan[], now: Date = new Date()): string {
  const lines = spans.map((span) => {
    const started = new Date(span.startedAt).getTime();
    const elapsedMin = Math.max(0, Math.round((now.getTime() - started) / 60000));
    const noteSuffix = span.note ? `（${span.note}）` : "";
    const clock = new Date(started).toTimeString().slice(0, 5);
    return `- ${span.eventName}${noteSuffix}，已 ${elapsedMin} 分钟（${clock} 开始）`;
  });
  return `📍 进行中 ${spans.length} 件事：\n${lines.join("\n")}\n   结束某个：调 pition_span action=end eventName=<事件名>。`;
}
