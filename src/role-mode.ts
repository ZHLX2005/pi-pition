// 助理模式：before_agent_start 注入 + `/pition-mode` 开关命令。
//
// 注入两件东西（都是「模型看到什么」）：
//   1. 助理模式开启时 → 角色定位 + 行为准则（src/role.ts 生成）
//   2. 有进行中的 span 时 → 区间事件状态（独立于助理模式：这是程序性上下文，
//      关了助理模式也要让模型知道"用户正在做什么"）
//
// 约束：只用 promptGuidelines / sections 增量注入，禁用 forceSystemPrompt（整段替换 = cache miss）。
import { currentSpans, loadConfig, saveConfig } from "./config.ts";
import { buildRoleInjections } from "./role.ts";
import { renderSpansStatus } from "./span.ts";
import type { PitionConfig } from "./types.ts";

/** pi ExtensionAPI 的最小结构契约（只用到 on / registerCommand） */
interface PiLike {
  on(event: string, handler: (event: any) => Promise<void>): void;
  registerCommand(
    name: string,
    opts: { description: string; handler: (args: string, ctx: any) => Promise<void> },
  ): void;
}

/** 助理模式运行态：开关 + 最近一次读到的配置 */
export interface RoleState {
  enabled: boolean;
  cfg: PitionConfig | null;
}

export function registerRoleMode(pi: PiLike, state: RoleState): void {
  pi.on("before_agent_start", async (event) => {
    if (state.enabled && state.cfg?.currentBindingId && state.cfg.bindings[state.cfg.currentBindingId]) {
      const { guidelines, sections } = buildRoleInjections(state.cfg);
      for (const g of guidelines) event.systemPromptOptions.promptGuidelines.push(g);
      for (const [name, content] of Object.entries(sections)) {
        event.systemPromptOptions.sections[name] = content;
      }
    }
    const spans = currentSpans();
    if (spans.length) {
      event.systemPromptOptions.sections.pition_span = renderSpansStatus(spans, new Date());
    }
  });

  // 落盘化 toggle（等价于 pition_boot stage=set_mode；两者共享同一份 cfg）
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
