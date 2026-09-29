// /pition 交互式配置向导：登录 token → 选库 → 看结构 → 逐字段补说明 → 保存 + 热重载。
//
// 全流程走 ctx.ui（TUI 或 RPC 的 extension_ui_request 子协议）。
// 任意一步用户取消（ui.input/select/confirm 返回 undefined/false）→ 整次不保存，不留半成品。
import { loadConfig, saveConfig } from "./config.ts";
import { fetchFields, listDatabases } from "./databases.ts";
import { notionWith } from "./notion.ts";
import type { Binding, FieldMeta, PitionConfig } from "./types.ts";

/** 与 ExtensionCommandContext 的最小结构契约（避免为类型引入 pi 运行时依赖） */
interface WizardCtx {
  hasUI: boolean;
  ui: {
    input(title: string, placeholder?: string): Promise<string | undefined>;
    select(title: string, options: string[]): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
  reload(): Promise<void>;
}

async function setupWizard(ctx: WizardCtx): Promise<void> {
  const ui = ctx.ui;
  const cfg = loadConfig() ?? { token: "", bindings: {}, currentBindingId: null };

  // ---- 1. 登录：token ----
  const existing = cfg.token ? `${cfg.token.slice(0, 8)}...${cfg.token.slice(-4)}` : "（未设置）";
  const tokenInput = await ui.input(`Notion integration token（当前: ${existing}，回车跳过）`, "ntn_...");
  if (tokenInput === undefined) return;
  const token = tokenInput.trim() || cfg.token;
  if (!token) {
    ui.notify("没有 token，无法继续", "error");
    return;
  }

  let whoami: any;
  try {
    whoami = await notionWith(token, "GET", "/v1/users/me");
  } catch (e) {
    ui.notify(`token 无效: ${(e as Error).message}`, "error");
    return;
  }
  ui.notify(`已连接工作区「${whoami.bot?.workspace_name ?? "未知"}」`, "info");

  // ---- 2. 选库 ----
  let dbs: Awaited<ReturnType<typeof listDatabases>>;
  try {
    dbs = await listDatabases(token);
  } catch (e) {
    ui.notify(`拉取库列表失败: ${(e as Error).message}`, "error");
    return;
  }
  if (!dbs.length) {
    ui.notify("该 token 看不到任何库——请在 Notion 里把目标库「连接」到这个 integration 后重试", "warning");
    return;
  }

  const boundIds = new Set(Object.keys(cfg.bindings));
  const options = dbs.map((d) => `${d.title}  (${d.fieldCount} 字段)${boundIds.has(d.id) ? " [已绑定]" : ""}`);
  const picked = await ui.select("选择一个要作为存储的库（回车确认）", options);
  if (picked === undefined) return;
  const db = dbs[options.indexOf(picked)];

  if (boundIds.has(db.id)) {
    const again = await ui.confirm("该库已绑定", `「${db.title}」已配置过，重新配置字段说明？`);
    if (!again) return;
  }

  // ---- 3. 看结构 ----
  let fields: Record<string, FieldMeta>;
  try {
    fields = await fetchFields(token, db.id);
  } catch (e) {
    ui.notify(`读取库结构失败: ${(e as Error).message}`, "error");
    return;
  }
  const fieldNames = Object.keys(fields);
  if (!fieldNames.length) {
    ui.notify("该库没有可写字段（可能全是 formula/relation 等计算字段）", "warning");
    return;
  }

  const prev = cfg.bindings[db.id];
  const summary = fieldNames.map((n) => `  ${n} (${fields[n].type})`).join("\n");
  const proceed = await ui.confirm(
    `库「${db.title}」结构（共 ${fieldNames.length} 个可写字段）`,
    `${summary}\n\n接下来逐字段填写用途说明（回车用默认/留空）。是否继续？`,
  );
  if (!proceed) return;

  // ---- 4. 补字段说明 ----
  const boundDescInput = await ui.input(
    `库用途说明（当前: ${prev?.description ?? "无"}）`,
    "例：个人日常记录总表，每天的内容都存这里",
  );
  if (boundDescInput === undefined) return;
  const bindingDesc = boundDescInput.trim() || prev?.description || "";

  for (const name of fieldNames) {
    const prevDesc = prev?.fields?.[name]?.description ?? "";
    const ans = await ui.input(
      `字段「${name}」(${fields[name].type}) 的用途说明`,
      prevDesc || "例：记录标题，一般是当天日期",
    );
    if (ans === undefined) return; // 中途取消 → 整次不保存
    fields[name].description = ans.trim() || prevDesc;
  }

  // ---- 保存 + 热重载 ----
  const newBinding: Binding = { dbId: db.id, title: db.title, description: bindingDesc, fields };
  const finalCfg: PitionConfig = {
    token,
    bindings: { ...cfg.bindings, [newBinding.dbId]: newBinding },
    currentBindingId: cfg.currentBindingId ?? newBinding.dbId,
  };
  try {
    saveConfig(finalCfg);
  } catch (e) {
    ui.notify(`写入配置失败: ${(e as Error).message}`, "error");
    return;
  }

  const hasDesc = fieldNames.filter((n) => fields[n].description).length;
  ui.notify(`已保存「${db.title}」（${hasDesc}/${fieldNames.length} 个字段有说明），重载中…`, "info");
  try {
    await ctx.reload();
  } catch {
    ui.notify("自动重载失败，请手动重启 pi 使新配置生效", "warning");
  }
}

/** 注册 `/pition` 命令（必须无条件注册——未配置时这是进入向导的唯一入口） */
export function registerSetupCommand(pi: {
  registerCommand(
    name: string,
    opts: { description: string; handler: (args: string, ctx: any) => Promise<void> },
  ): void;
}): void {
  pi.registerCommand("pition", {
    description: "配置 pition：登录 Notion → 选库 → 查看结构 → 补字段说明",
    async handler(_args: string, ctx: any) {
      if (!ctx.hasUI) {
        ctx.ui.notify("设置向导需要交互式终端，请在 pi TUI 里运行 /pition", "error");
        return;
      }
      await setupWizard(ctx);
    },
  });
}
