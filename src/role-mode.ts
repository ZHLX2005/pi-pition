// 助理模式：把 pition 的领域逻辑接到通用注入运行时（`src/injection/runtime.ts`）。
//
// 本文件**不再自己实现机械**：会话事实清零、tool 结果采集、宿主探测、构造后统一落地、
// 装配失败降级，全部由 `createInjectionRuntime` 负责（那套顺序踩过坑，别在各扩展里重拼）。
// 这里只填 pition 的领域部分：
//   buildState      每轮一次 loadConfig + 今日目标跨天物化 + 状态快照
//   build           按场景装配四层 section（role.ts）+ tool 足迹裁剪
//   runtimeSections 与场景/开关无关的运行时事实（进行中的 span / 今日目标进度）
//   fallback        装配失败时的最小 core
//
// 为什么每轮都 loadConfig 重读：配置是在会话中现配的（pition_boot），拿启动时的闭包
// 会读到旧库/旧开关。同时目标跨天物化也要落盘，所以这里读+写一次 cfg 就够，别再读第二遍。
import { loadConfig, saveConfig } from "./config.ts";
import { renderGoalsStatus, todayGoals } from "./goal.ts";
import {
  createInjectionRuntime,
  type InjectionHost,
  type InjectionSpec,
  type RuntimeState,
} from "./injection/index.ts";
import { buildPromptState, type PromptState } from "./prompt-state.ts";
import { buildRoleInjections, GLOBAL_GUIDELINES, renderFallbackCore } from "./role.ts";
import { routeScene } from "./scene.ts";
import type { SceneId } from "./sop.ts";
import { renderSpansStatus } from "./span.ts";
import type { PitionConfig } from "./types.ts";

/** pi ExtensionAPI 的最小结构契约（用到 on / registerCommand） */
interface PiLike extends InjectionHost {
  registerCommand(
    name: string,
    opts: { description: string; handler: (args: string, ctx: any) => Promise<void> },
  ): void;
}

/** 支持 `sections` / `toolGuidelines` 的最低 pi 版本（实测：0.85 无、0.86 有） */
export const MIN_PI_FOR_INJECTION = "0.86.0";

/** 助理模式运行态：开关 + 最近一次读到的配置 + 内核持有的会话态 */
export interface RoleState extends RuntimeState<SceneId> {
  enabled: boolean;
  cfg: PitionConfig | null;
}

/** 极简空白配置：完全没装配置（首次使用）时也要能让模型看到「未绑定 + 去配置」的指路 */
const EMPTY_CFG: PitionConfig = { token: "", bindings: {}, currentBindingId: null };

/** pition 的注入规格：领域部分集中在这里，机械部分交给内核 */
function pitionSpec(state: RoleState): InjectionSpec<PromptState, SceneId> {
  return {
    name: "pition",
    toolPrefix: "pition_",
    countTool: "pition_write",
    minVersion: MIN_PI_FOR_INJECTION,
    enabled: () => state.enabled,
    route: (prompt, prev) => routeScene(prompt, prev),

    // 每轮一次：读配置 → 跨天物化目标（要落盘）→ 收敛状态快照
    buildState({ session, now }) {
      const cfg = loadConfig();
      state.cfg = cfg;
      // 今日目标跨天物化**只做一次**（片段渲染与 goal section 共用这一份，且要落盘——
      // 每次对话都是「跨天首读」的机会点，物化不落盘会导致进度记到旧日期实例上）
      const allGoals = (cfg ?? EMPTY_CFG)._activeGoals ?? [];
      const { materialized } = todayGoals(allGoals, now);
      if (cfg && materialized !== allGoals) saveConfig({ ...cfg, _activeGoals: materialized });
      return buildPromptState({ cfg: cfg ?? EMPTY_CFG, session, goals: materialized, now });
    },

    build({ state: promptState, scene }) {
      return buildRoleInjections(state.cfg ?? EMPTY_CFG, scene, promptState);
    },

    // 进行中的区间事件 + 今日目标进度：程序性上下文（「用户在干嘛、今天目标多少」），
    // 与助理模式开关无关——关着也要让模型知道。
    runtimeSections({ state: promptState, now }) {
      const parts: Record<string, string> = {};
      if (promptState.spans.length) parts.pition_span = renderSpansStatus(promptState.spans, now);
      const goalStatus = renderGoalsStatus(promptState.goals, now);
      if (goalStatus) parts.pition_goal = goalStatus;
      return parts;
    },

    // 装配失败：至少让模型知道 pition 存在 + 当前库是哪个 + 剧本没装配上。
    // 错误细节不进提示词（模型改不了代码），由内核的 notify 带给用户。
    fallback() {
      return {
        guidelines: [...GLOBAL_GUIDELINES],
        sections: { pition_core: renderFallbackCore(state.cfg) },
      };
    },
  };
}

export function registerRoleMode(pi: PiLike, state: RoleState): void {
  const runtime = createInjectionRuntime(pitionSpec(state), state);
  runtime.attach(pi);

  // 落盘化 toggle（等价于 pition_boot stage=set_mode；两者共享同一份 cfg）
  pi.registerCommand("pition-mode", {
    description: "切换 pition 启动助手模式（开：每次请求按场景注入个人管理助手定位与剧本；关：恢复默认 pi 行为）",
    handler: async (_args, ctx) => {
      const cur = loadConfig();
      const next = !(cur?._assistantMode ?? false);
      // 展开保留全部字段——不能重建字面量：会丢 _activeSpans / _activeGoals（进行中的 span、目标进度）
      const updated: PitionConfig = {
        token: cur?.token ?? "",
        bindings: cur?.bindings ?? {},
        currentBindingId: cur?.currentBindingId ?? null,
        ...cur,
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
      state.lastScene = undefined; // 重新开启时场景从本轮重新判，不沿用关闭前的粘性
      ctx.ui.notify(
        `pition 启动助手模式：${next ? "已开启（每次模型请求按场景注入助手定位 + 本场景剧本）" : "已关闭（恢复默认 pi 行为）"}（已落盘，重启 pi 保留）`,
        "info",
      );
    },
  });
}
