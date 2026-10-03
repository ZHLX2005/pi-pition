// 时间锚点 —— 给模型一个「现在到底几点」的权威答案。
//
// 为什么必须注入：模型自己推算日期是**系统性错误源**（线上真出过给目标 set 了未来日期、
// 把「昨天」算错成别的一天）。程序有 `new Date()`，模型没有 —— 这条信息只能由扩展给。
//
// 纪律：锚点只给事实（日期 / 时刻 / 时段），不给建议。建议属于场景片段，
// 两边都写就是重复注入。
/** 周日排首位：`new Date().getDay()` 与下标一一对应 */
export const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 时段默认划分（粗略——用于让模型理解「早上/晚上」这类口语锚点，不追求精确） */
export const DAY_PART_LABELS = ["凌晨", "早上", "上午", "中午", "下午", "傍晚", "晚上"];

/** HH:MM（本地时区，补零） */
export function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** YYYY-MM-DD（本地时区） */
export function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * 时段。边界：<5 凌晨 / <8 早上 / <11 上午 / <13 中午 / <17 下午 / <19 傍晚 / 其余晚上。
 * @param labels 7 段文案（换语言/换粒度时传入）
 */
export function partOfDay(d: Date, labels: string[] = DAY_PART_LABELS): string {
  const h = d.getHours();
  const index = h < 5 ? 0 : h < 8 ? 1 : h < 11 ? 2 : h < 13 ? 3 : h < 17 ? 4 : h < 19 ? 5 : 6;
  return labels[index] ?? labels[labels.length - 1] ?? "";
}

/** 「2026年10月3日 周六」 */
export function todayLabel(d: Date, weekdays: string[] = WEEKDAY_LABELS): string {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${weekdays[d.getDay()] ?? ""}`;
}

/** 一轮的时间锚点（四个派生事实一次算齐，避免各处各算一遍） */
export interface TimeAnchor {
  now: Date;
  /** YYYY-MM-DD（本地） */
  today: string;
  /** 「2026年10月3日 周六」 */
  todayLabel: string;
  /** HH:MM */
  clock: string;
  /** 凌晨/早上/上午/中午/下午/傍晚/晚上 */
  partOfDay: string;
}

export function timeAnchor(d: Date, opts: { weekdays?: string[]; dayParts?: string[] } = {}): TimeAnchor {
  return {
    now: d,
    today: ymd(d),
    todayLabel: todayLabel(d, opts.weekdays),
    clock: hhmm(d),
    partOfDay: partOfDay(d, opts.dayParts),
  };
}
