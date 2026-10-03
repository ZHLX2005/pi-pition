// 助理模式的注入装配：按「场景 + 本轮状态」把内容切成四层 section + 3 条全局 guideline。
//
// 为什么分层（而不是过去的一坨 pition_role + 14 条 guideline）：
//   pition_core    恒定层 —— 库标签 + 工具索引 + 硬边界。短、且内容稳定 → 全场景 cache hit
//   pition_scene   场景层 —— 命中场景才有：按**本轮状态**装配的剧本片段（见 sop.ts）
//   pition_fields  事实层 —— 需要写属性时才有：当前库字段字典（见 fields.ts）
//   pition_runtime 易变层 —— 每轮都变的那几行（现在几点 / 本会话写了什么 / 上一轮报错）
// 过去的问题是「无论用户说什么，14 条准则 + 1.5KB 角色长文全量常驻」——既是 token 开销，
// 也是**误导**（模型看到满屏记录指令就倾向过度落库，role 里那些「不要无脑落库」的补丁
// 本质是在给自己制造的噪音打补丁）。
//
// 易变层单独成段是刻意的：它每轮 diff，不能和 SOP 挤在同一个 section 里——
// 否则 SOP 也跟着每轮重刷 cache。分段的代价只是一个 section 名。
//
// 运行时事实（pition_span / pition_goal）不在这里 —— 它们是程序性上下文（用户在干嘛、
// 今天目标多少），由 role-mode.ts 独立注入，与助理模式开关无关。
//
// 硬约束：只用 `promptGuidelines.push` / `sections[name]`，禁用 `forceSystemPrompt`
// （整段替换 = prompt cache 全 miss，见 .claude/skills/pition-dev/references/C01）。
import { renderFieldDict } from "./fields.ts";
import { assembleLayers, type Layer } from "./injection/index.ts";
import { type PromptState, renderRuntimeSection } from "./prompt-state.ts";
import { renderScene, type SceneId, sceneDef } from "./sop.ts";
import type { Binding, PitionConfig } from "./types.ts";

// tool 足迹裁剪的实现在 `src/injection/prune.ts`（与领域无关的机械），此处再导出一遍
// 是为了保持 `src/role.ts` 作为「pition 注入面」的单一 import 面。
export { pruneToolGuidelines } from "./injection/index.ts";

export interface RoleInjection {
  /** 追加到 rules 层的短句（只放全局的、切场景也不变的部分） */
  guidelines: string[];
  /**
   * 自定义层 section：
   *   pition_core 恒定 / pition_scene 场景 / pition_fields 事实 / pition_runtime 易变
   */
  sections: Record<string, string>;
  /** 该场景保留 promptGuidelines 的 tool 名；undefined = 全部保留（chat 场景不裁剪） */
  keptTools?: string[];
}

/** 恒定层：库标签 + 工具索引 + 硬边界 */
function renderCore(binding: Binding | null): string {
  const store = binding
    ? `【${binding.title}】${binding.description ? ` — ${binding.description}` : ""}`
    : "（未绑定）⚠️ 还没绑定库：要落库先走 pition_boot 配置（流程见配置场景）；pition_goal 冷设置可直接用";
  return [
    "你是 pition 个人管理助手：用户的对话是输入来源，绑定的 Notion 库是持久化存储。",
    `当前库：${store}`,
    "工具索引：pition_write（主路径：属性 append 合并 + 正文追加）· pition_goal（每日目标/进度）· pition_span（计时事件）· pition_read（读当前 page）· pition_history（翻旧账）· pition_create_today（逃生口）· pition_boot（配置）",
    "硬边界：",
    "- 明确的时间锚定 + 具体内容（做了什么/吃了什么/心情如何/感悟什么）→ 落库；闲聊/纯问答/调试代码/解释概念 → 不落库。",
    "- 情绪、心情、感悟、反思都是事实事件，要记。",
    "- 不主动列 page 列表；落库后点明「记到【库名】」让用户能否决。",
    "场景按需注入：pition_scene = 本轮的应对剧本（按状态装配，命中才出现）；pition_runtime = 现在的时刻与本会话已发生的事；需要更细的对话示例再读 skills/（pition-daily-log / pition-goal-coach / pition-setup）。",
  ].join("\n");
}

/** 全局准则：只有这三条在任何场景都成立（其余全部下沉到场景片段） */
export const GLOBAL_GUIDELINES = [
  "**先判场景再行动**：明确的时间锚定 + 具体内容（做了什么/吃了什么/心情如何/感悟什么）→ 落库；闲聊/纯问答/调试代码/解释概念 → 不落库。",
  "**情绪/心情/感悟/反思都是事实事件，要记**——用户是在主动交付内容，别因为「不是事实陈述」漏掉。",
  "不主动列 page 列表（page 心智对日常记录透明）；落库后在回复里点明「记到【库名】」让用户能否决。",
];

/**
 * 兜底注入：装配过程意外抛错时，至少让模型知道「pition 存在、当前库是哪个、剧本没装配上」。
 * 比整轮零注入好——后者会让 agent 完全不知道 pition 的存在。
 */
export function renderFallbackCore(cfg: PitionConfig | null): string {
  const binding =
    cfg?.currentBindingId && cfg.bindings[cfg.currentBindingId] ? cfg.bindings[cfg.currentBindingId] : null;
  return [
    "你是 pition 个人管理助手：用户的对话是输入来源，绑定的 Notion 库是持久化存储。",
    binding ? `当前库：【${binding.title}】` : "当前库：（未绑定）——要落库先调 pition_boot 走配置流程。",
    "⚠️ 本轮场景剧本装配失败（详见 pi 的扩展错误日志）：按各 tool 的 description 谨慎行动，拿不准就先 pition_read / pition_boot stage=done 看现状。",
  ].join("\n");
}

/**
 * 装配本轮注入。
 *
 * @param cfg   当前配置（调用方已 loadConfig 重读，切库后即时生效）
 * @param scene 本轮场景（scene.ts routeScene）
 * @param state 本轮状态快照（prompt-state.ts buildPromptState）——「动态」全靠它
 */
export function buildRoleInjections(_cfg: PitionConfig, scene: SceneId, state: PromptState): RoleInjection {
  const def = sceneDef(scene);

  // 四层按「变化频率」分段（见 src/injection/layers.ts）：恒定 / 场景 / 事实 / 易变。
  // 空正文的层不进结果 —— 缺失的 section 会被 pi 的 diff 自动移除，比注入空串正确。
  const layers: Layer<PromptState>[] = [
    { name: "pition_core", render: (s) => renderCore(s.binding) },
    { name: "pition_scene", render: (s) => renderScene(scene, s) },
    // 未绑定库时字段字典无意义（binding.fields 为空 → renderFieldDict 返回空串）
    {
      name: "pition_fields",
      when: (s) => !!def.fields && !!s.binding,
      render: (s) => (s.binding ? renderFieldDict(s.binding) : ""),
    },
    { name: "pition_runtime", render: (s) => renderRuntimeSection(s) },
  ];

  // 未绑定库时补上 boot 的 guidelines——core 已经指路了，别让 agent 在无指引下摸
  const keptTools = def.tools && !state.configured ? [...def.tools, "pition_boot"] : def.tools;

  return { guidelines: [...GLOBAL_GUIDELINES], sections: assembleLayers(layers, state), keptTools };
}

// `pruneToolGuidelines` 已从 `src/injection/prune.ts` 再导出（见文件头）；
// 宿主探测（`supportsStructuredInjection`）也搬到了 src/injection/host.ts ——
// 现在由内核在每轮开始时统一探测，领域层不再需要自己判。
