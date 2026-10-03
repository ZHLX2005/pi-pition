// 注入内核（barrel）—— **与 pition 领域无关**的那一层。
//
// 本目录**不 import 任何 pition 的领域模块**（types/config/notion/goal…），
// 因此可以整个目录复制到另一个 pi 扩展里直接复用。详见 ./README.md。
//
// 各件职责（造新扩展时按这个顺序填）：
//   version.ts   宿主版本下界（单一真相源）
//   host.ts      宿主能力探测（缺 sections 就整体跳过，避免静默零注入）
//   clock.ts     时间锚点（模型不该自己推算日期）
//   facts.ts     tool 结果回流（上一轮的失败/警告要进下一轮提示词）
//   router.ts    场景路由（优先级 + 低信息量粘性）
//   fragments.ts 状态驱动片段（注入内容 = f(状态)）
//   layers.ts    分层装配（按变化频率分段 → 稳定层真的稳定）
//   prune.ts     tool 足迹裁剪（只裁文本，不动可调用工具集）
//   bytes.ts     预算度量原语
//   runtime.ts   一轮编排（探测 → 收敛 → 构造 → 落地 → 降级）+ 三个事件订阅

export {
  type ByteSurface,
  escapeXml,
  lineCount,
  measureGuidelines,
  measureSceneSections,
  renderSkillEntry,
  type SceneMeasure,
  type SkillEntry,
  summed,
  surface,
  utf8Bytes,
} from "./bytes.ts";
export {
  DAY_PART_LABELS,
  hhmm,
  partOfDay,
  type TimeAnchor,
  timeAnchor,
  todayLabel,
  WEEKDAY_LABELS,
  ymd,
} from "./clock.ts";
export {
  applyOutcome,
  emptySessionFacts,
  OUTCOME_SUMMARY_MAX,
  outcomeFromEvent,
  outcomeText,
  type SessionFacts,
  type ToolOutcome,
} from "./facts.ts";
export {
  activeFragmentIds,
  type Fragment,
  renderFragment,
  renderSceneBody,
  type Scene,
} from "./fragments.ts";
export {
  type InjectionHost,
  type SystemPromptOptionsLike,
  structuredGuidelines,
  structuredSections,
  structuredToolGuidelines,
  supportsStructuredInjection,
  unsupportedInjectionNotice,
} from "./host.ts";
export { assembleLayers, type Layer } from "./layers.ts";
export { pruneToolGuidelines } from "./prune.ts";
export { createRouter, isLowInfo, type RouterOptions, type SceneSignal } from "./router.ts";
export {
  createInjectionRuntime,
  emptyRuntimeState,
  type Injection,
  type InjectionRuntime,
  type InjectionSpec,
  type RuntimeState,
  resetRuntimeState,
} from "./runtime.ts";
export { MIN_PI_FOR_STRUCTURED } from "./version.ts";
