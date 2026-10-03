// 注入运行时 —— 把「一轮 before_agent_start 该做什么」的**顺序**固化下来，
// 让新扩展不用再自己拼这套机械（拼错一次就是静默故障）。
//
// 一轮的四步（顺序有讲究）：
//   1. 探测宿主：没有 sections 就整体跳过结构化注入 + 提示一次（见 host.ts）
//   2. 收敛状态：读配置/落盘/算快照 —— 一个入口、每轮一次
//   3. **先全部构造，再统一落地**：构造阶段可能抛（片段渲染 / 配置损坏 / 领域逻辑），
//      落地阶段不会抛。这样要么全注入、要么走降级，绝不会出现「注入了一半」的半成品
//   4. 降级：装配失败时至少写一段最小 core —— 「pition 不存在」比「剧本少一段」糟得多
//
// 另外两个订阅（同属这套机械，别在各扩展里重复实现）：
//   session_start      → 会话事实清零（新会话不该继承「已写入 N 条」，否则会误判重复落库）
//   tool_execution_end → 采集自家 tool 的结果，喂给下一轮状态（见 facts.ts）
import { applyOutcome, emptySessionFacts, outcomeFromEvent, type SessionFacts } from "./facts.ts";
import {
  type InjectionHost,
  structuredGuidelines,
  structuredSections,
  structuredToolGuidelines,
  unsupportedInjectionNotice,
} from "./host.ts";
import { pruneToolGuidelines } from "./prune.ts";
import { MIN_PI_FOR_STRUCTURED } from "./version.ts";

/** 一轮要注入的东西 */
export interface Injection {
  /** 追加到 rules 层的短句（只放恒定事实；场景相关的走 section） */
  guidelines?: string[];
  /** 自定义层 section：名字 → 正文 */
  sections: Record<string, string>;
  /** 保留 promptGuidelines 的 tool 名；undefined = 不裁剪 */
  keptTools?: string[];
}

/** 跨轮的会话级状态（本内核持有并改写它） */
export interface RuntimeState<Id extends string = string> {
  session: SessionFacts;
  /** 上一轮场景（低信息量消息沿用） */
  lastScene?: Id;
  /** 已就「宿主不支持 / 装配失败」提示过（避免每轮刷屏） */
  notified?: boolean;
  /** 上一轮是否走了降级路径（排障用） */
  degraded?: boolean;
}

export function emptyRuntimeState<Id extends string = string>(): RuntimeState<Id> {
  return { session: emptySessionFacts() };
}

/** 会话开始：清空会话级状态（每个会话最多提示一次，所以 notified 也在这里复位） */
export function resetRuntimeState<Id extends string>(state: RuntimeState<Id>): void {
  state.session = emptySessionFacts();
  state.lastScene = undefined;
  state.notified = false;
}

/** 扩展要填的东西：领域相关的部分全部在这里，机械部分由内核负责 */
export interface InjectionSpec<S, Id extends string> {
  /** 扩展名（提示文案用） */
  name: string;
  /** tool 名前缀：`tool_execution_end` 只采集这个前缀的结果 */
  toolPrefix: string;
  /** 计入 `session.writes` 的 tool 名（成功且无 warning 才计）；缺省不计数 */
  countTool?: string;
  /** 场景路由（见 router.ts 的 createRouter） */
  route(prompt: string, prev: Id | undefined): Id;
  /** 每轮构造一次本轮状态（可读配置、可落盘；抛错 → 走降级） */
  buildState(ctx: { prompt: string; session: SessionFacts; now: Date }): S;
  /** 由状态 + 场景装配本轮注入（抛错 → 走降级） */
  build(ctx: { state: S; scene: Id; now: Date }): Injection;
  /** 与场景/开关无关的运行时事实段（有数据就注入，不受总开关影响） */
  runtimeSections?(ctx: { state: S; now: Date }): Record<string, string>;
  /** 总开关（如「助理模式」）；false 时只注入 runtimeSections */
  enabled(): boolean;
  /** 降级注入：装配失败时写的最小内容（state 可能为 null —— buildState 自己就抛了） */
  fallback(ctx: { state: S | null; error: unknown; now: Date }): Injection;
  /** 提示里报的最低宿主版本；缺省 MIN_PI_FOR_STRUCTURED */
  minVersion?: string;
  /** 宿主不支持时的提示文案；缺省用内置文案 */
  unsupportedNotice?(minVersion: string): string;
}

export interface InjectionRuntime {
  /** 跑一轮（可脱离 pi 单测：直接喂 event + ctx） */
  turn(event: unknown, ctx?: unknown): Promise<void>;
  /** 接上 pi：订阅 session_start / tool_execution_end / before_agent_start */
  attach(pi: InjectionHost): void;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 造一个注入运行时。
 *
 * @param spec  领域相关的部分（上面 8 项）
 * @param state 跨轮状态容器（**内核会原地改写它**；一般由扩展的工厂持有）
 */
export function createInjectionRuntime<S, Id extends string>(
  spec: InjectionSpec<S, Id>,
  state: RuntimeState<Id>,
): InjectionRuntime {
  /** 只提示一次：用户可能没有 UI（print/json 模式）——`ctx.ui.notify` 缺失时静默，但标记照置 */
  function notifyOnce(ctx: unknown, message: string): void {
    if (state.notified) return;
    state.notified = true;
    const ui = (ctx as { ui?: { notify?: (m: string, t: string) => void } } | undefined)?.ui;
    ui?.notify?.(message, "warning");
  }

  async function turn(event: unknown, ctx?: unknown): Promise<void> {
    const opts = (event as { systemPromptOptions?: unknown } | undefined)?.systemPromptOptions as
      | { promptGuidelines?: unknown; sections?: unknown; toolGuidelines?: unknown }
      | undefined;
    const sections = structuredSections(opts);
    const toolGuidelines = structuredToolGuidelines(opts);
    const guidelines = structuredGuidelines(opts);
    const prompt = String((event as { prompt?: unknown } | undefined)?.prompt ?? "");
    const now = new Date();
    const enabled = spec.enabled();

    // 旧宿主（pi < 0.86）：不写入任何结构化内容，只提示一次 —— 每轮抛错被错误边界吃掉
    // 会表现为「静默零注入」，那是所有故障里最难查的一类。
    if (enabled && !sections) {
      const minVersion = spec.minVersion ?? MIN_PI_FOR_STRUCTURED;
      notifyOnce(ctx, spec.unsupportedNotice?.(minVersion) ?? unsupportedInjectionNotice(spec.name, minVersion));
    }

    let built: S | null = null;
    try {
      built = spec.buildState({ prompt, session: state.session, now });

      // —— 构造阶段：本轮要注入的东西全部构造出来（此处可能抛）——
      const pushGuidelines: string[] = [];
      const parts: Record<string, string> = {};
      let keptTools: string[] | undefined;

      if (enabled && sections) {
        const scene = spec.route(prompt, state.lastScene);
        state.lastScene = scene;
        const injected = spec.build({ state: built, scene, now });
        pushGuidelines.push(...(injected.guidelines ?? []));
        keptTools = injected.keptTools;
        Object.assign(parts, injected.sections);
      }
      if (spec.runtimeSections) Object.assign(parts, spec.runtimeSections({ state: built, now }));

      // —— 落地阶段：到这里不会再抛，避免「部分注入」的半成品状态 ——
      if (guidelines) for (const g of pushGuidelines) guidelines.push(g);
      if (sections) {
        for (const [name, text] of Object.entries(parts)) sections[name] = text;
        if (toolGuidelines) pruneToolGuidelines(toolGuidelines, keptTools);
      }
      state.degraded = false;
    } catch (e) {
      // 装配失败 ≠ 不该注入：至少让模型知道这个扩展存在、当前状态如何，
      // 否则这一轮在模型眼里就是「扩展不存在」。
      if (enabled && sections) {
        const fb = spec.fallback({ state: built, error: e, now });
        if (guidelines && guidelines.length === 0) for (const g of fb.guidelines ?? []) guidelines.push(g);
        for (const [name, text] of Object.entries(fb.sections)) sections[name] = text;
        notifyOnce(ctx, `${spec.name} 场景剧本装配失败，已降级为最小注入：${errorMessage(e)}`);
      }
      state.degraded = true;
    }
  }

  function attach(pi: InjectionHost): void {
    pi.on("session_start", async () => {
      resetRuntimeState(state);
    });

    pi.on("tool_execution_end", async (event: unknown) => {
      const outcome = outcomeFromEvent({
        event: (event ?? {}) as { toolName?: unknown; result?: unknown; isError?: unknown },
        prefix: spec.toolPrefix,
      });
      if (outcome) state.session = applyOutcome(state.session, outcome, spec.countTool);
    });

    pi.on("before_agent_start", async (event: unknown, ctx?: unknown) => {
      await turn(event, ctx);
    });
  }

  return { turn, attach };
}
