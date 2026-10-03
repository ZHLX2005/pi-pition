import { describe, expect, it } from "vitest";
import { buildPromptState } from "../src/prompt-state.ts";
import { buildRoleInjections, GLOBAL_GUIDELINES, pruneToolGuidelines } from "../src/role.ts";
import type { SceneId } from "../src/sop.ts";
import type { ActiveGoal, PitionConfig } from "../src/types.ts";

const cfgWithBinding: PitionConfig = {
  token: "t",
  bindings: {
    d1: {
      dbId: "d1",
      title: "pition",
      description: "个人日常记录总表",
      fields: {
        Name: { type: "title", description: "记录标题" },
        金额: { type: "number", description: "当日花销" },
      },
    },
  },
  currentBindingId: "d1",
};

const cfgNoBinding: PitionConfig = { token: "t", bindings: {}, currentBindingId: null };

const NOW = new Date(2026, 9, 3, 22, 21, 0);

function state(cfg: PitionConfig | null, goals: ActiveGoal[] = []) {
  return buildPromptState({ cfg, now: NOW, goals });
}

function goal(overrides: Partial<ActiveGoal> = {}): ActiveGoal {
  return {
    goalId: "g1",
    title: "今日锻炼计划",
    period: "day",
    date: "2026-10-03",
    items: [
      { name: "俯卧撑", target: 4, progress: 2, unit: "轮" },
      { name: "平板支撑", target: 3, progress: 0, unit: "组" },
    ],
    createdAt: "2026-10-03T08:00:00.000+08:00",
    ...overrides,
  };
}

const ALL_SCENES: SceneId[] = ["setup", "train", "log", "recall", "chat"];

describe("buildRoleInjections（分层注入）", () => {
  it("恒定层 pition_core 与易变层 pition_runtime 总在", () => {
    for (const scene of ALL_SCENES) {
      const r = buildRoleInjections(cfgWithBinding, scene, state(cfgWithBinding));
      expect(Object.keys(r.sections)).toContain("pition_core");
      expect(r.sections.pition_runtime).toContain("现在：");
      expect(r.sections.pition_core).toContain("个人日常记录总表");
    }
  });

  it("易变层带时间锚点与「以它为准」的约束（修历史 bug：模型自己推算日期）", () => {
    const runtime = buildRoleInjections(cfgWithBinding, "chat", state(cfgWithBinding)).sections.pition_runtime;
    expect(runtime).toContain("2026年10月3日 周六");
    expect(runtime).toContain("22:21");
    expect(runtime).toContain("不要自己推算");
  });

  it("全局 guideline 只有 3 条且含关键边界（情绪也算事实事件）", () => {
    const r = buildRoleInjections(cfgWithBinding, "chat", state(cfgWithBinding));
    expect(r.guidelines).toEqual(GLOBAL_GUIDELINES);
    expect(r.guidelines.length).toBe(3);
    expect(r.guidelines.join("\n")).toMatch(/情绪|感悟/);
  });

  it("chat 场景不注入剧本与字段字典（避免无关内容常驻）", () => {
    const r = buildRoleInjections(cfgWithBinding, "chat", state(cfgWithBinding));
    expect(r.sections.pition_scene).toBeUndefined();
    expect(r.sections.pition_fields).toBeUndefined();
  });

  it("记录类场景注入字段字典；未绑库时不注入", () => {
    const withFields = buildRoleInjections(cfgWithBinding, "log", state(cfgWithBinding));
    expect(withFields.sections.pition_fields).toContain("金额(number=累加)");
    const noFields = buildRoleInjections(cfgNoBinding, "log", state(cfgNoBinding));
    expect(noFields.sections.pition_fields).toBeUndefined();
  });

  it("剧本随状态变：没有目标时不教推进，有目标时不教建计划", () => {
    const idle = buildRoleInjections(cfgWithBinding, "train", state(cfgWithBinding, [])).sections.pition_scene;
    expect(idle).toContain("还没有今日目标");
    expect(idle).not.toContain("正在跑");

    const running = buildRoleInjections(cfgWithBinding, "train", state(cfgWithBinding, [goal()])).sections.pition_scene;
    expect(running).toContain("正在跑");
    expect(running).not.toContain("还没有今日目标");
  });

  it("剧本带出真实数字（下一项 = 第一个未达标条目）", () => {
    const running = buildRoleInjections(cfgWithBinding, "train", state(cfgWithBinding, [goal()])).sections.pition_scene;
    expect(running).toContain("「俯卧撑」（2/4 轮）");
  });

  it("未绑库时 core 里给出「去配置」的指路，且 keptTools 补上 pition_boot", () => {
    const r = buildRoleInjections(cfgNoBinding, "log", state(cfgNoBinding));
    expect(r.sections.pition_core).toContain("未绑定");
    expect(r.sections.pition_core).toContain("pition_boot");
    expect(r.keptTools).toContain("pition_boot");

    const bound = buildRoleInjections(cfgWithBinding, "log", state(cfgWithBinding));
    expect(bound.keptTools).not.toContain("pition_boot");
  });

  it("注入内容不出现已废弃的 tool 名与 heartbeat 概念", () => {
    const all = ALL_SCENES.map((s) => {
      const r = buildRoleInjections(cfgWithBinding, s, state(cfgWithBinding, [goal({ missedDays: 3 })]));
      return [...r.guidelines, ...Object.values(r.sections)].join("\n");
    }).join("\n");
    for (const gone of ["pition_stores", "pition_query", "pition_add_entry", "pition_update_latest", "heartbeat"]) {
      expect(all, `注入内容仍提及已废除的 ${gone}`).not.toContain(gone);
    }
  });
});

describe("pruneToolGuidelines（按场景裁剪 tool 足迹）", () => {
  const guidelines = {
    pition_boot: ["boot 约定"],
    pition_write: ["write 约定"],
    pition_goal: ["goal 约定"],
  };

  it("不在白名单里的 tool 被置空（文本摘掉，工具仍可调用）", () => {
    const map = structuredClone(guidelines);
    pruneToolGuidelines(map, ["pition_write"]);
    expect(map).toEqual({ pition_boot: [], pition_write: ["write 约定"], pition_goal: [] });
  });

  it("keptTools 为 undefined（chat 场景）时不裁剪", () => {
    const map = structuredClone(guidelines);
    pruneToolGuidelines(map, undefined);
    expect(map).toEqual(guidelines);
  });

  it("不新增/不删除 key——只改值（兼容 pi 的 { ...base, ...run } 合并）", () => {
    const map: Record<string, string[]> = { pition_read: ["read 约定"] };
    pruneToolGuidelines(map, ["pition_write"]);
    expect(Object.keys(map)).toEqual(["pition_read"]);
  });
});
