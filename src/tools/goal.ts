// pition_goal 的完整 tool 定义（schema + 描述 + 委托到 runGoal）。
import { Type } from "typebox";
import { runGoal } from "./goal-run.ts";

const AUTO_PERIOD_DESC =
  '自动周期：首次设置即可指定。"daily" 或 5 段 cron（如 "0 6 * * 1,3,5" = 周一三五重开；只消费 日/月/星期字段，时分忽略——goal 粒度是天）';

export function defineGoalTool() {
  return {
    name: "pition_goal",
    label: "Pition 每日目标",
    description: `按天目标管理（锻炼计划等场景）：目标 = 标题 + 可量化条目列表（name/target/unit，如 俯卧撑 4 轮）。5 个 action：set（建；autoPeriod 可指定自动周期 daily/cron；bindField 可绑字段做看板；同日已有须 replace；date 补录历史）/ progress（进度：delta 加法默认 1、value 绝对值、reset 归零，三选一）/ list（列今日）/ update（改条目·绑定·周期，同名条目保留进度）/ delete。今日进度每轮自动注入（实际数字）；自动周期跨天自动归零重开，无需人工重置。未配置 Notion 也可用（冷设置：进度存插件内部）。`,
    promptSnippet: "pition 每日目标 CRUD + 进度推进（做组训练直接 progress）",
    promptGuidelines: [
      "**对话式设置**：用户说想锻炼/定计划 → 先一轮问完（身体情况/倾向/可用时间），给**可量化**方案（每条有数字 target + 单位），用户认可才 action=set；**不传 date**（归属今天）。每天重复的计划问一次 autoPeriod（daily 或 cron「0 6 * * 1,3,5」）。",
      "**推进默认直接 action=progress**：做组/次数/时长型目标与时间无关，用户报完成一组就 progress 一次（秒级）；span 只用于需计时的长任务，且 end 带 goalItemName/goalDelta 时不要再调 progress。",
      "问完成度调 action=list 读真实进度（不凭记忆）；改计划用 update（同名条目保留进度），不想要的用 delete。",
    ],
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("set"),
          Type.Literal("progress"),
          Type.Literal("list"),
          Type.Literal("update"),
          Type.Literal("delete"),
        ],
        { description: "set=建；progress=进度控制（三选一模式）；list=列今日；update=改（不动进度）；delete=删" },
      ),
      title: Type.Optional(Type.String({ description: "action=set/update：目标标题（如「今日锻炼计划」）" })),
      items: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ description: "条目名（如「俯卧撑」）" }),
            target: Type.Number({ description: "目标量（正数，如 4）" }),
            unit: Type.Optional(Type.String({ description: "单位（如「轮」「组」「分钟」）" })),
          }),
          { description: "action=set/update：可量化条目列表（set 必填 ≥1 条；update 同名条目保留进度）" },
        ),
      ),
      autoPeriod: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: `${AUTO_PERIOD_DESC}。update 传 null 清除`,
        }),
      ),
      bindField: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description:
            "action=set/update：绑定当前库的一个字段（进度摘要自动覆写展示，看板直读；未配置 Notion 可不传）。update 传 null 清除",
        }),
      ),
      replace: Type.Optional(
        Type.Boolean({ description: "action=set：同日已有目标时须显式 true 才覆盖（重新规划用）" }),
      ),
      date: Type.Optional(Type.String({ description: "action=set：归属日期 YYYY-MM-DD，缺省今天（补录历史日用）" })),
      goalId: Type.Optional(
        Type.String({
          description: "action=progress/update/delete：定位哪个 goal（省略=今天唯一；多个今日目标时必传）",
        }),
      ),
      itemName: Type.Optional(Type.String({ description: "action=progress/update：推进哪条（按条目名匹配）" })),
      delta: Type.Optional(
        Type.Number({ description: "action=progress：数字加法推进量，默认 1（可负回退）；与 value/reset 互斥" }),
      ),
      value: Type.Optional(Type.Number({ description: "action=progress：绝对值设置（非负）；与 delta/reset 互斥" })),
      reset: Type.Optional(Type.Boolean({ description: "action=progress：归零该条目；与 delta/value 互斥" })),
      note: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: "action=set/update：备注。update 传 null 清除" }),
      ),
    }),
    async execute(_id: string, params: any) {
      return runGoal(params);
    },
  };
}
