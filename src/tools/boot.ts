// pition_boot 的完整 tool 定义（schema + 描述 + 委托到 boot-run.ts 的实现）。
//
// 引导态统一入口：5 阶段渐进式配置（token → select_db → describe_fields → set_mode → done）。
// 任意阶段可中断；已落盘的状态在下一次调用时由 stage 参数定位断点。
//
// 设计契约见 .claude/skills/pition-dev/references/A01-设计理念.md
import { Type } from "typebox";
import { loadConfig } from "../config.ts";
import { runBoot } from "./boot-run.ts";

/** 由扩展在注册时注入的运行态钩子（避免 tool 模块反向依赖扩展闭包） */
interface BootHooks {
  /** 当前配置状态摘要，拼进 description 让 agent 一眼看到现状 */
  bootCtx: string;
  /** set_mode 改盘后同步运行态 roleState */
  setRoleMode: (enabled: boolean) => void;
}

export function defineBootTool(hooks: BootHooks) {
  return {
    name: "pition_boot",
    label: "Pition 元配置（boot）",
    description: `pition 配置引导（引导态统一入口）：按 stage 推进 token → select_db（选库/切空间）→ describe_fields（补字段说明）→ set_mode（助理模式）→ done（查状态）。任意阶段可中断、可只改某一阶段；字段说明落盘后随每轮对话注入。${hooks.bootCtx}`,
    promptSnippet: "pition 配置引导（token / 选库 / 字段说明 / 助理模式）——当前状态直接看它的 description",
    promptGuidelines: [
      "不确定 pition 当前配置状态时，**先看本 tool 的 description 里的「当前状态」段**（token / 库 / 助理模式）——不必先 ping stage=done。",
      "首次配置按 done → token（已有则跳过）→ select_db → describe_fields → set_mode 顺序推进；只改某一阶段产物时直接调对应 stage，不必从 token 重走。",
      "describe_fields 一次性提交该库所有字段的 description：字段说明会随每次对话注入（pition_fields 段），写得越具体 agent 写得越准。",
      "配置完成后用户的写入意图走运行态 tool（pition_write / pition_goal / pition_span…），不要再用 pition_boot。",
    ],
    parameters: Type.Object({
      stage: Type.Union(
        [
          Type.Literal("token"),
          Type.Literal("select_db"),
          Type.Literal("describe_fields"),
          Type.Literal("set_mode"),
          Type.Literal("done"),
        ],
        {
          description:
            "当前推进到的阶段：token=登录校验；select_db=选库（切空间）；describe_fields=补当前库的字段 description；set_mode=切换助理模式；done=查询当前状态",
        },
      ),
      token: Type.Optional(Type.String({ description: "stage=token 时传入 ntn_...；其它阶段忽略" })),
      dbId: Type.Optional(
        Type.String({
          description:
            "stage=select_db 时选定的库 id；stage=describe_fields 必传（要编辑的库 id）；stage=done 可选传 dbId 查指定库覆盖率",
        }),
      ),
      fieldDescriptions: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ description: "字段名（与库 schema 一致）" }),
            description: Type.String({ description: "该字段的用途说明（给 agent 看）" }),
          }),
          { description: "stage=describe_fields 时一次性提交所有字段的 description" },
        ),
      ),
      bindingDescription: Type.Optional(Type.String({ description: "stage=describe_fields 时设置当前库的用途说明" })),
      bindingTitle: Type.Optional(
        Type.String({ description: "可选：覆盖库在 agent 眼中的存储名（默认用 Notion 原标题）" }),
      ),
      enabled: Type.Optional(
        Type.Boolean({ description: "stage=set_mode 时强制设置助理模式开关；缺省或 stage=done 时忽略" }),
      ),
    }),
    async execute(_id: string, params: any) {
      const r = await runBoot(params);
      // set_mode 改了 _assistantMode 落盘；运行态由扩展侧同步
      if (params.stage === "set_mode") {
        hooks.setRoleMode(loadConfig()?._assistantMode ?? false);
      }
      return r;
    },
  };
}
