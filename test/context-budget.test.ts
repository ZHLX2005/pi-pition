// 注入预算门禁的自检：台账口径本身也要被测试（否则门禁可能永远为真 = 一条从没红过的规则）。
import { describe, expect, it } from "vitest";
import {
  BUDGET_CEILINGS,
  BUDGET_FIXTURE_BINDING,
  BUDGET_FIXTURE_NOW,
  BUDGET_FIXTURE_SESSION,
  type BudgetInput,
  buildContextBudget,
  evaluateBudget,
  renderContextBudget,
} from "../src/context-budget.ts";
import { buildPromptState } from "../src/prompt-state.ts";
import { buildRoleInjections, GLOBAL_GUIDELINES } from "../src/role.ts";
import { activeFragments, SCENES, type SceneId } from "../src/sop.ts";
import type { ActiveGoal, PitionConfig } from "../src/types.ts";

const cfg: PitionConfig = {
  token: "t",
  bindings: { [BUDGET_FIXTURE_BINDING.dbId]: BUDGET_FIXTURE_BINDING },
  currentBindingId: BUDGET_FIXTURE_BINDING.dbId,
};

const fixtureGoals: ActiveGoal[] = [
  {
    goalId: "budget-goal",
    title: "今日锻炼计划",
    period: "day",
    date: "2026-10-03",
    autoPeriod: "daily",
    missedDays: 3,
    createdAt: "2026-10-03T08:00:00.000+08:00",
    items: [
      { name: "俯卧撑", target: 4, progress: 2, unit: "轮" },
      { name: "平板支撑", target: 3, progress: 0, unit: "组" },
    ],
  },
];

const tool = (name: string, overrides: Partial<BudgetInput["tools"][number]> = {}) => ({
  name,
  description: "d".repeat(50),
  promptSnippet: `snippet for ${name}`,
  promptGuidelines: ["g".repeat(40)],
  parameters: { type: "object" },
  ...overrides,
});

/** 与 scripts/check-context-budget.mjs 同构：三状态族 × 每场景 */
function fixtureInput(): BudgetInput {
  const families = [
    { suffix: "unconfigured", cfg: { token: "", bindings: {}, currentBindingId: null } as PitionConfig, goals: [] },
    { suffix: "ready", cfg, goals: [] as ActiveGoal[] },
    { suffix: "ready+goal", cfg, goals: fixtureGoals },
  ];
  const scenes = families.flatMap((family) =>
    (Object.keys(SCENES) as SceneId[]).map((id) => {
      const state = buildPromptState({
        cfg: family.cfg,
        now: BUDGET_FIXTURE_NOW,
        session: BUDGET_FIXTURE_SESSION,
        goals: family.goals,
      });
      return {
        id: `${id}@${family.suffix}`,
        sections: buildRoleInjections(family.cfg, id, state).sections,
        keptTools: SCENES[id].tools,
        fragmentIds: activeFragments(id, state),
      };
    }),
  );
  return {
    tools: [tool("pition_boot"), tool("pition_write")],
    skills: [{ root: "skills/x", name: "x", description: "desc" }],
    scenes,
    globalGuidelines: GLOBAL_GUIDELINES,
  };
}

describe("注入预算台账", () => {
  it("常驻面 = 全局 guideline + tool guideline + tool definition + skill 发现条目", () => {
    const s = buildContextBudget(fixtureInput()).surfaces;
    const sum = s.globalGuidelines.bytes + s.toolGuidelines.bytes + s.toolDefinitions.bytes + s.skillsDiscovery.bytes;
    expect(s.ownershipAlwaysOn.bytes).toBe(sum);
    expect(s.toolGuidelines.lines).toBe(2);
    expect(s.toolDefinitions.tools[0].bytes).toBe(
      s.toolDefinitions.tools[0].descriptionBytes + s.toolDefinitions.tools[0].parametersBytes,
    );
  });

  it("台账记下每场景真正出现的片段 id（回答「这段为什么出现」）", () => {
    const scenes = buildContextBudget(fixtureInput()).surfaces.sceneInjections.scenes;
    const trainGoal = scenes.find((s) => s.id === "train@ready+goal");
    expect(trainGoal?.fragments).toContain("goal-running");
    expect(scenes.find((s) => s.id === "train@ready")?.fragments).toContain("plan-new");
  });

  it("确定性：同输入两次得到同一份 JSON（否则 --check 永远在漂移）", () => {
    expect(renderContextBudget(fixtureInput())).toBe(renderContextBudget(fixtureInput()));
  });

  it("渲染结果可解析且带上限声明", () => {
    const parsed = JSON.parse(renderContextBudget(fixtureInput()));
    expect(parsed.formatVersion).toBeGreaterThanOrEqual(1);
    expect(parsed.ceilings.ownershipAlwaysOnBytes).toBe(BUDGET_CEILINGS.ownershipAlwaysOnBytes);
    expect(parsed.ceilings.runtimeBytes).toBe(BUDGET_CEILINGS.runtimeBytes);
  });

  it("按场景统计裁剪效果：白名单外的 tool guideline 不计入该场景", () => {
    const input = fixtureInput();
    input.scenes = [
      { id: "log", sections: { pition_core: "c" }, keptTools: ["pition_write"] },
      { id: "setup", sections: { pition_core: "c" }, keptTools: ["pition_boot"] },
    ];
    const scenes = buildContextBudget(input).surfaces.sceneInjections.toolGuidelines;
    expect(scenes.find((s) => s.id === "log")?.keptTools).toEqual(["pition_write"]);
    expect(scenes.find((s) => s.id === "setup")?.bytes).toBeGreaterThan(0);
    expect(scenes.find((s) => s.id === "log")?.bytes).toBeGreaterThan(0);
  });

  it("当前 fixture 下的真实预算是合规的（门禁不会误报）", () => {
    expect(evaluateBudget(buildContextBudget(fixtureInput()))).toEqual([]);
  });

  it("超上限必须报违规（门禁得真会红）——常驻面", () => {
    const input = fixtureInput();
    input.tools = [tool("pition_boot", { description: "x".repeat(BUDGET_CEILINGS.ownershipAlwaysOnBytes) })];
    expect(evaluateBudget(buildContextBudget(input)).join("\n")).toContain("常驻注入");
  });

  it("超上限必须报违规——场景剧本 / 字段字典 / 易变层", () => {
    const input = fixtureInput();
    input.scenes = [
      {
        id: "log",
        sections: {
          pition_core: "c",
          pition_scene: "s".repeat(BUDGET_CEILINGS.sceneSopBytes + 1),
          pition_fields: "f".repeat(BUDGET_CEILINGS.fieldDictBytes + 1),
          pition_runtime: "r".repeat(BUDGET_CEILINGS.runtimeBytes + 1),
        },
      },
    ];
    const violations = evaluateBudget(buildContextBudget(input)).join("\n");
    expect(violations).toContain("core+剧本+易变层");
    expect(violations).toContain("字段字典");
    expect(violations).toContain("易变层");
  });
});
