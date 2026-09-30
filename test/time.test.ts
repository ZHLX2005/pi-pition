import { describe, expect, it } from "vitest";
import {
  autoFillDateProperty,
  clockPrefix,
  formatElapsed,
  formatSpanRange,
  prefixClockToContent,
  toDate,
  toLocalIsoString,
  toYmd,
} from "../src/time.ts";
import type { Binding } from "../src/types.ts";

describe("toDate", () => {
  it("undefined → 当前时间", () => {
    const before = Date.now();
    const d = toDate(undefined);
    expect(d.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("接受 ISO 字符串与数字时间戳", () => {
    expect(toDate("2026-09-29T10:00:00Z").toISOString()).toBe("2026-09-29T10:00:00.000Z");
    expect(toDate(0).getTime()).toBe(0);
  });

  it("非法时间抛错并带上字段名", () => {
    expect(() => toDate("not-a-date", "startedAt")).toThrowError(/startedAt 不是合法时间/);
  });
});

describe("clockPrefix / prefixClockToContent", () => {
  it("补零为 [HH:MM]", () => {
    expect(clockPrefix(new Date(2026, 8, 29, 9, 5))).toBe("[09:05]");
    expect(clockPrefix(new Date(2026, 8, 29, 23, 59))).toBe("[23:59]");
  });

  it("给每段加前缀，保留 \\n\\n 段落分隔", () => {
    const when = new Date(2026, 8, 29, 14, 32);
    expect(prefixClockToContent("第一段\n\n第二段", when)).toBe("[14:32] 第一段\n\n[14:32] 第二段");
  });

  it("单段内容也加前缀", () => {
    const when = new Date(2026, 8, 29, 8, 0);
    expect(prefixClockToContent("只有一段", when)).toBe("[08:00] 只有一段");
  });

  // 回归：空白段曾误返回整段 content，导致正文被重复注入
  it("空白段原样保留，不会触发整段重复", () => {
    const when = new Date(2026, 8, 29, 10, 0);
    const out = prefixClockToContent("a\n\n  \n\nb", when);
    expect(out).toBe("[10:00] a\n\n  \n\n[10:00] b");
    // 关键：输出里 "a" 只应出现一次（曾出现两次）
    expect(out.split("a").length - 1).toBe(1);
  });
});

describe("toYmd", () => {
  it("本地时区补零为 YYYY-MM-DD", () => {
    expect(toYmd(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(toYmd(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("toLocalIsoString", () => {
  it("输出 YYYY-MM-DDTHH:MM:SS.sss±HH:MM（含本地偏移）", () => {
    const d = new Date(2026, 8, 29, 14, 32, 15, 123);
    const out = toLocalIsoString(d);
    // 形如 2026-09-29T14:32:15.123+08:00（或 -05:00 等）；关键是日期/时分秒与本地一致
    expect(out).toMatch(/^2026-09-29T14:32:15\.123[+-]\d{2}:\d{2}$/);
    // 反向解析必须等于原 Date 的绝对瞬间（这才是 ISO 字符串的本职）
    expect(new Date(out).getTime()).toBe(d.getTime());
  });

  it("午夜、年初补零正确", () => {
    const d = new Date(2026, 0, 1, 0, 0, 0, 0);
    expect(toLocalIsoString(d)).toMatch(/^2026-01-01T00:00:00\.000[+-]\d{2}:\d{2}$/);
  });

  it("用 getHours / getMinutes 取的偏移字段是本地时区", () => {
    // 新建一个具体时刻，与 [HH:MM] 前缀做对账（这是修复的初衷）：
    // [HH:MM] 看到几时几分，timestamp 里 hour/minute 也应是几时几分。
    const d = new Date(2026, 8, 29, 14, 32);
    const out = toLocalIsoString(d);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    expect(out).toContain(`T${hh}:${mm}:`);
  });
});

describe("formatSpanRange", () => {
  it("输出 [起-止 持续 ...]（秒级时钟）", () => {
    const start = new Date(2026, 8, 29, 14, 32, 15);
    const end = new Date(2026, 8, 29, 15, 0, 20);
    expect(formatSpanRange(start, end)).toBe("[14:32:15-15:00:20 持续 28 分 5 秒]");
  });

  it("不足 1 分钟显示纯秒", () => {
    const start = new Date(2026, 8, 29, 14, 0, 0);
    const end = new Date(2026, 8, 29, 14, 0, 47);
    expect(formatSpanRange(start, end)).toBe("[14:00:00-14:00:47 持续 47 秒]");
  });

  it("整分钟边界", () => {
    const start = new Date(2026, 8, 29, 14, 0, 0);
    const end = new Date(2026, 8, 29, 14, 3, 0);
    expect(formatSpanRange(start, end)).toBe("[14:00:00-14:03:00 持续 3 分]");
  });
});

describe("formatElapsed", () => {
  it("秒 / 分秒 / 分 / 时分 各档位", () => {
    expect(formatElapsed(47_000)).toBe("47 秒");
    expect(formatElapsed(200_000)).toBe("3 分 20 秒");
    expect(formatElapsed(180_000)).toBe("3 分");
    expect(formatElapsed(3_900_000)).toBe("1 时 5 分");
    expect(formatElapsed(3_600_000)).toBe("1 时");
  });
});

describe("autoFillDateProperty", () => {
  const withDate: Binding = {
    dbId: "d",
    title: "t",
    fields: { Name: { type: "title" }, 日期: { type: "date" } },
  };

  it("agent 未传 date 时回填今天", () => {
    const out = autoFillDateProperty(withDate, [{ name: "Name", value: "x" }], new Date(2026, 8, 29));
    expect(out).toContainEqual({ name: "日期", value: "2026-09-29" });
  });

  it("agent 已显式传 date 时不覆盖", () => {
    const out = autoFillDateProperty(
      withDate,
      [
        { name: "Name", value: "x" },
        { name: "日期", value: "2020-01-01" },
      ],
      new Date(2026, 8, 29),
    );
    expect(out.filter((e) => e.name === "日期")).toHaveLength(1);
    expect(out).toContainEqual({ name: "日期", value: "2020-01-01" });
  });

  it("绑定的库没有 date 字段时原样返回", () => {
    const noDate: Binding = { dbId: "d", title: "t", fields: { Name: { type: "title" } } };
    const entries = [{ name: "Name", value: "x" }];
    expect(autoFillDateProperty(noDate, entries, new Date())).toEqual(entries);
  });
});
