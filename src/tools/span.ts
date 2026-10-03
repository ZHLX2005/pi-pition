// pition_span 的完整 tool 定义（schema + 描述 + 委托到 runSpan）。
import { Type } from "typebox";
import { runSpan } from "./span-run.ts";

export function defineSpanTool() {
  return {
    name: "pition_span",
    label: "Pition 区间事件",
    description: `区间事件（计时器，支持并行多个）：start=开始一段事件（仅落 cfg，不入 Notion）；end=收尾——把整段 [HH:MM-HH:MM 持续 N 秒] 事件名 + 备注/感受拼成一条正文写进当前 page（eventName 精确匹配；只有唯一进行中事件时才可省略）。进行中事件与实时时长由 pition_span section 自动注入。`,
    promptSnippet: "pition 计时事件：start 开始 / end 收尾（整段写进 page，可联动 goal 进度）",
    promptGuidelines: [
      "**只在需计时的长任务**（跑步/散步/爬山/球类/开会/午休）用 span：用户说「开始 xx」→ action=start（带事件名 + 可选备注）；说「结束/做完了」→ action=end 收尾。做组训练（俯卧撑 N 组）与时间无关，直接 pition_goal action=progress。",
      "start 时不要要求先结束旧事件——**span 可并行**；进行中的事件由 pition_span section 自动注入实际时长（无需任何续约调用）。",
      "刚结束的正是今日目标条目 → end 带 goalItemName + goalDelta 一次完成收尾 + 推进；带了就不要再调 pition_goal action=progress（重复推进）。不要用 pition_write 写「开始跑步」这类事件。",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("end")], {
        description: "start=开新 span（可并行）；end=收尾指定 span 并写入 Notion",
      }),
      eventName: Type.Optional(
        Type.String({
          description: "事件名（action=start 必填；action=end 按事件名精确收尾，省略时仅一个 span 才行）",
        }),
      ),
      note: Type.Optional(Type.String({ description: "可选备注（action=start 时设定；end 时可补充感受/收尾说明）" })),
      summary: Type.Optional(Type.String({ description: "action=end 时可选：事后总结/感受/结果，合并进正文" })),
      goalItemName: Type.Optional(
        Type.String({
          description:
            "action=end 可选：今日目标条目名——收尾后把 goalDelta 加到该条目进度（数字加法）。end 不结束 goal，只推进。",
        }),
      ),
      goalDelta: Type.Optional(Type.Number({ description: "action=end 可选：goalItemName 的推进量，默认 1" })),
    }),
    async execute(_id: string, params: any) {
      return runSpan(params);
    },
  };
}
