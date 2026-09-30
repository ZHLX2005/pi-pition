import { describe, expect, it } from "vitest";
import {
  cronMatchesToday,
  deleteGoal,
  goalCompleted,
  goalPercent,
  materializeGoals,
  progressGoal,
  renderGoalSummary,
  renderGoalsStatus,
  setGoal,
  todayGoals,
  updateGoal,
} from "../src/goal.ts";
import type { ActiveGoal, PitionConfig } from "../src/types.ts";

const baseCfg = (): PitionConfig => ({ token: "t", bindings: {}, currentBindingId: null, _activeGoals: [] });
const NOW = new Date(2026, 8, 30, 15, 0, 0); // 2026-09-30（周三）15:00 本地
const TODAY = "2026-09-30";

const makeGoal = (over: Partial<ActiveGoal> = {}): ActiveGoal => ({
  goalId: "g1",
  title: "今日锻炼计划",
  period: "day",
  date: TODAY,
  items: [
    { name: "俯卧撑", target: 4, progress: 0, unit: "轮" },
    { name: "平板支撑", target: 3, progress: 0, unit: "组" },
  ],
  createdAt: "2026-09-30T15:00:00.000+08:00",
  ...over,
});

describe("cronMatchesToday", () => {
  it("* * * * * 恒真", () => {
    expect(cronMatchesToday("* * * * *", NOW)).toBe(true);
  });
  it("星期字段命中（0=周日，7 也=周日）", () => {
    expect(cronMatchesToday("* * * * 3", NOW)).toBe(true); // 09-30 是周三
    expect(cronMatchesToday("* * * * 0", NOW)).toBe(false);
    expect(cronMatchesToday("* * * * 7", new Date(2026, 8, 27))).toBe(true); // 09-27 周日
  });
  it("标准 cron 语义：dom 与 dow 都限定时取 OR", () => {
    // 1 号或周一：09-30 是周三 30 号 → 不命中
    expect(cronMatchesToday("* * 1 * 1", NOW)).toBe(false);
    // 30 号或周五：30 号命中
    expect(cronMatchesToday("* * 30 * 5", NOW)).toBe(true);
  });
  it("范围与步进", () => {
    expect(cronMatchesToday("* * * * 1-5", NOW)).toBe(true); // 工作日，周三是 1-5
    expect(cronMatchesToday("* * * 9 *", NOW)).toBe(true); // 9 月
    expect(cronMatchesToday("* * * 10 *", NOW)).toBe(false); // 10 月
    expect(cronMatchesToday("* * */10 * *", NOW)).toBe(false); // */10 从 1 起步进：1,11,21,31——30 不在
    expect(cronMatchesToday("* * 20-31/10 * *", NOW)).toBe(true); // 20,30 → 30 命中
  });
  it("非法表达式抛错", () => {
    expect(() => cronMatchesToday("bad", NOW)).toThrowError(/5 段/);
    expect(() => cronMatchesToday("* * 32 * *", NOW)).toThrowError(/越界/);
    expect(() => cronMatchesToday("* * a * *", NOW)).toThrowError(/非法/);
  });
});

describe("setGoal", () => {
  it("建今天的 goal（进度从 0 起）", () => {
    const r = setGoal(baseCfg(), { title: "今日锻炼计划", items: [{ name: "俯卧撑", target: 4, unit: "轮" }] }, NOW);
    expect(r.goal.date).toBe(TODAY);
    expect(r.goal.items[0].progress).toBe(0);
    expect(r.goal.autoPeriod).toBeUndefined();
    expect(r.replaced).toBe(false);
  });

  it("同日重复 set 不带 replace 报错；带 replace 覆盖", () => {
    const a = setGoal(baseCfg(), { title: "A", items: [{ name: "x", target: 1 }] }, NOW);
    expect(() => setGoal(a.cfg, { title: "B", items: [{ name: "y", target: 1 }] }, NOW)).toThrowError(/replace:true/);
    const b = setGoal(a.cfg, { title: "B", items: [{ name: "y", target: 1 }], replace: true }, NOW);
    expect(b.replaced).toBe(true);
    expect(b.goal.title).toBe("B");
  });

  it("date 补录历史日", () => {
    const r = setGoal(baseCfg(), { title: "旧", items: [{ name: "x", target: 2 }] }, NOW);
    const b = setGoal(r.cfg, { title: "旧日", items: [{ name: "x", target: 2 }], date: "2026-09-28" }, NOW);
    expect(b.goal.date).toBe("2026-09-28");
  });

  // 回归：未来日期的 goal 在 list/注入里永远不可见（只渲染今天）——线上实症
  // （模型凌晨 set 时传错 date，「set 成功 1 分钟后查无此 goal」）
  it("date 未来日期拒绝（set 时即报错，不落不可见毒丸）", () => {
    expect(() =>
      setGoal(baseCfg(), { title: "t", items: [{ name: "x", target: 1 }], date: "2026-10-01" }, NOW),
    ).toThrowError(/未来日期/);
  });

  it("自动周期 goal 不参与同日判重", () => {
    const a = setGoal(baseCfg(), { title: "模板", items: [{ name: "x", target: 1 }], autoPeriod: "daily" }, NOW);
    const b = setGoal(a.cfg, { title: "当日", items: [{ name: "y", target: 1 }] }, NOW);
    expect(b.replaced).toBe(false); // 共存
  });

  it("autoPeriod 非法值抛错", () => {
    expect(() =>
      setGoal(baseCfg(), { title: "t", items: [{ name: "x", target: 1 }], autoPeriod: "weekly" }, NOW),
    ).toThrowError(/daily.*cron|cron.*daily/s);
  });

  it("items 校验：空列表 / 缺 name / target 非正", () => {
    expect(() => setGoal(baseCfg(), { title: "t", items: [] }, NOW)).toThrowError(/非空 items/);
    expect(() => setGoal(baseCfg(), { title: "t", items: [{ name: " ", target: 1 }] }, NOW)).toThrowError(/缺 name/);
    expect(() => setGoal(baseCfg(), { title: "t", items: [{ name: "x", target: 0 }] }, NOW)).toThrowError(/正数/);
  });
});

describe("progressGoal", () => {
  it("delta 加法推进（默认 1）", () => {
    const cfg = { ...baseCfg(), _activeGoals: [makeGoal()] };
    const r = progressGoal(cfg, { itemName: "俯卧撑" }, NOW);
    expect(r.item.progress).toBe(1);
    expect(r.completed).toBe(false);
  });

  it("delta=2 与负数回退", () => {
    const cfg = { ...baseCfg(), _activeGoals: [makeGoal()] };
    expect(progressGoal(cfg, { itemName: "俯卧撑", delta: 2 }, NOW).item.progress).toBe(2);
    const r2 = progressGoal(
      {
        ...cfg,
        _activeGoals: [
          makeGoal({
            items: [
              { name: "俯卧撑", target: 4, progress: 2, unit: "轮" },
              { name: "平板支撑", target: 3, progress: 0, unit: "组" },
            ],
          }),
        ],
      },
      { itemName: "俯卧撑", delta: -1 },
      NOW,
    );
    expect(r2.item.progress).toBe(1);
  });

  it("value 绝对值设置 / reset 归零 / 互斥校验", () => {
    const cfg = {
      ...baseCfg(),
      _activeGoals: [
        makeGoal({
          items: [
            { name: "俯卧撑", target: 4, progress: 3, unit: "轮" },
            { name: "平板支撑", target: 3, progress: 0, unit: "组" },
          ],
        }),
      ],
    };
    expect(progressGoal(cfg, { itemName: "俯卧撑", value: 1 }, NOW).item.progress).toBe(1);
    expect(progressGoal(cfg, { itemName: "俯卧撑", reset: true }, NOW).item.progress).toBe(0);
    expect(() => progressGoal(cfg, { itemName: "俯卧撑", delta: 1, value: 2 }, NOW)).toThrowError(/只能传一个/);
    expect(() => progressGoal(cfg, { itemName: "俯卧撑", value: -1 }, NOW)).toThrowError(/非负/);
  });

  it("全部条目达标 → completed；允许超出", () => {
    const done = makeGoal({
      items: [
        { name: "俯卧撑", target: 4, progress: 4, unit: "轮" },
        { name: "平板支撑", target: 3, progress: 3, unit: "组" },
      ],
    });
    const r = progressGoal({ ...baseCfg(), _activeGoals: [done] }, { itemName: "俯卧撑", delta: 1 }, NOW);
    expect(r.item.progress).toBe(5); // 允许超出
    expect(r.completed).toBe(true);
  });

  it("条目不存在报错并列出全部", () => {
    const cfg = { ...baseCfg(), _activeGoals: [makeGoal()] };
    expect(() => progressGoal(cfg, { itemName: "深蹲" }, NOW)).toThrowError(/深蹲.*俯卧撑.*平板支撑/s);
  });

  it("多个今日 goal 无 goalId 报错列候选", () => {
    const cfg = { ...baseCfg(), _activeGoals: [makeGoal({ goalId: "a" }), makeGoal({ goalId: "b", title: "第二个" })] };
    expect(() => progressGoal(cfg, { itemName: "俯卧撑" }, NOW)).toThrowError(/2 个目标.*goalId/s);
    const r = progressGoal(cfg, { goalId: "b", itemName: "俯卧撑" }, NOW);
    expect(r.goal.goalId).toBe("b");
  });

  it("今天没有 goal 报错指引 set", () => {
    expect(() => progressGoal(baseCfg(), { itemName: "x" }, NOW)).toThrowError(/没有目标.*action=set/s);
  });

  it("自动周期跨天：物化后推进（进度归零重开）", () => {
    const template = makeGoal({
      autoPeriod: "daily",
      date: "2026-09-28",
      items: [{ name: "俯卧撑", target: 4, progress: 4, unit: "轮" }],
    });
    const r = progressGoal({ ...baseCfg(), _activeGoals: [template] }, { itemName: "俯卧撑" }, NOW);
    expect(r.goal.date).toBe(TODAY); // 已重开
    expect(r.item.progress).toBe(1); // 从 0 起推进
  });
});

describe("updateGoal", () => {
  it("改 title / 绑定 / 周期，不动进度", () => {
    const cfg = {
      ...baseCfg(),
      _activeGoals: [makeGoal({ items: [{ name: "俯卧撑", target: 4, progress: 2, unit: "轮" }] })],
    };
    const r = updateGoal(cfg, { title: "新标题", bindField: "完成度" }, NOW);
    expect(r.goal.title).toBe("新标题");
    expect(r.goal.bindField).toBe("完成度");
    expect(r.goal.items[0].progress).toBe(2);
  });

  it("items 更新：同名保留进度，新条目从 0", () => {
    const cfg = {
      ...baseCfg(),
      _activeGoals: [makeGoal({ items: [{ name: "俯卧撑", target: 4, progress: 2, unit: "轮" }] })],
    };
    const r = updateGoal(
      cfg,
      {
        items: [
          { name: "俯卧撑", target: 6, unit: "轮" },
          { name: "深蹲", target: 3 },
        ],
      },
      NOW,
    );
    expect(r.goal.items.find((it) => it.name === "俯卧撑")!.progress).toBe(2);
    expect(r.goal.items.find((it) => it.name === "深蹲")!.progress).toBe(0);
    expect(r.goal.items.find((it) => it.name === "俯卧撑")!.target).toBe(6);
  });

  it("null 清除可选字段；今天无 goal 报错", () => {
    const cfg = { ...baseCfg(), _activeGoals: [makeGoal({ bindField: "F", note: "n", autoPeriod: "daily" })] };
    const r = updateGoal(cfg, { bindField: null, note: null, autoPeriod: null }, NOW);
    expect(r.goal.bindField).toBeUndefined();
    expect(r.goal.note).toBeUndefined();
    expect(r.goal.autoPeriod).toBeUndefined();
    expect(() => updateGoal(baseCfg(), { title: "x" }, NOW)).toThrowError(/没有目标.*action=set/s);
  });
});

describe("deleteGoal", () => {
  it("删今天的 goal；删自动周期 = 不再重开", () => {
    const cfg = { ...baseCfg(), _activeGoals: [makeGoal({ autoPeriod: "daily" })] };
    const r = deleteGoal(cfg, {}, NOW);
    expect(r.removed.autoPeriod).toBe("daily");
    expect(r.remaining).toBe(0);
    // 之后跨天也不会重开（已删）
    expect(todayGoals(r.cfg._activeGoals!, NOW).list).toEqual([]);
  });

  it("今天无 goal 报错；goalId 定位删除", () => {
    expect(() => deleteGoal(baseCfg(), {}, NOW)).toThrowError(/没有目标.*action=set/s);
    const cfg = { ...baseCfg(), _activeGoals: [makeGoal({ goalId: "z9", date: "2026-09-28" })] };
    const r = deleteGoal(cfg, { goalId: "z9" }, NOW);
    expect(r.removed.goalId).toBe("z9");
  });
});

describe("materializeGoals / todayGoals", () => {
  it("daily 模板跨天原地重开（同 goalId、进度归零、date 前移）", () => {
    const template = makeGoal({
      autoPeriod: "daily",
      date: "2026-09-28",
      items: [{ name: "俯卧撑", target: 4, progress: 4, unit: "轮" }],
    });
    const out = materializeGoals([template], NOW);
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe(TODAY);
    expect(out[0].goalId).toBe("g1");
    expect(out[0].items[0].progress).toBe(0);
  });

  it("cron 不命中的今天不重开（沉睡）", () => {
    const template = makeGoal({
      autoPeriod: "0 6 * * 1",
      date: "2026-09-28",
      items: [{ name: "x", target: 1, progress: 1 }],
    }); // 周一
    const out = materializeGoals([template], NOW); // 周三
    expect(out[0].date).toBe("2026-09-28"); // 未动
    expect(todayGoals([template], NOW).list).toEqual([]); // 今天不渲染
  });

  it("cron 命中的今天重开；一次性 goal 不动", () => {
    const cron = makeGoal({
      goalId: "cron",
      autoPeriod: "0 6 * * 3",
      date: "2026-09-23",
      items: [{ name: "x", target: 2, progress: 2 }],
    });
    const once = makeGoal({ goalId: "once", date: "2026-09-28", items: [{ name: "y", target: 1, progress: 1 }] });
    const out = materializeGoals([cron, once], NOW);
    const c = out.find((g) => g.goalId === "cron")!;
    expect(c.date).toBe(TODAY);
    expect(c.items[0].progress).toBe(0);
    const o = out.find((g) => g.goalId === "once")!;
    expect(o.date).toBe("2026-09-28"); // 沉底保留，进度不丢
  });

  it("missedDays：上个执行日有活动 → 0；零活动 → 间隔天数（自检查的数据源）", () => {
    // 有活动：09-28 执行过（progress>0）→ missedDays=0
    const active = makeGoal({
      autoPeriod: "daily",
      date: "2026-09-28",
      items: [{ name: "俯卧撑", target: 4, progress: 2, unit: "轮" }],
    });
    expect(materializeGoals([active], NOW)[0].missedDays).toBe(0);
    // 零活动：09-26 断更 → 间隔 4 天（26→30）
    const idle = makeGoal({
      autoPeriod: "daily",
      date: "2026-09-26",
      items: [{ name: "俯卧撑", target: 4, progress: 0, unit: "轮" }],
    });
    const out = materializeGoals([idle], NOW);
    expect(out[0].missedDays).toBe(4);
  });

  it("renderGoalsStatus：missedDays ≥ 2 注入 ⚠️ 自检查提示", () => {
    const idle = makeGoal({ missedDays: 3, items: [{ name: "俯卧撑", target: 4, progress: 0, unit: "轮" }] });
    const text = renderGoalsStatus([idle], NOW);
    expect(text).toContain("⚠️ 已连续 3 天未执行");
    expect(text).toContain("询问用户是否调整");
    // missedDays=1 不提示（未达连续 2 天阈值）
    const fresh = makeGoal({ missedDays: 1 });
    expect(renderGoalsStatus([fresh], NOW)).not.toContain("⚠️");
  });

  it("无变化时返回原数组引用（调用方据此免落盘）", () => {
    const arr = [makeGoal()];
    expect(materializeGoals(arr, NOW)).toBe(arr);
  });
});

describe("goalPercent / goalCompleted / render", () => {
  it("percent 按 target 加权；completed 全达标", () => {
    const g = makeGoal({
      items: [
        { name: "俯卧撑", target: 4, progress: 2, unit: "轮" },
        { name: "平板支撑", target: 3, progress: 0, unit: "组" },
      ],
    });
    expect(goalPercent(g)).toBe(29); // 2/7
    expect(goalCompleted(g)).toBe(false);
    const done = makeGoal({ items: [{ name: "俯卧撑", target: 4, progress: 4, unit: "轮" }] });
    expect(goalPercent(done)).toBe(100);
    expect(goalCompleted(done)).toBe(true);
  });

  it("renderGoalSummary：单行 + ✅ 前缀", () => {
    const g = makeGoal({
      items: [
        { name: "俯卧撑", target: 4, progress: 2, unit: "轮" },
        { name: "平板支撑", target: 3, progress: 3, unit: "组" },
      ],
    });
    expect(renderGoalSummary(g)).toBe("俯卧撑 2/4 轮 · 平板支撑 3/3 组（71%）"); // 5/7
    const done = makeGoal({ items: [{ name: "俯卧撑", target: 1, progress: 2 }] });
    expect(renderGoalSummary(done)).toBe("✅ 俯卧撑 1/1（100%）"); // 超出按 min 显示
  });

  it("renderGoalsStatus：只渲染今日 + 周期标注；无今日返回空串", () => {
    const past = makeGoal({ date: "2026-09-01" });
    expect(renderGoalsStatus([past], NOW)).toBe("");
    const text = renderGoalsStatus([makeGoal({ autoPeriod: "0 6 * * 3" })], NOW);
    expect(text).toContain("🎯 今日目标 1 个");
    expect(text).toContain("cron: 0 6 * * 3");
    expect(text).toContain("俯卧撑 0/4 轮");
  });
});
