// pition_span 的完整 tool 定义（schema + 描述 + 委托到 runSpan）。
import { Type } from "typebox";
import { runSpan } from "./span-run.ts";

export function defineSpanTool() {
  return {
    name: "pition_span",
    label: "Pition 区间事件",
    description: `区间事件管理（类似计时器，支持并行多个）：记录「开始-持续-结束」的事件（开会 / 跑步 / 午休 / 写代码 / 等）。2 个 action：start=开始一段新事件（仅落 cfg，不入 Notion；可同时进行多件事）；end=收尾——把整段 [HH:MM-HH:MM 持续 N 分钟] 事件名 + 备注 拼成一条正文写入当前 page（eventName 精确匹配；省略时若只有一个进行中的 span 则收尾它，多个时报错列出全部）。累计时长由全局提示词的 pition_span section 自动现算注入，无需手动续约。`,
    promptGuidelines: [
      "用户开始/进入一个有时长的事件（「开始跑步」「开始午休」「开始开会」）→ 调 pition_span action=start（带事件名 + 可选备注）。用户开始新事件时**不要**要求先结束旧事件——事件可并行。",
      "进行中的事件（可能多件）会自动出现在全局提示词的 pition_span section（实际时长数字，每次对话自动更新），不需要也不存在 heartbeat 调用。",
      "用户说结束 / 完成 / 出来了 / 感受 → 调 pition_span action=end（带 eventName 精确收尾那件事；事件名 / 备注 / 感受会被合并进正文写入当前 page）。",
      "**不要**用 pition_write 写『开始跑步』或『结束跑步』这类有开始+结束的事件——用 pition_span 记录整段。",
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
    }),
    async execute(_id: string, params: any) {
      return runSpan(params);
    },
  };
}
