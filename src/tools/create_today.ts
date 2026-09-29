// pition_create_today 的完整 tool 定义（schema + 描述 + 委托到 runCreateToday）。
import { Type } from "typebox";
import { runCreateToday } from "./create_today-run.ts";
import { PROPERTY_ENTRY } from "./schemas.ts";

export function defineCreateTodayTool() {
  return {
    name: "pition_create_today",
    label: "Pition 手动新建当前 page",
    description: `逃生口：在当前库新建一条 page。默认不调用——page 由 Notion 定时任务每天 0 点自动创建。仅当 pition_write 报「该库还没有任何 page」警告时由 agent 显式调用。properties 必须含 title 字段的值。当前库由 pition_boot stage=select_db 选定；要看当前库字段说明先调 pition_boot stage=done。`,
    promptGuidelines: [
      "仅当 pition_write 返回 warning「该库还没有任何 page」时调用本工具手动建条；agent 切勿主动建 page。",
    ],
    parameters: Type.Object({
      properties: Type.Array(PROPERTY_ENTRY, {
        description: "要写的字段列表（必须含 title 类型字段的值；其它字段会按 pition_write 一样的规则自动回填",
      }),
      content: Type.Optional(Type.String({ description: "正文内容（纯文本段落，可多段用 \\n\\n 分隔）" })),
      timestamp: Type.Optional(
        Type.Union([Type.String(), Type.Number()], { description: "事件时间（ISO 或 Unix ms），默认当前时间" }),
      ),
      prefixContent: Type.Optional(Type.Boolean({ description: "是否给正文段首加 [HH:MM]，默认 true" })),
    }),
    async execute(_id: string, params: any) {
      return runCreateToday(params);
    },
  };
}
