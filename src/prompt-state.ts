// 提示词状态快照：把「这一轮模型该知道的动态事实」收敛成一份纯数据，
// 供场景 SOP 片段装配（src/sop.ts）与易变层（pition_runtime）消费。
//
// 为什么需要它 —— 用户反馈「提示词很容易变得静态」：
//   此前注入的 SOP 是**常量长文**：同一个场景下，无论「今天的目标已建好」还是「还没建」，
//   无论「刚写完一条」还是「刚被 Notion 拒了」，模型看到的剧本一模一样。后果有三：
//     1. 一半内容是当下不成立的（还在教怎么 set 一个已经 set 好的目标）
//     2. 该给的锚点没给（模型不知道现在几点、今天几号 —— 线上真出过 set 带未来日期）
//     3. 上一轮的结果不回流（模型不记得刚失败过，会原样再试一次）
//   改成「事实驱动」后：注入内容 = f(状态)，SOP 退化成**带条件的片段**。
//
// 本模块是纯函数（`now` 可注入），所以「同一状态 → 同一提示词」可测、可当预算门禁的输入。
//
// 与领域无关的那一半（时间锚点 / tool 结果回流）在 `src/injection/`，本文件只做
// pition 的适配：tool 前缀、计入 writes 的 tool、warning 码文案。
import { todayGoals } from "./goal.ts";
import {
  applyOutcome as coreApplyOutcome,
  emptySessionFacts as coreEmptySessionFacts,
  outcomeFromEvent as coreOutcomeFromEvent,
  type SessionFacts,
  type ToolOutcome,
  timeAnchor,
} from "./injection/index.ts";
import type { ActiveGoal, ActiveSpan, Binding, PitionConfig } from "./types.ts";

/** 只采集自家 tool 的结果 */
const TOOL_PREFIX = "pition_";
/** 计入「本会话已写入 N 条」的 tool（成功且无 warning 才算） */
const WRITE_TOOL = "pition_write";

/** 最近一次 pition tool 的结果（由 role-mode 从 tool_execution_end 采集） */
export type LastToolOutcome = ToolOutcome;

export type { SessionFacts };

/** 新一轮的会话事实（session_start / 新会话时清零） */
export function emptySessionFacts(): SessionFacts {
  return coreEmptySessionFacts();
}

/** 从 pi 的 `tool_execution_end` 事件里抽一条 pition 结果；非 pition tool 返回 null */
export function outcomeFromEvent(
  event: { toolName?: unknown; result?: unknown; isError?: unknown },
  now: Date = new Date(),
): LastToolOutcome | null {
  return coreOutcomeFromEvent({ event, prefix: TOOL_PREFIX, now });
}

/**
 * 把一条结果并入会话事实。
 * 只有「成功且没有 warning」的 pition_write 才算真的写了一篇（写失败/无 page 不该让模型以为已记）。
 */
export function applyOutcome(session: SessionFacts, outcome: LastToolOutcome): SessionFacts {
  return coreApplyOutcome(session, outcome, WRITE_TOOL);
}

export { partOfDay } from "./injection/index.ts";

/** 渲染进提示词的一轮状态快照 */
export interface PromptState {
  now: Date;
  /** YYYY-MM-DD（本地） */
  today: string;
  /** 「2026年10月3日 周六」 */
  todayLabel: string;
  /** HH:MM */
  clock: string;
  /** 凌晨 / 早上 / 上午 / 中午 / 下午 / 傍晚 / 晚上 */
  partOfDay: string;
  /** 当前绑定库（未绑定为 null） */
  binding: Binding | null;
  /** 字段说明覆盖情况 */
  fields: { total: number; described: number };
  /** 今日目标（已物化；见 role-mode 的跨天物化） */
  goals: ActiveGoal[];
  /** 进行中的区间事件 */
  spans: ActiveSpan[];
  session: SessionFacts;
  /** token + 绑定库都就绪 */
  configured: boolean;
}

/** 组装一轮状态快照（纯函数；cfg 为 null 表示还没配置） */
export function buildPromptState(opts: {
  cfg: PitionConfig | null;
  now?: Date;
  session?: SessionFacts;
  /** 已物化的目标全集（role-mode 在跨天物化后传入）；缺省直接读 cfg._activeGoals */
  goals?: ActiveGoal[];
}): PromptState {
  const now = opts.now ?? new Date();
  const cfg = opts.cfg;
  const binding =
    cfg?.currentBindingId && cfg.bindings[cfg.currentBindingId] ? cfg.bindings[cfg.currentBindingId] : null;
  const fieldEntries = Object.values(binding?.fields ?? {});
  const allGoals = opts.goals ?? cfg?._activeGoals ?? [];
  const anchor = timeAnchor(now);

  return {
    now,
    today: anchor.today,
    todayLabel: anchor.todayLabel,
    clock: anchor.clock,
    partOfDay: anchor.partOfDay,
    binding,
    fields: {
      total: fieldEntries.length,
      described: fieldEntries.filter((f) => f.description).length,
    },
    goals: todayGoals(allGoals, now).list,
    spans: cfg?._activeSpans ?? [],
    session: opts.session ?? emptySessionFacts(),
    configured: !!cfg?.token && !!binding,
  };
}

/** 目标条目里第一个未达标的（用于「下一项建议」这种派生事实） */
export function nextPendingItem(
  goal: ActiveGoal,
): { name: string; progress: number; target: number; unit?: string } | null {
  const pending = goal.items.find((it) => it.progress < it.target);
  return pending
    ? { name: pending.name, progress: pending.progress, target: pending.target, unit: pending.unit }
    : null;
}

/** 目标是否全部达标 */
export function allGoalsDone(goals: ActiveGoal[]): boolean {
  return goals.length > 0 && goals.every((g) => g.items.every((it) => it.progress >= it.target));
}

/** 已知 warning 码 → 给人/模型看的一句话（未知码原样输出，别丢信息） */
const WARNING_LABELS: Record<string, string> = {
  no_page_in_db: "该库还没有任何 page",
};

/**
 * 易变层（`sections.pition_runtime`）：每轮都会变的那几行。
 *
 * 单独成段的原因：它每轮都 diff（时间分钟级变化），把它和 SOP 放一起会让 SOP 也每轮重刷 cache。
 * 分段的代价只是多一个 section 名，收益是「稳定层真正稳定」。
 *
 * 内容纪律：**只放事实，不放建议**——建议属于场景片段（那里才知道该给什么对策），
 * 两边都写就变成重复注入（本项目一直在清理的病）。
 */
export function renderRuntimeSection(state: PromptState): string {
  const lines = [
    `⏱ 现在：${state.todayLabel} ${state.clock} · ${state.partOfDay}（日期/时刻一律以此为准，不要自己推算）`,
  ];

  const facts: string[] = [];
  const last = state.session.last;
  if (state.session.writes > 0) {
    facts.push(`本会话已写入 ${state.session.writes} 条${last ? `（最近 ${last.at}）` : ""}`);
  }
  if (last?.failed) {
    // 失败是偶发态：这行只在真失败后出现，所以带上对策不亏（同一条别原样重试）
    facts.push(`⚠️ 上一轮 ${last.tool} 失败：${last.summary || "未知原因"}——先处理，别原样重试`);
  } else if (last?.warning) {
    const label = WARNING_LABELS[last.warning] ?? last.warning;
    facts.push(`⚠️ 上一轮 ${last.tool} 返回警告：${label}`);
  }
  if (facts.length) lines.push(facts.join("。"));
  return lines.join("\n");
}
