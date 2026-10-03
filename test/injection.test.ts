// 注入内核（`src/injection/`）的自测 —— 同时充当**新扩展的最小可运行骨架**。
//
// 为什么这个测试存在两重身份：
//   1. 内核是与领域无关的机械，必须能脱离 pition 单测（否则「可复用」只是说法）
//   2. 造新扩展时照抄下面「最小扩展骨架」那一节即可 —— 它把内核的 8 个插槽都填了一遍，
//      且被真实断言过（分层注入 / 场景粘性 / 足迹裁剪 / 结果回流 / 降级 / 旧宿主跳过）
//
// 假 pi 的坑（本项目踩过）：`on` 不能写成 `handlers[event] = handler`（只留最后一个 handler，
// `session_start` 有多个订阅时会被漏掉），必须按注册顺序全部跑。
import { describe, expect, it } from "vitest";
import {
  activeFragmentIds,
  applyOutcome,
  assembleLayers,
  createInjectionRuntime,
  createRouter,
  emptySessionFacts,
  escapeXml,
  type Fragment,
  type InjectionSpec,
  isLowInfo,
  measureSceneSections,
  outcomeFromEvent,
  partOfDay,
  pruneToolGuidelines,
  type RuntimeState,
  renderSceneBody,
  renderSkillEntry,
  structuredSections,
  supportsStructuredInjection,
  type TimeAnchor,
  timeAnchor,
  utf8Bytes,
} from "../src/injection/index.ts";

/** 按注册顺序跑全部 handler 的假 pi（真 pi 的语义） */
function fakePi() {
  const handlers: Record<string, Array<(e: unknown, c?: unknown) => unknown>> = {};
  return {
    on(event: string, handler: (e: unknown, c?: unknown) => unknown): void {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    async fire(event: Record<string, unknown>, ctx?: unknown): Promise<void> {
      for (const h of handlers[String(event.type)] ?? []) await h(event, ctx);
    },
    async beforeAgentStart(prompt: string, opts: Record<string, unknown>, ctx?: unknown): Promise<void> {
      for (const h of handlers.before_agent_start ?? []) await h({ prompt, systemPromptOptions: opts }, ctx);
    },
  };
}

function freshOptions(): {
  promptGuidelines: string[];
  sections: Record<string, string>;
  toolGuidelines: Record<string, string[]>;
} {
  return {
    promptGuidelines: [],
    sections: {},
    toolGuidelines: { snip_save: ["save 的约定"], snip_find: ["find 的约定"] },
  };
}

describe("内核各件（领域无关，可单测）", () => {
  it("host：宿主没有 sections 就判定不支持（不去猜测性创建字段）", () => {
    expect(supportsStructuredInjection({ promptGuidelines: [], sections: {} })).toBe(true);
    expect(supportsStructuredInjection({ promptGuidelines: [] })).toBe(false);
    expect(supportsStructuredInjection(undefined)).toBe(false);
    expect(structuredSections({ promptGuidelines: [], sections: { a: "1" } })).toEqual({ a: "1" });
    expect(structuredSections({ promptGuidelines: [] })).toBeNull();
  });

  it("clock：时间锚点四个派生事实一次算齐", () => {
    const d = new Date(2026, 9, 3, 22, 21, 0);
    const a: TimeAnchor = timeAnchor(d);
    expect(a.today).toBe("2026-10-03");
    expect(a.todayLabel).toBe("2026年10月3日 周六");
    expect(a.clock).toBe("22:21");
    expect(a.partOfDay).toBe("晚上");
    expect(partOfDay(new Date(2026, 9, 3, 7, 0, 0))).toBe("早上");
  });

  it("facts：只采集自家前缀的 tool 结果", () => {
    const at = new Date(2026, 9, 3, 9, 5, 0);
    expect(outcomeFromEvent({ event: { toolName: "other_write" }, prefix: "snip_", now: at })).toBeNull();
    const own = outcomeFromEvent({
      event: { toolName: "snip_save", isError: true, result: { content: [{ type: "text", text: "boom" }] } },
      prefix: "snip_",
      now: at,
    });
    expect(own).toMatchObject({ tool: "snip_save", failed: true, summary: "boom", at: "09:05" });

    // 只有「成功且无 warning」才计入 writes
    const s0 = emptySessionFacts();
    const ok = outcomeFromEvent({ event: { toolName: "snip_save" }, prefix: "snip_" })!;
    const bad = outcomeFromEvent({ event: { toolName: "snip_save", isError: true }, prefix: "snip_" })!;
    expect(applyOutcome(s0, ok, "snip_save").writes).toBe(1);
    expect(applyOutcome(s0, bad, "snip_save").writes).toBe(0);
    expect(applyOutcome(s0, ok).writes).toBe(0); // 没配 countTool 就不计数
  });

  it("router：优先级 + 低信息量粘性", () => {
    const route = createRouter({
      signals: [
        { id: "setup", re: /配置/u },
        { id: "log", re: /记一下/u },
      ],
      fallback: "chat",
      lowInfo: (p) => isLowInfo(p, /^(?:好|继续|嗯)[。!！]?$/u),
    });
    expect(route("帮我配置一下")).toBe("setup");
    expect(route("记一下今天")).toBe("log");
    expect(route("配置记一下")).toBe("setup"); // 同句多命中 → 取更靠前的
    expect(route("好", "log")).toBe("log"); // 粘性
    expect(route("随便聊聊", "log")).toBe("chat");
    expect(route("随便聊聊")).toBe("chat");
  });

  it("fragments：注入内容 = f(状态)，不成立的分支不出现", () => {
    const scene = {
      id: "x",
      opening: "【开场】",
      fragments: [
        { id: "empty", when: (s: { n: number }) => s.n === 0, text: "库是空的" },
        { id: "count", when: (s: { n: number }) => s.n > 0, text: (s: { n: number }) => `已有 ${s.n} 条` },
      ],
    };
    expect(activeFragmentIds(scene, { n: 0 })).toEqual(["empty"]);
    expect(activeFragmentIds(scene, { n: 3 })).toEqual(["count"]);
    expect(renderSceneBody(scene, { n: 3 })).toBe("【开场】\n- 已有 3 条");
    // chat 那种空场景 → 空串（调用方据此跳过注入）
    expect(renderSceneBody({ id: "chat", fragments: [] }, { n: 0 })).toBe("");
  });

  it("layers：空正文的层不进结果（缺失比空串正确）+ 可按状态开关", () => {
    const out = assembleLayers(
      [
        { name: "core", render: () => "恒定" },
        { name: "fields", when: (s: { ready: boolean }) => s.ready, render: () => "字典" },
        { name: "empty", render: () => "" },
      ],
      { ready: false },
    );
    expect(out).toEqual({ core: "恒定" });
  });

  it("prune：只裁文本，不动可调用工具集", () => {
    const map = { a: ["x"], b: ["y"] };
    pruneToolGuidelines(map, ["a"]);
    expect(map).toEqual({ a: ["x"], b: [] });
    pruneToolGuidelines(map, undefined); // undefined = 不裁剪
    expect(map.b).toEqual([]);
  });

  it("内核自洽：不 import 任何内核之外的东西（否则「整目录复制」就悄悄失效）", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL("../src/injection/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const file of files) {
      const src = readFileSync(new URL(file, dir), "utf8");
      const specs = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      for (const spec of specs) {
        expect(spec, `${file} 引用了内核之外的 ${spec}`).toMatch(/^\.\/[a-z]+\.ts$/);
      }
    }
  });

  it("bytes：字节口径与 pi 的 skill 发现条目对齐", () => {
    expect(utf8Bytes("中文")).toBe(6);
    expect(escapeXml("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
    expect(renderSkillEntry({ root: "skills/x", name: "x", description: "d" })).toContain(
      "<location>skills/x/SKILL.md</location>",
    );
    expect(measureSceneSections({ id: "s", sections: { a: "甲乙" } }).bytes).toBe(6);
  });
});

// ————————————————————————————————————————————————————————————————
// 最小扩展骨架：用内核现搭一个「snip（代码片段库）」—— 换领域照抄这一节。
// ————————————————————————————————————————————————————————————————

type SnipScene = "capture" | "lookup" | "chat";

/** 本轮状态快照：时间锚点 + 领域事实 + 会话事实（纯数据，可测） */
interface SnipState {
  anchor: TimeAnchor;
  /** 库里已有多少片段 */
  total: number;
  /** 本会话已存几条（来自结果回流） */
  saved: number;
  lastFailed: boolean;
}

const SNIP_SCENES: Record<SnipScene, { opening: string; fragments: Fragment<SnipState>[]; tools?: string[] }> = {
  capture: {
    opening: "【收藏场景】把这段代码存进片段库。",
    fragments: [
      { id: "first-run", when: (s) => s.total === 0, text: "库还是空的：第一次存会顺手建好分类。" },
      {
        id: "dup-guard",
        when: (s) => s.saved > 0,
        text: (s) => `本会话已存 ${s.saved} 条：同名片段先问覆盖还是新建。`,
      },
      { id: "lang", text: "存之前确认语言（language 字段必填）。" },
    ],
    tools: ["snip_save"],
  },
  lookup: {
    opening: "【查找场景】先检索再回答，别凭记忆编。",
    fragments: [{ id: "grep", text: "关键词优先；找不到就直说没有。" }],
    tools: ["snip_find"],
  },
  chat: { opening: "", fragments: [], tools: undefined },
};

/** 领域侧可变事实（真实扩展里来自配置/远端） */
const store = { total: 0, broken: false };

const snipSpec: InjectionSpec<SnipState, SnipScene> = {
  name: "snip",
  toolPrefix: "snip_",
  countTool: "snip_save",
  enabled: () => true,
  route: createRouter<SnipScene>({
    signals: [
      { id: "lookup", re: /找|搜|之前那段/u },
      { id: "capture", re: /存|收藏|这段代码/u },
    ],
    fallback: "chat",
    lowInfo: (p) => isLowInfo(p, /^(?:好|继续|嗯)[。!！]?$/u),
  }),
  buildState({ session, now }) {
    if (store.broken) throw new Error("领域数据损坏");
    return {
      anchor: timeAnchor(now),
      total: store.total,
      saved: session.writes,
      lastFailed: session.last?.failed === true,
    };
  },
  build({ state, scene }) {
    const def = SNIP_SCENES[scene];
    return {
      guidelines: ["snip：代码片段来自对话，别把整段日志当片段存。"],
      sections: assembleLayers<SnipState>(
        [
          { name: "snip_core", render: (s) => `snip 代码片段库（共 ${s.total} 条）。` },
          { name: "snip_scene", render: (s) => renderSceneBody({ id: scene, ...def }, s) },
          {
            name: "snip_runtime",
            render: (s) =>
              `⏱ ${s.anchor.todayLabel} ${s.anchor.clock}${s.lastFailed ? " · ⚠️ 上一轮失败，别原样重试" : ""}`,
          },
        ],
        state,
      ),
      keptTools: def.tools,
    };
  },
  // 与场景/开关无关的运行时事实（有数据就注入）
  runtimeSections: ({ state }): Record<string, string> =>
    state.total > 0 ? { snip_pin: `📌 置顶片段：${state.total} 条待整理` } : {},
  fallback: () => ({
    guidelines: ["snip 剧本装配失败：按 tool description 谨慎行动。"],
    sections: { snip_core: "snip 装配失败，已降级为最小注入。" },
  }),
};

function mountSnip(): { pi: ReturnType<typeof fakePi>; state: RuntimeState<SnipScene> } {
  const pi = fakePi();
  const state: RuntimeState<SnipScene> = { session: emptySessionFacts() };
  createInjectionRuntime(snipSpec, state).attach(pi);
  return { pi, state };
}

describe("内核端到端：一个最小扩展（snip）", () => {
  it("分层注入：core 恒定 / scene 随状态 / runtime 易变，三段都在", async () => {
    const { pi } = mountSnip();
    const opts = freshOptions();
    await pi.beforeAgentStart("帮我把这段代码存起来", opts);

    expect(opts.promptGuidelines).toHaveLength(1);
    expect(Object.keys(opts.sections).sort()).toEqual(["snip_core", "snip_runtime", "snip_scene"]);
    expect(opts.sections.snip_scene).toContain("库还是空的"); // total=0 → first-run 命中
    expect(opts.sections.snip_scene).not.toContain("本会话已存"); // saved=0 → dup-guard 不出现
    expect(opts.sections.snip_runtime).toContain("⏱");
  });

  it("状态变了注入就变（不是静态提示词）", async () => {
    const { pi } = mountSnip();
    const before = freshOptions();
    await pi.beforeAgentStart("帮我把这段代码存起来", before);
    expect(before.sections.snip_scene).toContain("库还是空的");

    store.total = 12;
    const after = freshOptions();
    await pi.beforeAgentStart("帮我把这段代码存起来", after);
    expect(after.sections.snip_scene).not.toContain("库还是空的");
    expect(after.sections.snip_core).toContain("共 12 条");
    // 运行时事实段与场景开关无关
    expect(after.sections.snip_pin).toContain("待整理");
    store.total = 0;
  });

  it("场景粘性：低信息量消息沿用上一场景，而不是跌回 chat", async () => {
    const { pi, state } = mountSnip();
    const opts = freshOptions();
    await pi.beforeAgentStart("帮我找一下之前的排序片段", opts);
    expect(opts.sections.snip_scene).toContain("查找场景");
    expect(state.lastScene).toBe("lookup");

    const followUp = freshOptions();
    await pi.beforeAgentStart("好", followUp);
    expect(followUp.sections.snip_scene).toContain("查找场景");
  });

  it("tool 足迹裁剪：不相关 tool 的 guideline 被摘，工具本身仍在", async () => {
    const { pi } = mountSnip();
    const opts = freshOptions();
    await pi.beforeAgentStart("帮我找一下之前的排序片段", opts);
    expect(opts.toolGuidelines.snip_find).toEqual(["find 的约定"]);
    expect(opts.toolGuidelines.snip_save).toEqual([]);
  });

  it("tool 结果回流：上一轮失败进下一轮易变层", async () => {
    const { pi } = mountSnip();
    await pi.fire({
      type: "tool_execution_end",
      toolName: "snip_save",
      isError: true,
      result: { content: [{ type: "text", text: "写入失败" }] },
    });
    const opts = freshOptions();
    await pi.beforeAgentStart("再存一次", opts);
    expect(opts.sections.snip_runtime).toContain("⚠️ 上一轮失败");
  });

  it("session_start 清零会话事实（新会话不该继承「已存 N 条」）", async () => {
    const { pi, state } = mountSnip();
    await pi.fire({
      type: "tool_execution_end",
      toolName: "snip_save",
      result: { content: [{ type: "text", text: "已存" }] },
    });
    expect(state.session.writes).toBe(1);

    const opts = freshOptions();
    await pi.beforeAgentStart("再存一段", opts);
    expect(opts.sections.snip_scene).toContain("本会话已存 1 条");

    await pi.fire({ type: "session_start", reason: "new" });
    expect(state.session.writes).toBe(0);
    const after = freshOptions();
    await pi.beforeAgentStart("再存一段", after);
    expect(after.sections.snip_scene).not.toContain("本会话已存");
  });

  it("宿主不支持（无 sections）：不写入任何结构化内容 + 只提示一次", async () => {
    const { pi } = mountSnip();
    const legacy = { promptGuidelines: [] as string[] };
    const notices: string[] = [];
    const ctx = { ui: { notify: (m: string) => notices.push(m) } };

    await pi.beforeAgentStart("存一段代码", legacy, ctx);
    await pi.beforeAgentStart("存一段代码", legacy, ctx);

    expect(legacy.promptGuidelines).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("0.86");
  });

  it("装配失败：只写最小 core，不留半成品（场景/易变段一个都不出现）", async () => {
    const { pi, state } = mountSnip();
    const opts = freshOptions();
    const notices: string[] = [];
    store.broken = true;
    try {
      await pi.beforeAgentStart("存一段代码", opts, { ui: { notify: (m: string) => notices.push(m) } });
    } finally {
      store.broken = false;
    }
    expect(opts.sections.snip_core).toContain("降级");
    expect(opts.sections.snip_scene).toBeUndefined();
    expect(opts.sections.snip_runtime).toBeUndefined();
    expect(opts.promptGuidelines).toHaveLength(1); // 兜底准则补上
    expect(state.degraded).toBe(true);
    expect(notices[0]).toContain("降级");
  });
});
