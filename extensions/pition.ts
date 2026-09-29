// pition — Notion 个人记录助手扩展（自包含单文件，pi 用 jiti 直接加载 TS，无构建步骤）
//
// 配置：pition.config.json（token / bindings: Record<dbId, Binding> / currentBindingId）。
// 本扩展注册 6 个 agent tool（**全部无条件注册**——配置是在会话中现配的，注册期做门禁
// 会导致工具缺失、必须 /reload。未选库时由 execute 首行 currentBinding() 抛错指引去 pition_boot）：
//   pition_boot        — 元配置：5 阶段渐进式配置（token → 选库 → 补字段说明 → 助理模式开关 → done）
//   pition_write       — 写当前 page 属性 + 追加正文（日常主路径；属性默认 append 合并）
//   pition_read        — 读当前 page 完整内容（属性 + 所有正文 block）
//   pition_span        — 区间事件 start/heartbeat/end（支持并行多事件；进行中注入全局提示词）
//   pition_create_today— 逃生口：定时任务挂了手动建 page（默认不调）
//   pition_history     — 显式查 page 列表（翻旧账用，不是默认心智）
// 字段说明：由 pition_boot stage=done 运行时返回（切库后永远最新），不静态拼进 tool description。
//
// 简单值约定（LLM 只填简单值，本文件负责转 Notion API 格式）：
//   title/rich_text → 字符串；number → 数字；select/multi_select → 选项名字符串（逗号分隔则多选）；
//   checkbox → 布尔；date → "YYYY-MM-DD" 或 ISO；url/email → 字符串

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---- src/ 模块（按职责分层，见 src/ 目录）----
import { currentSpans as currentSpansFrom, loadConfig, saveConfig } from "../src/config.ts";
import { listDatabases } from "../src/databases.ts";
import { notion, notionWith } from "../src/notion.ts";
import {
  blocksToText,
  buildProperties,
  contentToBlocks,
  mergeProperties,
  readPageProperties,
} from "../src/properties.ts";
import { buildRoleInjections } from "../src/role.ts";
import { endSpan, renderSpansStatus, startSpan } from "../src/span.ts";
import { autoFillDateProperty, prefixClockToContent, toDate } from "../src/time.ts";
import type { Binding, FieldMeta, PitionConfig } from "../src/types.ts";
import { detail, WRITABLE_TYPES } from "../src/types.ts";
import { registerSetupCommand } from "../src/wizard.ts";

const PROPERTY_ENTRY = Type.Object(
  {
    name: Type.String({ description: `字段名（必须与下列字段之一完全一致）` }),
    value: Type.Union([Type.String(), Type.Number(), Type.Boolean()], {
      description: "字段值：文本/数字/布尔（类型见 tool description 里的字段说明）",
    }),
    overwrite: Type.Optional(
      Type.Boolean({
        description:
          "默认 false=append 合并：multi_select union 选项、rich_text 拼接「原值 / 新值」、number 累加、date 取更早、checkbox 取 OR；true=整段覆盖。title/select/status/url/email/phone_number 单值字段此参数被忽略，永远是新值。",
      }),
    ),
  },
  { description: "一个字段" },
);

// ---- 字段说明文本（LLM 看的）----

const QUERY_FILTER_SCHEMA = Type.Object(
  {
    field: Type.String({ description: "字段名（必须是该存储已有字段）" }),
    op: Type.Union([Type.Literal("equals"), Type.Literal("contains")], {
      description: "equals=精确匹配，contains=文本包含",
    }),
    value: Type.Union([Type.String(), Type.Boolean(), Type.Number()], {
      description: "比较值（checkbox 用布尔，其余用字符串）",
    }),
  },
  { description: "可选过滤条件（单条件）" },
);

// ============================================================================
// 启动模式：把整个 pi agent 变成 pition 个人管理助手
// 在 before_agent_start 阶段向 systemPromptOptions 注入：
//   - promptGuidelines：行为准则（append 到默认 guideline 后，保留 cache prefix）
//   - sections.pition_role：自定义区段，模型按结构化区段识别
// 不使用 forceSystemPrompt —— 会导致整段替换、prompt cache miss。
// ============================================================================

/** 助理模式运行态：开关 + 最近一次读到的配置 */
interface RoleState {
  enabled: boolean;
  cfg: PitionConfig | null;
}

function registerRoleMode(pi: ExtensionAPI, state: RoleState): void {
  // 每次模型请求前注入（条件：开关 + 有配置）
  pi.on("before_agent_start", async (event) => {
    // 1) 助理模式注入（角色定位 + 行为准则）—— 条件：开关 + 有当前库
    if (state.enabled && state.cfg?.currentBindingId && state.cfg.bindings[state.cfg.currentBindingId]) {
      const { guidelines, sections } = buildRoleInjections(state.cfg);
      for (const g of guidelines) event.systemPromptOptions.promptGuidelines.push(g);
      for (const [name, content] of Object.entries(sections)) {
        event.systemPromptOptions.sections[name] = content;
      }
    }
    // 2) 进行中 span 上下文注入 —— 独立于助理模式（即使助理模式关，span 状态也要可见）
    const spans = currentSpansFrom();
    if (spans.length) {
      event.systemPromptOptions.sections.pition_span = renderSpansStatus(spans, new Date());
    }
  });

  // 切换开关（落盘化：等价于 pition_boot stage=set_mode 不带 enabled 参数的 toggle 行为）
  pi.registerCommand("pition-mode", {
    description: "切换 pition 启动助手模式（开：每次请求把整个 agent 当个人管理助手；关：恢复默认 pi 行为）",
    handler: async (_args, ctx) => {
      const cur = loadConfig();
      const next = !(cur?._assistantMode ?? false);
      const updated: PitionConfig = {
        token: cur?.token ?? "",
        bindings: cur?.bindings ?? {},
        currentBindingId: cur?.currentBindingId ?? null,
        _assistantMode: next,
      };
      try {
        saveConfig(updated);
      } catch (e) {
        ctx.ui.notify(`写入配置失败: ${(e as Error).message}`, "error");
        return;
      }
      state.enabled = next;
      state.cfg = updated;
      ctx.ui.notify(
        `pition 启动助手模式：${next ? "已开启（每次模型请求会注入个人管理助手定位）" : "已关闭（恢复默认 pi 行为）"}（已落盘，重启 pi 保留）`,
        "info",
      );
    },
  });
}

export default function pitionExtension(pi: ExtensionAPI) {
  // 设置命令始终注册——没有配置时这是进入向导的唯一入口
  registerSetupCommand(pi);

  // 启动助手模式：每次模型请求前注入「pition 个人管理助手」定位与行为准则。
  // 默认关闭（首次装完不会被自动注入）；agent 通过 pition_boot stage=set_mode 或 /pition-mode 开启；
  // 配置 _assistantMode=true 后启动即生效；session_start 重读保证 reload 后即时生效。
  const initialCfg = loadConfig();
  const roleState: RoleState = { enabled: !!(initialCfg?._assistantMode ?? false), cfg: initialCfg };
  registerRoleMode(pi, roleState);

  // session_start / reload 时重读配置（向导保存后无需重启；同时刷新 enabled）
  pi.on("session_start", async () => {
    const fresh = loadConfig();
    roleState.cfg = fresh;
    roleState.enabled = !!(fresh?._assistantMode ?? false);
  });

  // boot tool 需要即时改 enabled（无需重启）；暴露 setter 给它
  const setRoleMode = (next: boolean) => {
    roleState.enabled = next;
    roleState.cfg = loadConfig();
  };

  // 启动时拼装 boot_ctx 描述：注入当前 token / 绑定库 / 助理模式状态——
  // agent 第一次看到 boot 工具描述就知道现状，不必先 ping stage=done
  const initialForBoot = roleState.cfg;
  const initBinding = initialForBoot?.currentBindingId
    ? initialForBoot.bindings[initialForBoot.currentBindingId]
    : null;
  const initCoverage = initBinding
    ? `${Object.values(initBinding.fields).filter((f) => f.description).length}/${Object.keys(initBinding.fields).length}`
    : null;
  const bootCtx =
    `\n\n当前状态：\n` +
    `- token: ${initialForBoot?.token ? `已落盘（${initialForBoot.token.slice(0, 8)}...${initialForBoot.token.slice(-4)}）` : "未设置"}` +
    `\n- 库：${initBinding ? `已绑定「${initBinding.title}」${initBinding.description ? `（${initBinding.description}）` : ""}，字段覆盖率 ${initCoverage}` : "未绑定"}` +
    `\n- 助理模式：${initialForBoot?._assistantMode ? "开" : "关"}`;

  // ---------- pition_boot（无条件注册：未配置也能跑 stage=token）----------
  // 引导态的统一入口。设计契约见 references/A01-设计理念.md
  // 阶段：token → 选库 → 加载字段（自动）→ 补字段说明 → 助理模式开关
  // 任意阶段可中断；已落盘的状态在下一次调用时由 stage 参数定位断点
  pi.registerTool({
    name: "pition_boot",
    label: "Pition 元配置（boot）",
    description: `pition 的引导态统一入口：分阶段配置 Notion 集成。5 个阶段 — stage=token 校验并落盘 token；stage=select_db 列库让用户选一个（切空间会保留所有已描述库的字段 desc）；stage=describe_fields 列字段让用户填 description；stage=set_mode 切换助理模式；stage=done 返回当前已绑定库 + 助理模式。${bootCtx}`,
    promptGuidelines: [
      "不确定当前 pition 配置状态时，**直接看本 tool 的 description 里的「当前状态」段**——已含 token / 库 / 助理模式三件概况，不必先 ping stage=done。",
      "用户首次使用 pition 时，按 done → token（已有 token 则跳过）→ select_db → describe_fields → set_mode → done 顺序推进。",
      "用户只改某一阶段的产物时，直接调对应 stage（不必从 token 重走）。",
      "切空间（换库）调 stage=select_db 重新选，**之前库的字段 desc 不会丢**，会在 settings 里自动按 dbId 保留。",
      "boot 完成后，用户的实际写入意图应走 pition_write/pition_read/pition_history/pition_query，不要再用 pition_boot。",
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
    async execute(_id, params) {
      const cfgNow = loadConfig() ?? { token: "", bindings: {}, currentBindingId: null };

      if (params.stage === "token") {
        const existingToken = cfgNow.token || "";
        if (params.token) {
          const t = params.token.trim();
          if (!t) throw new Error("token 不能为空");
          try {
            await notionWith(t, "GET", "/v1/users/me");
          } catch (e) {
            throw new Error(`token 无效: ${(e as Error).message}`);
          }
          saveConfig({ ...cfgNow, token: t });
          const bindingsCount = Object.keys(cfgNow.bindings).length;
          return {
            content: [
              {
                type: "text",
                text: `token 已替换并落盘（已绑定 ${bindingsCount} 个库）。下一步：stage=select_db 列库选择。`,
              },
            ],
            details: detail({ stage: "token", action: "replaced", bindings: bindingsCount }),
          };
        }
        if (existingToken) {
          const masked = `${existingToken.slice(0, 8)}...${existingToken.slice(-4)}`;
          let dbCount = 0;
          try {
            dbCount = (await listDatabases(existingToken)).length;
          } catch {
            /* token 失效不致命 */
          }
          const bindingsCount = Object.keys(cfgNow.bindings).length;
          return {
            content: [
              {
                type: "text",
                text: `pition.config.json 已落盘 token（${masked}），无需重传。可访问库数：${dbCount}（0=token 失效或没把库「连接」到这个 integration）。\n\n下一步：\n- 当前库: ${cfgNow.currentBindingId ? cfgNow.bindings[cfgNow.currentBindingId].title : "（未选）"} → 调 stage=describe_fields 或 stage=done 查看/补字段说明\n- 切空间/换库 → stage=select_db（之前所有库的字段 desc 按 dbId 保留，不丢）\n- 换 token → 再调 stage=token 时显式传新 token 参数\n- 助理模式开关 → stage=set_mode`,
              },
            ],
            details: detail({
              stage: "token",
              action: "already_set",
              tokenSet: true,
              tokenMasked: masked,
              accessibleDbs: dbCount,
              bindings: bindingsCount,
            }),
          };
        }
        throw new Error(
          "stage=token 必须传 token（pition.config.json 没有现存 token）。请用户提供 ntn_... 格式的 Notion integration token。",
        );
      }

      if (params.stage === "select_db") {
        const token = cfgNow.token;
        if (!token) throw new Error("尚未落盘 token，请先 stage=token");
        const dbs = await listDatabases(token);
        if (!dbs.length)
          throw new Error("该 token 看不到任何库——请在 Notion 里把目标库「连接」到这个 integration 后重试");
        // 一次性绑定/切换：用户/agent 选定后下一次调用 stage=describe_fields 时带 dbId
        if (!params.dbId) {
          const list = dbs.map((d) => ({
            id: d.id,
            title: d.title,
            fieldCount: d.fieldCount,
            known: !!cfgNow.bindings[d.id],
            currentDescription: cfgNow.bindings[d.id]
              ? `${Object.values(cfgNow.bindings[d.id].fields).filter((f) => f.description).length}/${Object.keys(cfgNow.bindings[d.id].fields).length}`
              : null,
          }));
          return {
            content: [
              {
                type: "text",
                text:
                  `可选库 ${list.length} 个:\n` +
                  list
                    .map(
                      (d) =>
                        `  - ${d.title} (id=${d.id}, ${d.fieldCount} 字段)${d.known ? ` [已描述过：字段覆盖率 ${d.currentDescription}]` : " [未描述]"}`,
                    )
                    .join("\n") +
                  `\n\n下一步：选定库后调 pition_boot stage=describe_fields dbId=<id> fieldDescriptions=[{name,description},...]\n或直接 pition_boot stage=describe_fields dbId=<id>（会接管现有 desc）。`,
              },
            ],
            details: detail({ stage: "select_db", databases: list }),
          };
        }
        // 显式传 dbId：直接接管（保留已有 desc）+ 切换 currentBindingId
        const dbMeta = await notionWith(token, "GET", `/v1/databases/${params.dbId}`);
        const dbTitle = (dbMeta.title ?? []).map((t: any) => t.plain_text).join("") || "(无标题)";
        const knownFields = cfgNow.bindings[params.dbId]?.fields ?? {};
        const merged: Record<string, FieldMeta> = {};
        for (const [n, p] of Object.entries(dbMeta.properties ?? {})) {
          const type = (p as any).type as string;
          if ((WRITABLE_TYPES as readonly string[]).includes(type))
            merged[n] = knownFields[n] ?? { type, description: "" };
        }
        const newBinding: Binding = {
          dbId: params.dbId,
          title: dbTitle,
          description: cfgNow.bindings[params.dbId]?.description ?? "",
          fields: merged,
        };
        const bindings = { ...cfgNow.bindings, [params.dbId]: newBinding };
        saveConfig({ ...cfgNow, bindings, currentBindingId: params.dbId });
        return {
          content: [
            {
              type: "text",
              text: `已切换当前库为「${newBinding.title}」（id=${params.dbId}），字段类型已自动加载（${Object.keys(merged).length} 个），description 沿用之前的（无 desc 则空）。下一步：stage=describe_fields 补 description。`,
            },
          ],
          details: detail({ stage: "select_db", bound: true, dbId: params.dbId, title: newBinding.title }),
        };
      }

      if (params.stage === "describe_fields") {
        const token = cfgNow.token;
        if (!token) throw new Error("尚未落盘 token，请先 stage=token");
        // 不传 dbId 时默认改当前库
        const targetId = params.dbId ?? cfgNow.currentBindingId;
        if (!targetId) throw new Error("stage=describe_fields 必须传 dbId 或先 stage=select_db 选定当前库");
        const prev = cfgNow.bindings[targetId];
        if (!prev) throw new Error(`库「${targetId}」未在 cfg.bindings 里；先 stage=select_db 选定`);

        if (!params.fieldDescriptions?.length) {
          // 不传 fieldDescriptions → 仅显示当前库覆盖率
          const covered = Object.values(prev.fields).filter((f) => f.description).length;
          const total = Object.keys(prev.fields).length;
          return {
            content: [
              {
                type: "text",
                text: `库「${prev.title}」当前覆盖率 ${covered}/${total}\n  已覆盖: ${
                  Object.entries(prev.fields)
                    .filter(([, m]) => m.description)
                    .map(([n, m]) => `${n}(${m.type})`)
                    .join(", ") || "无"
                }\n  待补: ${
                  Object.entries(prev.fields)
                    .filter(([, m]) => !m.description)
                    .map(([n, m]) => `${n}(${m.type})`)
                    .join(", ") || "无"
                }`,
              },
            ],
            details: detail({
              stage: "describe_fields",
              action: "report",
              dbId: targetId,
              title: prev.title,
              coverage: `${covered}/${total}`,
            }),
          };
        }

        const validNames = new Set(Object.keys(prev.fields));
        const merged: Record<string, FieldMeta> = { ...prev.fields };
        const skipped: string[] = [];
        for (const fd of params.fieldDescriptions) {
          if (!validNames.has(fd.name)) {
            skipped.push(fd.name);
            continue;
          }
          merged[fd.name] = { ...prev.fields[fd.name], description: fd.description };
        }
        if (skipped.length === params.fieldDescriptions.length)
          throw new Error(`fieldDescriptions 全部不在库 schema 里：${skipped.join(", ")}`);

        const newBinding: Binding = {
          ...prev,
          description: params.bindingDescription?.trim() || prev.description || "",
          title: params.bindingTitle?.trim() || prev.title,
          fields: merged,
        };
        const bindings = { ...cfgNow.bindings, [targetId]: newBinding };
        saveConfig({ ...cfgNow, bindings, currentBindingId: cfgNow.currentBindingId ?? targetId });
        const covered = Object.values(newBinding.fields).filter((f) => f.description).length;
        const total = Object.keys(newBinding.fields).length;
        const tail = skipped.length ? `；跳过不在 schema 里的字段：${skipped.join(", ")}` : "";
        return {
          content: [
            {
              type: "text",
              text: `已更新库「${newBinding.title}」字段说明（覆盖率 ${covered}/${total}）${tail}。后续 pition_write/pition_read 等 tool 的字段描述已包含本次更新（下次启动或 reload 生效）。`,
            },
          ],
          details: detail({
            stage: "describe_fields",
            action: "updated",
            dbId: targetId,
            title: newBinding.title,
            coverage: `${covered}/${total}`,
            skipped,
          }),
        };
      }

      if (params.stage === "set_mode") {
        const next = typeof params.enabled === "boolean" ? params.enabled : !(cfgNow._assistantMode ?? false);
        saveConfig({ ...cfgNow, _assistantMode: next });
        setRoleMode(next);
        return {
          content: [
            {
              type: "text",
              text: `pition 助理模式：${next ? "已开启（每次模型请求会注入个人管理助手定位）" : "已关闭（恢复默认 pi 行为）"}（已落盘，重启 pi 保留）。可用 stage=done 再次查询。`,
            },
          ],
          details: detail({ stage: "set_mode", assistantMode: next }),
        };
      }

      // stage === "done"
      const currentBinding = cfgNow.currentBindingId ? cfgNow.bindings[cfgNow.currentBindingId] : null;
      const covered = currentBinding ? Object.values(currentBinding.fields).filter((f) => f.description).length : 0;
      const total = currentBinding ? Object.keys(currentBinding.fields).length : 0;
      const knownIds = Object.keys(cfgNow.bindings);
      return {
        content: [
          {
            type: "text",
            text: `pition 当前状态：\n- token: ${cfgNow.token ? `已落盘（${cfgNow.token.slice(0, 8)}...${cfgNow.token.slice(-4)}）` : "未设置"}\n- 当前库: ${currentBinding ? `「${currentBinding.title}」${currentBinding.description ? `（${currentBinding.description}）` : ""}，字段覆盖率 ${covered}/${total}` : "（未选）"}\n- 助理模式: ${cfgNow._assistantMode ? "开" : "关"}\n- 已描述过的库（dbId 维度）: ${knownIds.length} 个`,
          },
        ],
        details: detail({
          stage: "done",
          tokenSet: !!cfgNow.token,
          currentBindingId: cfgNow.currentBindingId,
          currentBinding: currentBinding ?? undefined,
          knownBindings: knownIds,
          assistantMode: !!(cfgNow._assistantMode ?? false),
        }),
      };
    },
  });

  // 运行态 tool 全部无条件注册——不在工厂期用 cfg 做门禁。
  // 原因：pi 的 registerTool 只在工厂执行期有效，配置完成后（pition_boot stage=select_db）
  // 无法补注册，用户必须 /reload 才看得到。而每轮会话里的配置是用户现配的，没 reload 就永远差工具。
  // 未绑定库时由 currentBinding() 在 execute 首行抛错，agent 收到后自然去调 pition_boot。

  // 运行态 binding 解析器：每次 tool execute 调用都重新 loadConfig 拿 currentBindingId，
  // 不依赖启动时闭包（修复"切库后 pition_history / pition_query 仍查旧库"bug）。
  function currentBinding(): Binding {
    const cfg = loadConfig();
    if (!cfg) throw new Error("pition 未配置（没有 pition.config.json）——调 pition_boot stage=token 开始配置");
    const idx = cfg.currentBindingId;
    if (idx === undefined || idx === null || !cfg.bindings[idx]) {
      throw new Error("pition 没选当前库——调 pition_boot stage=select_db 选一个，或 stage=done 看状态");
    }
    return cfg.bindings[idx];
  }

  // ---------- pition_create_today（逃生口：显式新建 page）----------
  // 默认不调用——page 由 Notion 定时任务每天 0 点自动建。
  // pition_write 找不到"最新 page"时会 warning，由 agent 自行决定是否调这个逃生口。
  pi.registerTool({
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
    async execute(_id, params) {
      const binding = currentBinding();
      const when = toDate(params.timestamp);
      const props = autoFillDateProperty(binding, params.properties, when);
      const page = await notion(null, "POST", "/v1/pages", {
        parent: { database_id: binding.dbId },
        properties: buildProperties(binding, props),
      });
      if (params.content) {
        const bodyText = params.prefixContent === false ? params.content : prefixClockToContent(params.content, when);
        const blocks = contentToBlocks(bodyText);
        await notion(null, "PATCH", `/v1/blocks/${page.id}/children`, { children: blocks });
      }
      return {
        content: [
          {
            type: "text",
            text: `已新建当前 page 到「${binding.title}」: ${page.url}（注意：定时任务可能挂了，请检查 Notion automation）`,
          },
        ],
        details: detail({
          store: binding.title,
          pageId: page.id,
          url: page.url,
          timestamp: when.toISOString(),
          prefixContent: params.prefixContent !== false,
          escape: true,
        }),
      };
    },
  });

  // ---------- pition_read（读当前 page 完整内容）----------
  // 返回当前 page（按最后编辑时间倒序取 top1）的 properties + 所有正文 block。
  // 不返回 list——agent 不该有"page 列表"心智。
  pi.registerTool({
    name: "pition_read",
    label: "Pition 读当前 page",
    description: `读当前库的「当前 page」（按最后编辑时间倒序取 top1，通常就是今天那条由定时任务新建的 page）的完整内容：所有 properties + 所有正文 block。agent 不该关心有几个 page、不该遍历——用 pition_history 看历史 page。当前库由 pition_boot stage=select_db 选定；要看当前库字段说明先调 pition_boot stage=done。`,
    promptGuidelines: ["用户问「今天写了什么/我刚才记了什么」时调 pition_read。"],
    parameters: Type.Object({}),
    async execute() {
      const binding = currentBinding();
      const q = await notion(null, "POST", `/v1/databases/${binding.dbId}/query`, {
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
        page_size: 1,
      });
      const latest = (q.results as any[])[0];
      if (!latest) {
        return {
          content: [
            {
              type: "text",
              text: `存储「${binding.title}」还没有任何 page（warning：定时任务今天可能没建，请确认 Notion automation）。agent 可调 pition_create_today 手动建一条。`,
            },
          ],
          details: detail({ store: binding.title, found: false, warning: "no_page_in_db" }),
        };
      }
      const blocks = await notion(null, "GET", `/v1/blocks/${latest.id}/children?page_size=100`);
      const props: Record<string, unknown> = {};
      for (const [name, p] of Object.entries(latest.properties || {})) {
        const anyProp = p as any;
        if (anyProp.title) props[name] = anyProp.title.map((t: any) => t.plain_text).join("");
        else if (anyProp.rich_text) props[name] = anyProp.rich_text.map((t: any) => t.plain_text).join("");
        else if (anyProp.select) props[name] = anyProp.select?.name ?? null;
        else if (anyProp.multi_select) props[name] = anyProp.multi_select.map((o: any) => o.name).join(", ");
        else if (anyProp.checkbox !== undefined) props[name] = anyProp.checkbox;
        else if (anyProp.number !== undefined) props[name] = anyProp.number;
        else if (anyProp.date) props[name] = anyProp.date?.start ?? null;
        else if (anyProp.status) props[name] = anyProp.status?.name ?? null;
      }
      const content = (blocks.results as any[])
        .map((b) => {
          if (b.type === "paragraph") return b.paragraph.rich_text.map((t: any) => t.plain_text).join("");
          return null;
        })
        .filter(Boolean);
      return {
        content: [{ type: "text", text: JSON.stringify({ properties: props, blocks: content }, null, 2) }],
        details: detail({
          store: binding.title,
          pageId: latest.id,
          url: latest.url,
          lastEdited: latest.last_edited_time,
        }),
      };
    },
  });

  // ---------- pition_write（主路径：改当前 page 的属性 + 追加正文）----------
  // 日常主路径——agent 记录任何事都走它。
  // 找不到"最新 page"时不抛错，只 warning，让 agent 决定是否调 pition_create_today。
  pi.registerTool({
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
    async execute(_id, params) {
      const binding = currentBinding();
      if (!params.properties && !params.appendContent) throw new Error("properties 和 appendContent 至少传一个");
      const when = toDate(params.timestamp);
      const q = await notion(null, "POST", `/v1/databases/${binding.dbId}/query`, {
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
        page_size: 1,
      });
      const latest = (q.results as any[])[0];
      if (!latest) {
        return {
          content: [
            {
              type: "text",
              text: `WARNING: 存储「${binding.title}」还没有任何 page——可能是定时任务没建。Agent 可调 pition_create_today 手动建一条。`,
            },
          ],
          details: detail({ store: binding.title, found: false, warning: "no_page_in_db" }),
        };
      }
      if (params.properties) {
        // 需要先读 page 现有 properties 才能做 append 合并。
        // 全部 overwrite=true 才跳过读；任一 append 都得读。
        const needsMerge = params.properties.some((p) => !p.overwrite);
        const snapshot = needsMerge
          ? readPageProperties(await notion(null, "GET", `/v1/pages/${latest.id}`).then((p: any) => p.properties ?? {}))
          : {};
        const merged = mergeProperties(binding, snapshot, params.properties);
        await notion(null, "PATCH", `/v1/pages/${latest.id}`, { properties: merged });
      }
      if (params.appendContent) {
        const bodyText =
          params.prefixTimestamp === false ? params.appendContent : prefixClockToContent(params.appendContent, when);
        const blocks = contentToBlocks(bodyText);
        await notion(null, "PATCH", `/v1/blocks/${latest.id}/children`, { children: blocks });
      }
      // 写入后立刻读一次 page 全部内容——返回里附 todaySoFar 让模型直接预览 + 追问
      const [pageAfter, blocks] = await Promise.all([
        notion(null, "GET", `/v1/pages/${latest.id}`),
        notion(null, "GET", `/v1/blocks/${latest.id}/children?page_size=100`),
      ]);
      const propsSnapshot = readPageProperties(pageAfter.properties ?? {});
      // 属性按字段说明渲染：field.type/description 加当前值——看板场景下模型拿到能直接复述
      const propsBlock =
        Object.entries(binding.fields)
          .map(([name, meta]) => {
            const v = propsSnapshot[name];
            if (v === undefined || v === null || v === "") return null;
            const vStr = Array.isArray(v) ? v.join(", ") : String(v);
            return `  - ${name} (${meta.type})${meta.description ? ` — ${meta.description}` : ""}: ${vStr}`;
          })
          .filter(Boolean)
          .join("\n") || "  （无）";
      const contentBlock = blocksToText(blocks.results as any[]);
      const todaySoFar = `属性:\n${propsBlock}\n\n正文:\n${contentBlock || "（空）"}`;
      return {
        content: [
          {
            type: "text",
            text: `已写入「${binding.title}」当前 page: ${latest.url}\n\n—— 今日该 page 已记 ——\n${todaySoFar}`,
          },
        ],
        details: detail({
          store: binding.title,
          pageId: latest.id,
          url: latest.url,
          timestamp: when.toISOString(),
          prefixTimestamp: params.prefixTimestamp !== false,
          todaySoFar,
          todayProperties: propsSnapshot,
          todayContent: contentBlock,
        }),
      };
    },
  });

  // ---------- pition_history（显式查 page 列表）----------
  // 默认场景：pition_write / pition_read 已足够。pition_history 留给"翻旧账"。
  pi.registerTool({
    name: "pition_history",
    label: "Pition 查历史 page 列表",
    description: `查当前库的 page 列表（默认按最后编辑时间倒序）。日常记录不需要用——只有用户翻旧账（「上个月写过什么/上周的日记」）时才调。注意：page 列表对 agent 是显式心智，**不是默认背景**。当前库由 pition_boot stage=select_db 选定；要看当前库字段说明先调 pition_boot stage=done。`,
    promptGuidelines: ["用户翻旧账（「上个月/上周/去年的 xxxx 天」）时调 pition_history；不要默认调它。"],
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "返回条数，默认 10，最大 50" })),
      filter: Type.Optional(QUERY_FILTER_SCHEMA),
    }),
    async execute(_id, params) {
      const binding = currentBinding();
      const body: Record<string, unknown> = {
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
        page_size: Math.min(Math.max(params.limit ?? 10, 1), 50),
      };
      if (params.filter) {
        const { field, op, value } = params.filter;
        const meta = binding.fields[field];
        if (!meta)
          throw new Error(
            `存储「${binding.title}」没有字段「${field}」。可用: ${Object.keys(binding.fields).join("、")}`,
          );
        body.filter =
          meta.type === "checkbox"
            ? { property: field, checkbox: { equals: Boolean(value) } }
            : meta.type === "number"
              ? { property: field, number: { equals: Number(value) } }
              : {
                  property: field,
                  [op === "contains" ? "rich_text" : meta.type]: {
                    [op === "contains" ? "contains" : "equals"]: String(value),
                  },
                };
      }
      const data = await notion(null, "POST", `/v1/databases/${binding.dbId}/query`, body);
      const rows = (data.results as any[]).map((page) => {
        const props: Record<string, unknown> = {};
        for (const [name, p] of Object.entries(page.properties || {})) {
          const anyProp = p as any;
          if (anyProp.title) props[name] = anyProp.title.map((t: any) => t.plain_text).join("");
          else if (anyProp.rich_text) props[name] = anyProp.rich_text.map((t: any) => t.plain_text).join("");
          else if (anyProp.select) props[name] = anyProp.select?.name ?? null;
          else if (anyProp.multi_select) props[name] = anyProp.multi_select.map((o: any) => o.name).join(", ");
          else if (anyProp.checkbox !== undefined) props[name] = anyProp.checkbox;
          else if (anyProp.number !== undefined) props[name] = anyProp.number;
          else if (anyProp.date) props[name] = anyProp.date?.start ?? null;
          else if (anyProp.status) props[name] = anyProp.status?.name ?? null;
        }
        return { id: page.id, last_edited: page.last_edited_time, ...props };
      });
      return {
        content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
        details: detail({ store: binding.title, count: rows.length, page_list_kind: true }),
      };
    },
  });

  // ---------- pition_span（区间事件：start / end，支持并行）----------
  // 区间事件：start 时追加到 cfg._activeSpans（不入 Notion），end 时按事件名收尾整段落到当前 page。
  // 可并行多个事件（边养神边听歌是真实生活）。累计时长**不需要心跳**：before_agent_start
  // 每次现算 (now - startedAt)，跨轮次自动增长。
  pi.registerTool({
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
    async execute(_id, params) {
      const binding = currentBinding();
      const cfg = loadConfig();
      if (!cfg) throw new Error("pition 未配置");

      if (params.action === "start") {
        // 状态机在 src/span.ts（纯函数、有单测）——这里只做落盘与文案
        const { cfg: next, span, totalActive } = startSpan(cfg, params.eventName ?? "", params.note);
        saveConfig(next);
        const others = totalActive > 1 ? `（并行中还有 ${totalActive - 1} 件进行中）` : "";
        return {
          content: [
            {
              type: "text",
              text: `📍 已开始「${span.eventName}」${span.note ? `（${span.note}）` : ""}${others}。\n全局提示词的 pition_span section 会持续注入各事件累计时长（实际数字，不是占位符）。结束请调 pition_span action=end。`,
            },
          ],
          details: detail({ action: "start", span, totalActive }),
        };
      }

      // action === "end"：状态机算出正文，这里负责写 Notion + 落盘
      const result = endSpan(cfg, params.eventName, params.note, params.summary);
      const q = await notion(null, "POST", `/v1/databases/${binding.dbId}/query`, {
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
        page_size: 1,
      });
      const latest = (q.results as any[])[0];
      if (latest) {
        await notion(null, "PATCH", `/v1/blocks/${latest.id}/children`, {
          children: [
            {
              object: "block",
              type: "paragraph",
              paragraph: { rich_text: [{ text: { content: result.paragraphText } }] },
            },
          ],
        });
      }
      saveConfig(result.cfg);
      const stillActive = result.stillActive.length
        ? `（仍在进行：${result.stillActive.map((s) => `「${s.eventName}」`).join("、")}）`
        : "";
      return {
        content: [
          {
            type: "text",
            text: `✅ 「${result.span.eventName}」已结束（持续 ${result.elapsedMin} 分钟），已写入「${binding.title}」当前 page。${stillActive}`,
          },
        ],
        details: detail({
          action: "end",
          span: result.span,
          pageId: latest?.id,
          paragraphText: result.paragraphText,
          elapsedMin: result.elapsedMin,
          stillActive: result.stillActive,
        }),
      };
    },
  });
}

// ============================================================================
// /pition 设置向导：登录 token → 选库 → 看结构 → 补字段说明 → 保存热重载
