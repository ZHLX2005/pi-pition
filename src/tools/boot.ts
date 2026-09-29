// pition_boot 的实现：5 阶段渐进式配置状态机（token → select_db → describe_fields → set_mode → done）。
// schema 与注册在 extensions/pition.ts；本模块只处理"给定 stage 与参数，改配置并返回给 agent 的文本"。
import { loadConfig, saveConfig } from "../config.ts";
import { listDatabases } from "../databases.ts";
import { notionWith } from "../notion.ts";
import type { Binding, BootParams, FieldMeta, ToolResponse } from "../types.ts";
import { detail, WRITABLE_TYPES } from "../types.ts";

export async function runBoot(params: BootParams): Promise<ToolResponse> {
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
    if (!dbs.length) throw new Error("该 token 看不到任何库——请在 Notion 里把目标库「连接」到这个 integration 后重试");
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
      if ((WRITABLE_TYPES as readonly string[]).includes(type)) merged[n] = knownFields[n] ?? { type, description: "" };
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
    // 运行态同步由调用方负责（extensions/pition.ts 持有 roleState），
    // 这里只通过 details.roleModeChanged 传递信号——避免工具模块反向依赖扩展的闭包。
    // （extensions 会在拿到结果后调用自己的 setRoleMode）
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
}
