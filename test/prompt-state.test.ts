import { describe, expect, it } from "vitest";
import {
  allGoalsDone,
  applyOutcome,
  buildPromptState,
  emptySessionFacts,
  nextPendingItem,
  outcomeFromEvent,
  partOfDay,
  renderRuntimeSection,
} from "../src/prompt-state.ts";
import type { ActiveGoal, PitionConfig } from "../src/types.ts";

const cfg: PitionConfig = {
  token: "t",
  bindings: {
    d1: {
      dbId: "d1",
      title: "pition",
      description: "日常总表",
      fields: {
        Name: { type: "title", description: "标题" },
        金额: { type: "number" },
      },
    },
  },
  currentBindingId: "d1",
};

const NOW = new Date(2026, 9, 3, 22, 21, 0);

const goal = (over: Partial<ActiveGoal> = {}): ActiveGoal => ({
  goalId: "g1",
  title: "今日锻炼",
  period: "day",
  date: "2026-10-03",
  items: [
    { name: "俯卧撑", target: 4, progress: 2, unit: "轮" },
    { name: "平板支撑", target: 3, progress: 0, unit: "组" },
  ],
  createdAt: "2026-10-03T08:00:00.000+08:00",
  ...over,
});

describe("buildPromptState（状态快照）", () => {
  it("带出时间锚点：日期 / 星期 / 时刻 / 时段（本地时区，模型据此消歧「今天/刚才」）", () => {
    const s = buildPromptState({ cfg, now: NOW });
    expect(s.today).toBe("2026-10-03");
    expect(s.todayLabel).toBe("2026年10月3日 周六");
    expect(s.clock).toBe("22:21");
    expect(s.partOfDay).toBe("晚上");
  });

  it("字段覆盖：只数有 description 的", () => {
    const s = buildPromptState({ cfg, now: NOW });
    expect(s.fields).toEqual({ total: 2, described: 1 });
  });

  it("goal 只算今天的（昨天的不进状态）", () => {
    const s = buildPromptState({
      cfg: { ...cfg, _activeGoals: [goal(), goal({ goalId: "g2", date: "2026-10-02" })] },
      now: NOW,
    });
    expect(s.goals.map((g) => g.goalId)).toEqual(["g1"]);
  });

  it("未配置（无 token / 无库）时 configured=false，binding 为 null", () => {
    expect(buildPromptState({ cfg: null, now: NOW }).configured).toBe(false);
    expect(buildPromptState({ cfg: { token: "t", bindings: {}, currentBindingId: null }, now: NOW }).configured).toBe(
      false,
    );
    expect(
      buildPromptState({ cfg: { token: "t", bindings: cfg.bindings, currentBindingId: "d9" }, now: NOW }).binding,
    ).toBeNull();
  });

  it("时段划分覆盖全天（不抛错、都有值）", () => {
    for (const h of [0, 6, 9, 12, 15, 18, 22]) {
      const label = partOfDay(new Date(2026, 9, 3, h, 0, 0));
      expect(label.length).toBeGreaterThan(0);
    }
    expect(partOfDay(new Date(2026, 9, 3, 3, 0, 0))).toBe("凌晨");
    expect(partOfDay(new Date(2026, 9, 3, 12, 0, 0))).toBe("中午");
  });
});

describe("renderRuntimeSection（易变层）", () => {
  it("至少给出「现在」这一行，并要求模型以此为准（修历史 bug：自己推算日期）", () => {
    const text = renderRuntimeSection(buildPromptState({ cfg, now: NOW }));
    expect(text).toContain("2026年10月3日 周六 22:21 · 晚上");
    expect(text).toContain("不要自己推算");
  });

  it("会话事实按需出现：没写过就不提写入，写过才提", () => {
    const fresh = renderRuntimeSection(buildPromptState({ cfg, now: NOW, session: { writes: 0 } }));
    expect(fresh).not.toContain("已写入");
    const wrote = renderRuntimeSection(buildPromptState({ cfg, now: NOW, session: { writes: 2 } }));
    expect(wrote).toContain("本会话已写入 2 条");
  });

  it("warning 码翻成人话（未知码原样保留，不丢信息）", () => {
    const known = renderRuntimeSection(
      buildPromptState({
        cfg,
        now: NOW,
        session: { writes: 0, last: { tool: "pition_write", failed: false, warning: "no_page_in_db", at: "22:18" } },
      }),
    );
    expect(known).toContain("该库还没有任何 page");
    const unknown = renderRuntimeSection(
      buildPromptState({
        cfg,
        now: NOW,
        session: { writes: 0, last: { tool: "pition_goal", failed: false, warning: "weird_code", at: "22:18" } },
      }),
    );
    expect(unknown).toContain("weird_code");
  });

  it("失败态带「别原样重试」；成功态不带警告", () => {
    const failed = renderRuntimeSection(
      buildPromptState({
        cfg,
        now: NOW,
        session: { writes: 0, last: { tool: "pition_write", failed: true, summary: "fetch failed", at: "22:20" } },
      }),
    );
    expect(failed).toContain("失败");
    expect(failed).toContain("别原样重试");
    const ok = renderRuntimeSection(
      buildPromptState({
        cfg,
        now: NOW,
        session: { writes: 1, last: { tool: "pition_write", failed: false, summary: "已写入", at: "22:20" } },
      }),
    );
    expect(ok).not.toContain("⚠️");
  });
});

describe("outcomeFromEvent（从 pi 事件采集结果）", () => {
  it("非 pition tool 直接忽略（不污染会话事实）", () => {
    expect(outcomeFromEvent({ toolName: "bash", result: { content: [] }, isError: false }, NOW)).toBeNull();
    expect(outcomeFromEvent({}, NOW)).toBeNull();
  });

  it("优先读结构化 details.warning；缺 details 时回退扫文案里的 WARNING", () => {
    const structured = outcomeFromEvent(
      {
        toolName: "pition_write",
        result: { content: [{ type: "text", text: "WARNING: 没有 page" }], details: { warning: "no_page_in_db" } },
        isError: false,
      },
      NOW,
    );
    expect(structured?.warning).toBe("no_page_in_db");

    const textual = outcomeFromEvent(
      {
        toolName: "pition_create_today",
        result: { content: [{ type: "text", text: "WARNING: 定时任务没建 page" }] },
        isError: false,
      },
      NOW,
    );
    expect(textual?.warning).toContain("WARNING");
  });

  it("容错：result 是字符串 / 缺少内容都不抛错，摘要被截断", () => {
    expect(outcomeFromEvent({ toolName: "pition_read", result: "纯文本", isError: false }, NOW)?.summary).toBe(
      "纯文本",
    );
    expect(
      outcomeFromEvent({ toolName: "pition_read", result: undefined, isError: false }, NOW)?.summary,
    ).toBeUndefined();
    const long = outcomeFromEvent(
      { toolName: "pition_read", result: { content: [{ type: "text", text: "x".repeat(500) }] }, isError: false },
      NOW,
    );
    expect((long?.summary ?? "").length).toBeLessThanOrEqual(120);
  });

  it("记下采集时刻与是否失败", () => {
    const o = outcomeFromEvent({ toolName: "pition_write", result: {}, isError: true }, new Date(2026, 9, 3, 9, 5, 0));
    expect(o?.at).toBe("09:05");
    expect(o?.failed).toBe(true);
  });
});

describe("applyOutcome（并进会话事实）", () => {
  const ok = { tool: "pition_write", failed: false, summary: "已写入", at: "22:20" };

  it("成功的 write 才计数", () => {
    expect(applyOutcome(emptySessionFacts(), ok).writes).toBe(1);
    expect(applyOutcome({ writes: 1 }, { ...ok, failed: true }).writes).toBe(1);
    expect(applyOutcome({ writes: 1 }, { ...ok, warning: "no_page_in_db" }).writes).toBe(1);
    expect(applyOutcome({ writes: 1 }, { ...ok, tool: "pition_read" }).writes).toBe(1);
  });

  it("总是记住最后一条结果（供下一轮回流）", () => {
    const next = applyOutcome(emptySessionFacts(), { ...ok, tool: "pition_goal" });
    expect(next.last?.tool).toBe("pition_goal");
  });
});

describe("目标派生事实", () => {
  it("nextPendingItem 取第一个未达标条目（用来给「下一项」建议）", () => {
    expect(nextPendingItem(goal())?.name).toBe("俯卧撑");
    expect(nextPendingItem(goal({ items: [{ name: "俯卧撑", target: 4, progress: 4 }] }))).toBeNull();
  });

  it("allGoalsDone 需要真的全部达标（空目标不算完成）", () => {
    expect(allGoalsDone([])).toBe(false);
    expect(allGoalsDone([goal()])).toBe(false);
    expect(allGoalsDone([goal({ items: [{ name: "俯卧撑", target: 1, progress: 1 }] })])).toBe(true);
  });
});
