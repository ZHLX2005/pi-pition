// pition_write 的完整 tool 定义（schema + 描述 + 委托到 runWrite）。
import { Type } from "typebox";
import { PROPERTY_ENTRY } from "./schemas.ts";
import { runWrite } from "./write-run.ts";

export function defineWriteTool() {
  return {
    name: "pition_write",
    label: "Pition 写当前 page",
    description: `日常记录的主路径：把属性修改和/或正文内容写到当前库的「当前 page」（按最后编辑时间倒序取 top1，通常就是今天那条由定时任务新建的 page）。默认自动给 appendContent 每段首加 [HH:MM]（本地时间）。如果该库还没有任何 page，本工具返回 warning（不抛错），由 agent 决定是否调 pition_create_today 手动建条——page 列表是定时任务管的，agent 不该主动建。当前库由 pition_boot stage=select_db 选定；要看当前库字段说明先调 pition_boot stage=done。\n\n属性是看版主写入区：multi_select 加 tag 用默认（union）/ number 累加用默认（累加）/ checkbox 用默认（取 OR）——这些"看板维度"反复累加合理；title / select / status / url / email / phone_number 单值字段永远用新值；想要整段覆盖某字段显式传 overwrite:true。返回里附 todaySoFar 直接预览今天该 page 全部内容。`,
    promptGuidelines: [
      "用户在记录今天的内容（日记、打卡、备注、流水、流水消费）时，**优先用 pition_write 追加**，这是日常主路径。",
      "**属性 = 看版**：能写到属性的（multi_select / select / number / checkbox / status）尽量写到属性而不是堆在正文——便于 Notion 看板按维度统计。multi_select 加 tag、number 累加金额/时长、checkbox 打卡用默认 append；status / select 状态切换用 overwrite:true；同一事件的多维度（例：「运动 30 分钟 + 午餐花了 45 元」）一次性写在同一个 pition_write 调用的 properties 数组里。",
      "用户的对话里有「我刚/刚才」时，程序会自动加时间戳，agent 不必手动指定。",
      "如果 pition_write 返回 warning「该库还没有任何 page」，调 pition_create_today 手动建一条（逃生口）。",
      "返回里 todaySoFar 是今天该 page 全部已记内容——写完应在回复里整体预览给用户 + 主动追问更多细节（先记原始再问优化）。",
      "不要调 pition_history 看 page 列表——page 列表心智不属于日常记录。",
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
