import { describe, expect, it } from "vitest";
import { endSpan, newSpanId, renderSpansStatus, startSpan } from "../src/span.ts";
import type { PitionConfig } from "../src/types.ts";

const baseCfg = (): PitionConfig => ({ token: "t", bindings: {}, currentBindingId: null, _activeSpans: [] });

describe("newSpanId", () => {
  it("生成带时间戳前缀的唯一 id", () => {
    const a = newSpanId(new Date(1000));
    const b = newSpanId(new Date(1000));
    expect(a.startsWith("span_1000_")).toBe(true);
    expect(a).not.toBe(b); // 随机后缀保证唯一
  });
});

describe("startSpan", () => {
  it("开新 span 落进 _activeSpans，并报告并行总数", () => {
    const r = startSpan(baseCfg(), "跑步", "公园 5 公里", new Date(2026, 8, 29, 14, 0));
    expect(r.cfg._activeSpans).toHaveLength(1);
    expect(r.span.eventName).toBe("跑步");
    expect(r.span.note).toBe("公园 5 公里");
    expect(r.totalActive).toBe(1);
  });

  it("支持并行多个事件（不要求先结束旧的）", () => {
    const a = startSpan(baseCfg(), "跑步", undefined, new Date(2026, 8, 29, 14, 0));
    const b = startSpan(a.cfg, "听歌", undefined, new Date(2026, 8, 29, 14, 5));
    expect(b.cfg._activeSpans!.map((s) => s.eventName)).toEqual(["跑步", "听歌"]);
    expect(b.totalActive).toBe(2);
  });

  it("缺 eventName 抛错", () => {
    expect(() => startSpan(baseCfg(), "", undefined, new Date())).toThrowError(/必须传 eventName/);
  });
});

describe("endSpan", () => {
  it("产出 [起-止 持续 ...] 正文并移除该 span", () => {
    const { cfg } = startSpan(baseCfg(), "跑步", "公园 5 公里", new Date(2026, 8, 29, 14, 32, 0));
    const r = endSpan(cfg, "跑步", undefined, "感觉很好", new Date(2026, 8, 29, 15, 0, 0));
    expect(r.paragraphText).toBe("[14:32:00-15:00:00 持续 28 分] 跑步（公园 5 公里）— 感觉很好");
    expect(r.elapsedMin).toBe(28);
    expect(r.elapsedText).toBe("28 分");
    expect(r.cfg._activeSpans).toEqual([]);
    expect(r.stillActive).toEqual([]);
  });

  it("秒级 span：47 秒的轮次", () => {
    const { cfg } = startSpan(baseCfg(), "俯卧撑", undefined, new Date(2026, 8, 29, 14, 32, 15));
    const r = endSpan(cfg, "俯卧撑", undefined, undefined, new Date(2026, 8, 29, 14, 33, 2));
    expect(r.paragraphText).toContain("[14:32:15-14:33:02 持续 47 秒]");
    expect(r.elapsedText).toBe("47 秒");
  });

  it("并行 span 中只结束指定的那个，其余进 stillActive", () => {
    const a = startSpan(baseCfg(), "跑步", undefined, new Date(2026, 8, 29, 14, 0));
    const b = startSpan(a.cfg, "听歌", undefined, new Date(2026, 8, 29, 14, 5));
    const r = endSpan(b.cfg, "跑步", undefined, undefined, new Date(2026, 8, 29, 14, 30));
    expect(r.cfg._activeSpans!.map((s) => s.eventName)).toEqual(["听歌"]);
    expect(r.stillActive.map((s) => s.eventName)).toEqual(["听歌"]);
  });

  it("只有一个进行中事件时，可省略 eventName", () => {
    const { cfg } = startSpan(baseCfg(), "跑步", undefined, new Date(2026, 8, 29, 14, 0));
    const r = endSpan(cfg, undefined, undefined, undefined, new Date(2026, 8, 29, 14, 30));
    expect(r.span.eventName).toBe("跑步");
  });

  it("有多个进行中事件且未指定 eventName → 报错并列出全部候选", () => {
    const a = startSpan(baseCfg(), "跑步", undefined, new Date());
    const b = startSpan(a.cfg, "听歌", undefined, new Date());
    expect(() => endSpan(b.cfg, undefined, undefined, undefined)).toThrowError(/必须传 eventName.*跑步.*听歌/);
  });

  it("指定不存在的事件名 → 报错并列出当前进行中", () => {
    const { cfg } = startSpan(baseCfg(), "跑步", undefined, new Date());
    expect(() => endSpan(cfg, "游泳", undefined, undefined)).toThrowError(/没有名为「游泳」.*跑步/);
  });

  it("end 时可覆盖备注", () => {
    const { cfg } = startSpan(baseCfg(), "跑步", "旧", new Date(2026, 8, 29, 14, 0));
    const r = endSpan(cfg, "跑步", "新", undefined, new Date(2026, 8, 29, 14, 30));
    expect(r.paragraphText).toContain("（新）");
  });

  it("无进行中 span 时抛错并提示改用 pition_write", () => {
    expect(() => endSpan(baseCfg(), undefined, undefined, undefined)).toThrowError(/pition_write/);
  });
});

describe("renderSpansStatus", () => {
  it("渲染多事件 + 已持续时长（秒级）+ 操作指引", () => {
    const now = new Date(2026, 8, 29, 14, 30, 0);
    const spans = [
      { spanId: "a", eventName: "跑步", note: "公园", startedAt: new Date(2026, 8, 29, 14, 0, 0).toISOString() },
      { spanId: "b", eventName: "听歌", startedAt: new Date(2026, 8, 29, 14, 15, 0).toISOString() },
    ];
    const text = renderSpansStatus(spans, now);
    expect(text).toContain("进行中 2 件事");
    expect(text).toContain("跑步（公园），已 30 分");
    expect(text).toContain("听歌，已 15 分");
    expect(text).toContain("pition_span action=end");
  });
});
