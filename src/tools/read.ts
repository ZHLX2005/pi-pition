// pition_read 的完整 tool 定义（schema + 描述 + 委托到 runRead）。
import { Type } from "typebox";
import { runRead } from "./read-run.ts";

export function defineReadTool() {
  return {
    name: "pition_read",
    label: "Pition 读当前 page",
    description: `读当前库的「当前 page」（按最后编辑时间倒序取 top1，通常就是今天那条由定时任务新建的 page）的完整内容：所有 properties + 所有正文 block。agent 不该关心有几个 page、不该遍历——用 pition_history 看历史 page。当前库由 pition_boot stage=select_db 选定；字段名与语义见每轮注入的 pition_fields 段。`,
    promptSnippet: "pition 读当前 page 完整内容（属性 + 全部正文）",
    promptGuidelines: ["用户问「今天写了什么/我刚才记了什么」时调 pition_read。"],
    parameters: Type.Object({}),
    async execute(_id: string, params: any) {
      return runRead(params);
    },
  };
}
