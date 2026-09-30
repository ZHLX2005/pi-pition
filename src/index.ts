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
//   role.ts        助理模式注入内容
//   role-mode.ts   助理模式注入 + /pition-mode 命令
//   boot-ctx.ts    boot 描述的状态摘要
//   wizard.ts      /pition 交互式向导
//   tools/         6 个 tool 的定义（<name>.ts）+ 实现（<name>-run.ts）

export { buildBootCtx } from "./boot-ctx.ts";
// ---- 配置 ----
export { currentBinding, currentGoals, currentSpans, loadConfig, normalizeConfig, saveConfig } from "./config.ts";
export { fetchFields, listDatabases } from "./databases.ts";
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
// ---- Notion IO ----
export { fetchNotion, isNetworkError, notion, notionWith } from "./notion.ts";
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
export { buildRoleInjections } from "./role.ts";
// ---- 命令与上下文 ----
export { type RoleState, registerRoleMode } from "./role-mode.ts";
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
