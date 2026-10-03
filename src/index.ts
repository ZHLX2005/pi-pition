// pition 的库入口（barrel）：把 src/ 的公开能力集中导出。
//
// 作用有二：
//   1. 给 `extensions/pition.ts` 一个稳定的 import 面（pi 扩展只依赖本文件）
//   2. 给 knip 一个 src 侧的 entry —— 否则 src 内部未被引用的导出不会被上报
//
// 分层（各模块职责，改代码前先定位）：
//   types.ts       领域类型 + WRITABLE_TYPES + detail()
//   config.ts      配置读写、历史格式归一、currentBinding/currentSpans
//   notion.ts      Notion HTTP 客户端（抗抖动重试）
//   databases.ts   库发现与 schema 读取
//   properties.ts  Notion property 编解码 + append 合并
//   time.ts        时间戳 / [HH:MM] 前缀 / 区间格式化
//   span.ts        区间事件状态机
//   goal.ts        每日目标状态机（物化/推进/cron）+ 注入渲染
//   role.ts        按场景分层装配注入（core/scene/fields/runtime）+ tool 足迹裁剪
//   role-mode.ts   助理模式：before_agent_start 注入编排 + 会话事实采集 + /pition-mode 命令
//   scene.ts       场景路由（用户原话 → 场景 id，带粘性）
//   sop.ts         场景 SOP 注册表（**状态驱动的片段**：只注入当下成立的片段）
//   prompt-state.ts 提示词状态快照（时刻/会话事实/目标/字段覆盖）+ 易变层渲染
//   fields.ts      字段字典渲染（当前库可写字段 + append 语义，带预算截断）
//   context-budget.ts  注入预算度量（常驻字节台账，进 npm run check）
//   injection/         **与领域无关的注入内核**（可整目录复制到别的 pi 扩展复用）
//   boot-ctx.ts    boot 描述的状态摘要
//   wizard.ts      /pition 交互式向导
//   tools/         7 个 tool 的定义（<name>.ts）+ 实现（<name>-run.ts）

export { buildBootCtx } from "./boot-ctx.ts";
// ---- 配置 ----
export { currentBinding, currentGoals, currentSpans, loadConfig, normalizeConfig, saveConfig } from "./config.ts";
// ---- 注入面（「模型看到什么」） ----
export {
  BUDGET_CEILINGS,
  BUDGET_FIXTURE_BINDING,
  buildContextBudget,
  type ContextBudget,
  evaluateBudget,
  renderContextBudget,
} from "./context-budget.ts";
export { fetchFields, listDatabases } from "./databases.ts";
export { FIELD_DICT_MAX_CHARS, renderFieldDict } from "./fields.ts";
// ---- 每日目标 ----
export {
  cronMatchesToday,
  deleteGoal,
  goalCompleted,
  goalPercent,
  materializeGoals,
  newGoalId,
  progressGoal,
  renderGoalSummary,
  renderGoalsStatus,
  setGoal,
  todayGoals,
  todayYmd,
  updateGoal,
} from "./goal.ts";
// ---- 注入内核（领域无关，可整体复制到别的扩展） ----
// 用命名空间而不是逐个 re-export：内核里有 partOfDay / applyOutcome / pruneToolGuidelines
// 等与 pition 同名（且语义一致）的导出，摊平会撞名。
export * as injection from "./injection/index.ts";
// ---- Notion IO ----
export { fetchNotion, isNetworkError, notion, notionWith } from "./notion.ts";
// ---- 动态提示词：状态快照 / 场景路由 / 场景剧本 ----
export {
  applyOutcome,
  buildPromptState,
  emptySessionFacts,
  outcomeFromEvent,
  type PromptState,
  partOfDay,
  renderRuntimeSection,
  type SessionFacts,
} from "./prompt-state.ts";
// ---- 领域逻辑 ----
export {
  blocksToText,
  buildProperties,
  contentToBlocks,
  mergeProperties,
  mergePropertyValue,
  readPageProperties,
  toNotionProperty,
} from "./properties.ts";
export { buildRoleInjections, GLOBAL_GUIDELINES, pruneToolGuidelines } from "./role.ts";
// ---- 命令与上下文 ----
export { type RoleState, registerRoleMode } from "./role-mode.ts";
export { routeScene } from "./scene.ts";
export { renderScene, SCENES, type SceneId, type SopFragment, sceneDef } from "./sop.ts";
export { endSpan, newSpanId, renderSpansStatus, startSpan } from "./span.ts";
export {
  autoFillDateProperty,
  clockPrefix,
  formatElapsed,
  formatSpanRange,
  prefixClockToContent,
  toDate,
  toLocalIsoString,
  toYmd,
} from "./time.ts";
// ---- tool 定义 ----
export { defineBootTool } from "./tools/boot.ts";
export { defineCreateTodayTool } from "./tools/create_today.ts";
export { defineGoalTool } from "./tools/goal.ts";
export { defineHistoryTool } from "./tools/history.ts";
export { defineReadTool } from "./tools/read.ts";
export { defineSpanTool } from "./tools/span.ts";
export { defineWriteTool } from "./tools/write.ts";
// ---- 类型 ----
export type {
  ActiveGoal,
  ActiveSpan,
  Binding,
  BootParams,
  CreateTodayParams,
  FieldMeta,
  GoalAutoPeriod,
  GoalItem,
  GoalParams,
  HistoryParams,
  PitionConfig,
  PropertyEntry,
  ReadParams,
  SpanParams,
  ToolResponse,
  WriteParams,
} from "./types.ts";
export { detail, WRITABLE_TYPES } from "./types.ts";
export { registerSetupCommand } from "./wizard.ts";
