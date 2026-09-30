// 时间与时间戳工具：模型看不到事件发生瞬间，程序可以从 new Date() 拿到当前时间。
// 粒度：[HH:MM] 本地时间；跨日由 Notion 自带 last_edited_time 区分。
//
// 时区策略：**所有面向用户的字符串统一走本地时区**（[HH:MM] 前缀、YYYY-MM-DD 日期、
// [HH:MM-HH:MM 持续 N 分钟] 区间、本地 ISO 字符串）。
// 纯内部计算（ended.getTime() - started.getTime() 这类绝对瞬间差）不受时区影响。
import type { Binding } from "./types.ts";

/** 接受 ISO 字符串 / Date / 数字 / undefined，产出 Date 对象（无效输入抛错） */
export function toDate(input: string | number | Date | undefined, fieldName = "timestamp"): Date {
  if (input === undefined) return new Date();
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) throw new Error(`${fieldName} 不是合法时间：${String(input)}`);
  return d;
}

/** Date → "[HH:MM]"（本地时区；补零） */
export function clockPrefix(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `[${hh}:${mm}]`;
}

/**
 * 给正文每段加 [HH:MM] 前缀；保留 \n\n 段分隔语义。
 *
 * 空白段（只含空格/换行的段）原样保留——不加前缀，也不替换成整段内容。
 * （曾有此 bug：空段分支误返回 `content` 而非 `para`，导致整段正文被重复输出。）
 */
export function prefixClockToContent(content: string, when: Date): string {
  const prefix = clockPrefix(when);
  return content
    .split(/\n{2,}/)
    .map((para) => (para.trim() ? `${prefix} ${para}` : para))
    .join("\n\n");
}

/** Date → "YYYY-MM-DD"（本地时区） */
export function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Date → "YYYY-MM-DDTHH:MM:SS.sss±HH:MM"（本地时区，含偏移）。
 *
 * 与 `Date.toISOString()` 的关键区别：toISOString 永远输出 UTC（带 `Z`），
 * 这会让同一时刻跟本地化的 `[HH:MM]` 前缀对不上（典型：北京时区晚 8h）。
 *
 * 例：本地 2026-09-30 22:30:00.000（UTC+8）
 *   `new Date(...).toISOString()`     → `"2026-09-30T14:30:00.000Z"`
 *   `toLocalIsoString(new Date(...))` → `"2026-09-30T22:30:00.000+08:00"`
 *
 * 反向解析：`new Date(toLocalIsoString(d)).getTime() === d.getTime()`。
 */
export function toLocalIsoString(d: Date): string {
  // getTimezoneOffset 返回"本地相对 UTC 的分钟差"，符号反着（UTC+8 返回 -480）
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  const offHH = String(Math.floor(abs / 60)).padStart(2, "0");
  const offMM = String(abs % 60).padStart(2, "0");
  const ymd = toYmd(d);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${ymd}T${hh}:${mm}:${ss}.${ms}${sign}${offHH}:${offMM}`;
}

/** Date → "[HH:MM-HH:MM 持续 N 分钟]"（区间事件用） */
export function formatSpanRange(started: Date, ended: Date): string {
  const elapsedMin = Math.round((ended.getTime() - started.getTime()) / 60000);
  const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `[${hhmm(started)}-${hhmm(ended)} 持续 ${elapsedMin} 分钟]`;
}

/** 把 YYYY-MM-DD 补进 properties 里 type=date 的字段（agent 未传 date 时回填） */
export function autoFillDateProperty(
  binding: Binding,
  entries: Array<{ name: string; value: unknown }>,
  when: Date,
): Array<{ name: string; value: unknown }> {
  const ymd = toYmd(when);
  const dateFields = Object.entries(binding.fields)
    .filter(([, m]) => m.type === "date")
    .map(([n]) => n);
  if (!dateFields.length) return entries;
  const supplied = new Set(entries.map((e) => e.name));
  const filled = [...entries];
  for (const n of dateFields) {
    if (!supplied.has(n)) filled.push({ name: n, value: ymd });
  }
  return filled;
}
