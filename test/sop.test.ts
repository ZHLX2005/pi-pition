import { describe, expect, it } from "vitest";
import { buildPromptState } from "../src/prompt-state.ts";
import { activeFragments, RUNTIME_TOOLS, renderScene, SCENES, type SceneId, sceneDef } from "../src/sop.ts";
import type { ActiveGoal, PitionConfig } from "../src/types.ts";

const SCENE_IDS = Object.keys(SCENES) as SceneId[];
const NOW = new Date(2026, 9, 3, 22, 21, 0);

/** 纯 section 名（片段文案里会引用它们，例如「pition_fields 段」——它们不是 tool） */
const PURE_SECTIONS = new Set(["pition_core", "pition_scene", "pition_fields", "pition_runtime"]);
/** 允许出现在文案里的全部标识符 = tool ∪ section（注意 pition_goal / pition_span 既是 tool 又是 section） */
const KNOWN_TOKENS = new Set<string>([...RUNTIME_TOOLS, ...PURE_SECTIONS]);

const cfg: PitionConfig = {
  token: "t",
  bindings: { d1: { dbId: "d1", title: "库", fields: { Name: { type: "title", description: "标题" } } } },
  currentBindingId: "d1",
};
const cfgEmpty: PitionConfig = { token: "", bindings: {}, currentBindingId: null };

const goal: ActiveGoal = {
  goalId: "g1",
  title: "今日锻炼计划",
  period: "day",
  date: "2026-10-03",
  items: [{ name: "俯卧撑", target: 4, progress: 1, unit: "轮" }],
  createdAt: "2026-10-03T08:00:00.000+08:00",
};

/** 一个状态矩阵：覆盖片段谓词会走到的各种分支 */
const STATES = [
  { name: "unconfigured", cfg: cfgEmpty, goals: [] as ActiveGoal[] },
  { name: "ready-idle", cfg, goals: [] as ActiveGoal[] },
  { name: "goal-running", cfg, goals: [goal] },
  { name: "goal-missed", cfg, goals: [{ ...goal, missedDays: 3 }] },
  { name: "goal-done", cfg, goals: [{ ...goal, items: [{ name: "俯卧撑", target: 4, progress: 4, unit: "轮" }] }] },
].map((s) => ({ ...s, state: buildPromptState({ cfg: s.cfg, now: NOW, goals: s.goals }) }));

/** 片段文案只在 `when` 成立时才会被渲染——测试也照这个契约取值，别越界调用 text() */
function renderedTexts(frag: (typeof SCENES)[SceneId]["fragments"][number]): string[] {
  return STATES.filter((s) => !frag.when || frag.when(s.state)).map((s) =>
    typeof frag.text === "string" ? frag.text : frag.text(s.state),
  );
}

describe("场景 SOP 注册表（状态驱动片段）", () => {
  it("场景 id 与键一致（注册表不自相矛盾）", () => {
    for (const id of SCENE_IDS) expect(SCENES[id].id).toBe(id);
  });

  it("chat 是兜底：无开场、无片段、不裁剪 tool guideline、不注入字段字典", () => {
    expect(SCENES.chat.opening).toBe("");
    expect(SCENES.chat.fragments).toEqual([]);
    expect(SCENES.chat.tools).toBeUndefined();
    expect(SCENES.chat.fields).toBe(false);
  });

  it("每个非 chat 场景都有开场行与片段", () => {
    for (const id of SCENE_IDS) {
      if (id === "chat") continue;
      expect(SCENES[id].opening.length, `${id} 缺开场行`).toBeGreaterThan(5);
      expect(SCENES[id].fragments.length, `${id} 没有片段`).toBeGreaterThan(1);
    }
  });

  it("片段 id 在场景内唯一（排障时才能唯一定位）", () => {
    for (const id of SCENE_IDS) {
      const ids = SCENES[id].fragments.map((f) => f.id);
      expect(new Set(ids).size, `${id} 有重复片段 id`).toBe(ids.length);
    }
  });

  it("未知场景回落 chat（不注入空段）", () => {
    expect(sceneDef("nope" as SceneId).id).toBe("chat");
  });

  it("白名单里的 tool 必须真实存在（拼错 tool 名 = 模型永远看不到它的 guideline）", () => {
    const known = new Set<string>(RUNTIME_TOOLS);
    for (const id of SCENE_IDS) {
      for (const name of SCENES[id].tools ?? []) {
        expect(known.has(name), `场景 ${id} 的白名单含未知 tool：${name}`).toBe(true);
      }
    }
  });

  // 一致性铁律：片段里提到的 tool 必须在自己的白名单里——否则模型照着剧本去调一个
  // guideline 被裁掉的 tool，等于给自己下套（工具仍可调用，但它没被告知怎么用）
  it("片段提到的 tool 必须在该场景白名单内（所有状态下都成立）", () => {
    for (const id of SCENE_IDS) {
      const allowed = SCENES[id].tools;
      if (!allowed) continue; // chat 不裁剪
      for (const frag of SCENES[id].fragments) {
        const mentioned = new Set(
          renderedTexts(frag)
            .join("\n")
            .match(/pition_[a-z_]+/g) ?? [],
        );
        for (const tool of mentioned) {
          if (PURE_SECTIONS.has(tool)) continue; // 提到的是 section 名（如「pition_fields 段」），不是 tool
          expect(allowed, `场景 ${id} 的片段 ${frag.id} 提到 ${tool}，但它不在白名单里`).toContain(tool);
        }
      }
    }
  });

  it("片段里的 pition_xxx 只能是已知 tool 或已知 section 名（防拼错）", () => {
    for (const id of SCENE_IDS) {
      for (const frag of SCENES[id].fragments) {
        for (const token of new Set(
          renderedTexts(frag)
            .join("\n")
            .match(/pition_[a-z_]+/g) ?? [],
        )) {
          expect(
            KNOWN_TOKENS.has(token),
            `场景 ${id} 的片段 ${frag.id} 出现未知标识符 ${token}（拼错了 tool/section 名？）`,
          ).toBe(true);
        }
      }
    }
  });

  it("每个非 chat 场景至少有一个无条件片段（不至于某些状态下整段消失）", () => {
    for (const id of SCENE_IDS) {
      if (id === "chat") continue;
      const always = SCENES[id].fragments.filter((f) => !f.when);
      expect(always.length, `场景 ${id} 的所有片段都带条件——某些状态下会没有任何指引`).toBeGreaterThan(0);
    }
  });

  it("片段不引用已废止的 tool / 已废除的概念", () => {
    const all = SCENE_IDS.flatMap((id) =>
      SCENES[id].fragments.map((f) => (typeof f.text === "string" ? f.text : f.text(STATES[2].state))),
    ).join("\n");
    for (const gone of ["pition_stores", "pition_query", "pition_add_entry", "pition_update_latest", "heartbeat"]) {
      expect(all, `片段仍提及已废除的 ${gone}`).not.toContain(gone);
    }
  });

  it("渲染是纯函数：同一状态两次渲染完全一致（否则提示词每轮都在漂）", () => {
    for (const id of SCENE_IDS) {
      const s = STATES[2].state;
      expect(renderScene(id, s)).toBe(renderScene(id, s));
    }
  });
});

describe("renderScene / activeFragments（状态 → 片段）", () => {
  const stateOf = (name: string) => STATES.find((s) => s.name === name)!.state;

  it("train：没目标时教定计划，有目标时教推进（两个片段集不相交）", () => {
    const idle = activeFragments("train", stateOf("ready-idle"));
    const running = activeFragments("train", stateOf("goal-running"));
    expect(idle).toContain("plan-new");
    expect(running).not.toContain("plan-new");
    expect(running).toContain("goal-running");
    expect(idle).not.toContain("goal-running");
  });

  it("train：断更 ≥2 天才出现自检查片段；全部达标出现庆祝片段", () => {
    expect(activeFragments("train", stateOf("goal-running"))).not.toContain("self-check");
    expect(activeFragments("train", stateOf("goal-missed"))).toContain("self-check");
    expect(activeFragments("train", stateOf("goal-done"))).toContain("goal-all-done");
    expect(activeFragments("train", stateOf("goal-done"))).not.toContain("goal-running");
  });

  it("setup：未配置时给「补 token / 选库」，配置齐了只留「已完整」", () => {
    const empty = activeFragments("setup", stateOf("unconfigured"));
    expect(empty).toContain("no-token");
    expect(empty).toContain("pick-db");
    expect(empty).not.toContain("ready");
    const ready = activeFragments("setup", stateOf("ready-idle"));
    expect(ready).toContain("ready");
    expect(ready).not.toContain("no-token");
  });

  it("recall：只有今天有目标时才提 action=list", () => {
    expect(activeFragments("recall", stateOf("ready-idle"))).not.toContain("goal-progress");
    expect(activeFragments("recall", stateOf("goal-running"))).toContain("goal-progress");
  });

  it("log：上一轮 write 报「没有 page」时才出现逃生口提示", () => {
    const withWarning = buildPromptState({
      cfg,
      now: NOW,
      session: { writes: 0, last: { tool: "pition_write", failed: false, warning: "no_page_in_db", at: "22:18" } },
    });
    expect(activeFragments("log", withWarning)).toContain("no-page-recovery");
    expect(activeFragments("log", stateOf("ready-idle"))).not.toContain("no-page-recovery");
  });

  it("log：本会话已写入过才提示「别重复落库」", () => {
    const wrote = buildPromptState({ cfg, now: NOW, session: { writes: 2 } });
    expect(activeFragments("log", wrote)).toContain("avoid-duplicate");
    expect(renderScene("log", wrote)).toContain("本会话已写入 2 条");
  });

  it("chat 场景渲染为空串（调用方以空判跳过注入）", () => {
    for (const s of STATES) expect(renderScene("chat", s.state)).toBe("");
  });

  it("非 chat 场景的渲染都以开场行开头", () => {
    for (const s of STATES) {
      expect(renderScene("train", s.state)).toContain("【锻炼场景】");
    }
  });
});
