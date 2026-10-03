// pition — Notion 个人记录助手扩展（pi 用 jiti 直接加载 TS，无构建步骤）
//
// 本文件是**纯装配层**：把 src/ 里定义好的能力接到 pi。
//   7 个 tool    → src/tools/<name>.ts 的 define*Tool()
//   2 个命令     → /pition（src/wizard.ts）、/pition-mode（src/role-mode.ts）
//   2 个事件订阅 → before_agent_start、session_start（src/role-mode.ts + 此处的重读）
//
// 关键契约（改代码前必读，详见 AGENTS.md / CONTRIBUTING.md）：
//   1. tool 全部**无条件注册**——配置是在会话中现配的，注册期做门禁会导致工具缺失
//   2. 未绑定库时由各 tool 内的 currentBinding() 抛错，指引 agent 去 pition_boot
//   3. 提示词注入只用 promptGuidelines / sections / toolGuidelines 增量，
//      禁用 forceSystemPrompt（整段替换 = cache miss）；**禁止 setActiveTools**（能力不做场景门禁）
//   4. 注入内容按场景分层（src/role.ts + src/scene.ts + src/sop.ts），常驻面有预算门禁
//      （npm run context:check 对 docs/context-budget.json）
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 单一 import 面：pi 扩展只依赖 src/index.ts（barrel），
// 这样内部模块怎么重组都不影响本文件，也给了 knip 一个 src 侧 entry。
import {
  buildBootCtx,
  defineBootTool,
  defineCreateTodayTool,
  defineGoalTool,
  defineHistoryTool,
  defineReadTool,
  defineSpanTool,
  defineWriteTool,
  emptySessionFacts,
  loadConfig,
  type RoleState,
  registerRoleMode,
  registerSetupCommand,
} from "../src/index.ts";

export default function pitionExtension(pi: ExtensionAPI) {
  // 1. 设置命令始终注册——没有配置时这是进入向导的唯一入口
  registerSetupCommand(pi);

  // 2. 助理模式（默认关闭；_assistantMode=true 后启动即生效）
  const initialCfg = loadConfig();
  const roleState: RoleState = {
    enabled: !!(initialCfg?._assistantMode ?? false),
    cfg: initialCfg,
    session: emptySessionFacts(),
  };
  registerRoleMode(pi, roleState);

  // 3. reload 时重读配置（向导保存 / 换库后无需重启）
  pi.on("session_start", async () => {
    const fresh = loadConfig();
    roleState.cfg = fresh;
    roleState.enabled = !!(fresh?._assistantMode ?? false);
  });

  // 4. 7 个 tool 全部无条件注册（见文件头契约 1）
  const setRoleMode = (next: boolean) => {
    roleState.enabled = next;
    roleState.cfg = loadConfig();
  };
  const tools = [
    defineBootTool({ bootCtx: buildBootCtx(roleState.cfg), setRoleMode }),
    defineCreateTodayTool(),
    defineGoalTool(),
    defineReadTool(),
    defineWriteTool(),
    defineHistoryTool(),
    defineSpanTool(),
  ];
  for (const t of tools) pi.registerTool(t as any);
}
