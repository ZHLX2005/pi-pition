// pition_history 的完整 tool 定义（schema + 描述 + 委托到 runHistory）。
import { Type } from "typebox";
import { runHistory } from "./history-run.ts";
import { QUERY_FILTER_SCHEMA } from "./schemas.ts";

export function defineHistoryTool() {
  return {
    name: "pition_history",
    label: "Pition 查历史 page 列表",
    description: `查当前库的 page 列表（默认按最后编辑时间倒序）。日常记录不需要用——只有用户翻旧账（「上个月写过什么/上周的日记」）时才调。注意：page 列表对 agent 是显式心智，**不是默认背景**。当前库由 pition_boot stage=select_db 选定；要看当前库字段说明先调 pition_boot stage=done。`,
    promptGuidelines: ["用户翻旧账（「上个月/上周/去年的 xxxx 天」）时调 pition_history；不要默认调它。"],
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "返回条数，默认 10，最大 50" })),
      filter: Type.Optional(QUERY_FILTER_SCHEMA),
    }),
    async execute(_id: string, params: any) {
      return runHistory(params);
    },
  };
}
