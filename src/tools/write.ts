// pition_write 的完整 tool 定义（schema + 描述 + 委托到 runWrite）。
import { Type } from "typebox";
import { PROPERTY_ENTRY } from "./schemas.ts";
import { runWrite } from "./write-run.ts";

export function defineWriteTool() {
  return {
    name: "pition_write",
    label: "Pition 写当前 page",
    description: `日常记录主路径：把属性修改和/或正文追加写到当前库的「当前 page」（按最后编辑时间倒序取 top1，通常就是定时任务今天新建的那条）。appendContent 默认每段首加 [HH:MM]（本地）；append 合并语义见 overwrite 参数说明；返回 todaySoFar 预览今天该 page 全部内容。该库还没有任何 page 时返回 warning（不抛错）——由 agent 决定是否调 pition_create_today 手动建条。字段名与语义见每轮注入的 pition_fields 段（缺说明时用 pition_boot stage=describe_fields 补）。`,
    promptSnippet: "pition 日常记录主路径：改当前 page 属性（append 合并）+ 追加正文",
    promptGuidelines: [
      "记录用户今天的内容（日记/打卡/流水/心情/感悟）优先用 pition_write——这是日常主路径。",
      "**属性 = 看板**：能进属性的别堆正文（multi_select 标签默认 union、number 金额/时长默认累加、checkbox 打卡默认 OR）；单值字段（title/select/status/url/email/phone_number）永远新值；整段覆盖才传 overwrite:true。同一事件的多个维度一次调用写全，别拆多次。",
      "返回的 todaySoFar 是今天该 page 全部已记内容——在回复里整体预览，并主动追问 1 个自然延伸的细节（先记原始再问优化，不审问）。",
    ],
    parameters: Type.Object({
      properties: Type.Optional(Type.Array(PROPERTY_ENTRY, { description: "要修改的字段列表（只传需要改的）" })),
      appendContent: Type.Optional(
        Type.String({ description: "追加到正文末尾的内容（纯文本段落，可多段用 \\n\\n 分隔）" }),
      ),
      timestamp: Type.Optional(
        Type.Union([Type.String(), Type.Number()], {
          description: "事件时间（ISO 或 Unix ms），默认当前时间。代写历史事件时手动指定。",
        }),
      ),
      prefixTimestamp: Type.Optional(
        Type.Boolean({
          description:
            "是否给 appendContent 每段首加 [HH:MM]，默认 true。追加静态文本/标题/不需要时间锚点的内容时设 false。",
        }),
      ),
    }),
    async execute(_id: string, params: any) {
      return runWrite(params);
    },
  };
}
