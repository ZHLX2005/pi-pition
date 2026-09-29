// pition — Notion 个人记录助手扩展（pi 用 jiti 直接加载 TS，无构建步骤）
//
// 本文件是**纯注册层**：把 src/ 里定义的 6 个 tool、2 个命令、2 个事件订阅装配到 pi。
// 业务逻辑一律在 src/ 下（tool 定义在 src/tools/，其余按职责分层）。
//
// 关键契约（改代码前必读，详见 CONTRIBUTING.md）：
//   1. tool 全部**无条件注册**——配置是在会话中现配的，注册期做门禁会导致工具缺失
//   2. 未绑定库时由各 tool 内的 currentBinding() 抛错，指引 agent 去 pition_boot
//   3. 提示词注入只用 promptGuidelines / sections，禁用 forceSystemPrompt（cache miss）
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { buildBootCtx } from "../src/boot-ctx.ts";
import { currentSpans, loadConfig, saveConfig } from "../src/config.ts";
import { buildRoleInjections } from "../src/role.ts";
import { renderSpansStatus } from "../src/span.ts";
import { defineBootTool } from "../src/tools/boot.ts";
import { defineCreateTodayTool } from "../src/tools/create_today.ts";
import { defineHistoryTool } from "../src/tools/history.ts";
import { defineReadTool } from "../src/tools/read.ts";
import { defineSpanTool } from "../src/tools/span.ts";
import { defineWriteTool } from "../src/tools/write.ts";
import type { PitionConfig } from "../src/types.ts";
import { registerSetupCommand } from "../src/wizard.ts";

/** 助理模式运行态：开关 + 最近一次读到的配置 */
interface RoleState {
  enabled: boolean;
  cfg: PitionConfig | null;
}

/** 助理模式注入 + /pition-mode 命令 */
function registerRoleMode(pi: ExtensionAPI, state: RoleState): void {
  pi.on("before_agent_start", async (event) => {
    // 1) 助理模式注入（角色定位 + 行为准则）—— 条件：开关 + 有当前库
    if (state.enabled && state.cfg?.currentBindingId && state.cfg.bindings[state.cfg.currentBindingId]) {
      const { guidelines, sections } = buildRoleInjections(state.cfg);
      for (const g of guidelines) event.systemPromptOptions.promptGuidelines.push(g);
      for (const [name, content] of Object.entries(sections)) {
        event.systemPromptOptions.sections[name] = content;
      }
    }
    // 2) 进行中 span 上下文注入 —— 独立于助理模式（程序性上下文，关了助理模式也要可见）
    const spans = currentSpans();
    if (spans.length) {
      event.systemPromptOptions.sections.pition_span = renderSpansStatus(spans, new Date());
    }
  });

  // 切换开关（落盘化：等价于 pition_boot stage=set_mode 不带 enabled 的 toggle）
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
  // 1. 设置命令始终注册——没有配置时这是进入向导的唯一入口
  registerSetupCommand(pi);

  // 2. 助理模式（默认关闭；_assistantMode=true 后启动即生效）
  const initialCfg = loadConfig();
  const roleState: RoleState = { enabled: !!(initialCfg?._assistantMode ?? false), cfg: initialCfg };
  registerRoleMode(pi, roleState);

  // 3. reload 时重读配置（向导保存 / 换库后无需重启）
  pi.on("session_start", async () => {
    const fresh = loadConfig();
    roleState.cfg = fresh;
    roleState.enabled = !!(fresh?._assistantMode ?? false);
  });

  // 4. 6 个 tool 全部无条件注册（见文件头契约 1）
  const setRoleMode = (next: boolean) => {
    roleState.enabled = next;
    roleState.cfg = loadConfig();
  };
  pi.registerTool(defineBootTool({ bootCtx: buildBootCtx(roleState.cfg), setRoleMode }) as any);
  pi.registerTool(defineCreateTodayTool() as any);
  pi.registerTool(defineReadTool() as any);
  pi.registerTool(defineWriteTool() as any);
  pi.registerTool(defineHistoryTool() as any);
  pi.registerTool(defineSpanTool() as any);
}
