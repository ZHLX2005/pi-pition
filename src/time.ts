// 时间与时间戳工具：模型看不到事件发生瞬间，程序可以从 new Date() 拿到当前时间。
// 粒度：[HH:MM] 本地时间；跨日由 Notion 自带 last_edited_time 区分。
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

/** 给正文每段加 [HH:MM] 前缀；保留 \n\n 段分隔语义 */
export function prefixClockToContent(content: string, when: Date): string {
  const prefix = clockPrefix(when);
  return content
    .split(/\n{2,}/)
    .map((para) => (para.trim() ? `${prefix} ${para}` : content))
    .join("\n\n");
}

/** Date → "YYYY-MM-DD"（本地时区） */
export function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
