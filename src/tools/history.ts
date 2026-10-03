// pition_history 的完整 tool 定义（schema + 描述 + 委托到 runHistory）。
import { Type } from "typebox";
import { runHistory } from "./history-run.ts";
import { QUERY_FILTER_SCHEMA } from "./schemas.ts";

export function defineHistoryTool() {
  return {
    name: "pition_history",
    label: "Pition 查历史 page 列表",
    description: `查当前库的 page 列表（默认按最后编辑时间倒序，可带单字段 filter）。日常记录**不要**用——只有用户翻旧账（「上个月写过什么」）时才调；page 列表对 agent 是显式心智，不是默认背景。`,
    promptSnippet: "pition 翻旧账：列历史 page（可带单字段过滤）",
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
