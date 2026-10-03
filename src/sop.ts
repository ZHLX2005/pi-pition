// 场景 SOP 注册表 —— 「哪个场景、在什么状态下、注入哪段剧本」的唯一真相源。
//
// 三层演进（本文件是第三层）：
//   1. skill 文件（skills/*.md）：靠 description 路由 + **模型主动读文件**，命中率看自觉，
//      且读全文是一次额外往返、全文进上下文（不可裁剪）
//   2. 场景剧本常量（v0.5.0 第一版）：按 `event.prompt` 直接注入某场景的**固定长文**
//   3. **状态驱动的片段（本版）**：剧本拆成带 `when(state)` 谓词的片段，
//      注入内容 = f(本轮真实状态) —— 不成立的分支不出现，出现的分支带真实数字
//
// 为什么第 2 层不够（用户反馈「提示词很容易变得静态」）：固定长文必然包含当下不成立的内容
// （对已建好的目标还在教怎么 set），也无法带出「下一项该做什么」这种派生事实。
//
// 与 skills/*.md 的分工（改场景流程时三处都要改：fragment / scene 触发 / skill 正文）：
//   src/sop.ts       注入用片段（每片段 1-3 行，只在该状态成立时出现）
//   skills/*.md      完整版（对话示例、细粒度描述），pi 原生分发 + `/skill:xxx` 显式深读
//
// 每个场景还声明两件事：
//   tools  —— 该场景下**保留 promptGuidelines** 的 tool（不在集合里的 tool 只裁掉
//             它的 guideline 文本，工具本身依然可调用——能力不做场景门禁，见 role.ts）
//   fields —— 是否注入当前库的字段字典（pition_fields section）
//
// 与领域无关的机械（片段谓词求值 / 按状态渲染）在 `src/injection/fragments.ts`，
// 本文件只留 pition 的场景内容 —— 换一个领域照抄本文件即可（见 src/injection/README.md）。
import { activeFragmentIds, type Fragment, renderSceneBody, type Scene } from "./injection/index.ts";
import { allGoalsDone, nextPendingItem, type PromptState } from "./prompt-state.ts";

/** 场景 id（chat = 兜底：不注入场景 SOP） */
export type SceneId = "setup" | "train" | "log" | "recall" | "chat";

/** 片段：条件谓词 + 文案（领域无关的那半在 src/injection/fragments.ts） */
export type SopFragment = Fragment<PromptState>;

/** 场景定义 = 通用场景（id/开场行/片段/tool 白名单）+ pition 的「是否注入字段字典」 */
export interface SceneDef extends Scene<PromptState> {
  id: SceneId;
  /** 人类可读标题 */
  title: string;
  /** 开场行（场景命中即注入；一句话点明本轮姿态） */
  opening: string;
  /** 是否注入字段字典 */
  fields: boolean;
}

/** 全部 tool 名（测试断言用） */
export const RUNTIME_TOOLS = [
  "pition_boot",
  "pition_create_today",
  "pition_goal",
  "pition_history",
  "pition_read",
  "pition_span",
  "pition_write",
] as const;

export const SCENES: Record<SceneId, SceneDef> = {
  setup: {
    id: "setup",
    title: "配置与绑定",
    opening: "【配置场景】当前状态见 pition_boot 的 description，不必先 ping stage=done。",
    fragments: [
      {
        id: "no-token",
        when: (s) => !s.configured && !s.binding,
        text: "① 还没有可用 token：让用户在 Notion 建 integration、把目标库「连接」给它，然后把 ntn_... 交给 stage=token（我会校验并落盘）。",
      },
      {
        id: "pick-db",
        when: (s) => !s.binding,
        text: "② 选库：stage=select_db 列库；用户挑定后 stage=select_db + dbId 接管（切换当前库）。之前描述过的库按 dbId 保留，不丢说明。",
      },
      {
        id: "describe-fields",
        when: (s) => !!s.binding && (s.fields.total === 0 || s.fields.described < s.fields.total),
        text: (s) =>
          `③ 补字段说明：当前覆盖 ${s.fields.described}/${s.fields.total}。字段说明是**给 agent 看的语义**（落盘后随每轮对话注入 pition_fields 段）：按「这个字段记什么」问，别照抄字段名；一次 describe_fields 提交补齐。`,
      },
      {
        id: "ready",
        when: (s) => s.configured && s.fields.total > 0 && s.fields.described === s.fields.total,
        text: "配置已完整（token + 库 + 字段说明全齐）——只处理用户当下要改的那一步，别重走流程。",
      },
      {
        id: "flow",
        text: "流程：done 看现状 → token → select_db → describe_fields → set_mode → done。只改某一阶段产物时直接调对应 stage，不必从头重走。",
      },
      {
        id: "no-write-config",
        text: "配置改完立即生效、无需重启；配置是插件自己的 pition.config.json，不是用户的 Notion 库——别把配置项当成记录内容写进去。",
      },
    ],
    tools: ["pition_boot", "pition_read"],
    fields: true,
  },

  train: {
    id: "train",
    title: "锻炼教练",
    opening: "【锻炼场景】姿态是教练：报进度 → 明确鼓励 → 主动提示下一项；不是旁观者也不是审计员。",
    fragments: [
      {
        id: "plan-new",
        when: (s) => s.goals.length === 0,
        text: "还没有今日目标：先一轮问完身体情况（伤病/频率/时长）+ 倾向，给出**可量化**方案（名称 + 数字 + 单位），用户认可才 action=set；**不传 date**。每天重复的计划问一次 autoPeriod（daily / cron「0 6 * * 1,3,5」）；问一次要不要 bindField 看板同步。",
      },
      {
        id: "plan-injury",
        when: (s) => s.goals.length === 0,
        text: "用户提到伤病 → 先确认无痛区间，把红线写进方案（痛即停）。",
      },
      {
        id: "goal-running",
        when: (s) => s.goals.length > 0 && !allGoalsDone(s.goals),
        text: (s) => {
          const g = s.goals[0];
          const next = nextPendingItem(g);
          return next
            ? `目标「${g.title}」正在跑（实时进度见 pition_goal 段）：用户报完成一组/一轮 → action=progress（itemName + delta 默认 1）；下一项是「${next.name}」（${next.progress}/${next.target}${next.unit ? ` ${next.unit}` : ""}），推进后复述进度 + 鼓励 + 报下一项。`
            : `目标「${g.title}」正在跑：报完成就 action=progress。`;
        },
      },
      {
        id: "goal-all-done",
        when: (s) => allGoalsDone(s.goals),
        text: "今日目标已全部达标 → 庆祝，并主动帮用户把当日小结写进 Notion（pition_write），这是正反馈闭环的关键。",
      },
      {
        id: "self-check",
        when: (s) => s.goals.some((g) => (g.missedDays ?? 0) >= 2),
        text: (s) => {
          const g = s.goals.find((x) => (x.missedDays ?? 0) >= 2);
          return `「${g?.title}」已连续 ${g?.missedDays} 天未执行 → 主动问要不要调轻（update 降 target / 改或清 autoPeriod），不说教；用户不想继续就 delete。`;
        },
      },
      {
        id: "progress-not-span",
        text: "**做组/次数/时长型目标与时间无关 → 直接 action=progress**，不要开 span（没有时长可记）。",
      },
      {
        id: "long-task",
        text: "只有**需计时的长任务**（跑步/球类/爬山）才用 span：start 开始；end 带 goalItemName + goalDelta 一次收尾 + 推进——end 已推进就不要再调 progress。",
      },
      {
        id: "report",
        text: "问完成度 → action=list 读真实数字（不凭记忆）；提交汇报先给总百分比，再逐条 x/target，最后一句建议。",
      },
    ],
    tools: ["pition_goal", "pition_span", "pition_write", "pition_read"],
    fields: true,
  },

  log: {
    id: "log",
    title: "日常记录",
    opening: "【日常记录场景】目标：记全、记对位置、不打断用户。记录是主路径，提问是补充。",
    fragments: [
      {
        id: "what",
        text: "**该记**：明确时间锚定 + 具体内容（吃了什么/花了多少/见了谁/做了什么）；**情绪、心情、感悟、反思也是事实事件**（「今天心情不错」「悟到一个道理」）——用户在主动交付内容，别漏。**不该记**：闲聊、纯问答、调试代码、解释概念。",
      },
      {
        id: "where",
        text: "**位置**：能进属性就进属性（看板维度：标签 union / 金额时长累加 / 打卡 OR），叙述性内容进正文 appendContent；同一事件的多个维度一次调用写全，别拆多次。",
      },
      {
        id: "span-for-events",
        text: "有起止的时长事件（跑步/开会/午休）走 span（start/end），不要用 write 写两条。",
      },
      {
        id: "no-page-recovery",
        when: (s) => !!s.session.last?.warning?.includes("page"),
        text: "上一轮 write 报「没有 page」→ 现在才调 pition_create_today 手动建一条（逃生口；正常 page 由定时任务建）。",
      },
      {
        id: "timestamp",
        text: "不传 timestamp（程序自动给每段加 [HH:MM]）；只有代写历史事件（「昨天下午 3 点」）才手动传。",
      },
      {
        id: "avoid-duplicate",
        when: (s) => s.session.writes > 0,
        text: (s) =>
          `本会话已写入 ${s.session.writes} 条——同一条内容不要重复落库；用户只是追问时直接答，不要再调 write。`,
      },
      {
        id: "recap",
        text: "写完简短复述「记到【库名】」+ 按 todaySoFar 给今日概览 + 追问 1 个自然延伸的细节（先记原始再问优化，不审问）。",
      },
    ],
    tools: ["pition_write", "pition_span", "pition_goal", "pition_create_today", "pition_read"],
    fields: true,
  },

  recall: {
    id: "recall",
    title: "回看旧账",
    opening: "【回看场景】只在用户显式翻旧账时用；日常**不要**主动列 page 列表。",
    fragments: [
      { id: "read-today", text: "「今天/刚才记了什么」→ pition_read（读当前 page 全文）。" },
      {
        id: "history-range",
        text: "「上个月/上周/去年/之前」→ pition_history（limit 默认 10 最大 50；可带单字段 filter：equals 精确 / contains 包含）。",
      },
      {
        id: "goal-progress",
        when: (s) => s.goals.length > 0,
        text: (s) => `今日有 ${s.goals.length} 个目标在跑 → 问完成度直接 action=list 读真实进度（别从旧记录里推算）。`,
      },
      {
        id: "report-order",
        text: "汇报顺序：先总览（条数/百分比），再逐条事实，最后一句结论或建议；缺数据就说缺，不要编。",
      },
    ],
    tools: ["pition_history", "pition_read", "pition_goal"],
    fields: true,
  },

  chat: {
    id: "chat",
    title: "通用",
    opening: "",
    fragments: [],
    tools: undefined, // 不裁剪：通用对话保留全部 tool guidelines
    fields: false,
  },
};

/** 场景定义查询（未知 id 回落 chat，避免注入空段） */
export function sceneDef(id: SceneId): SceneDef {
  return SCENES[id] ?? SCENES.chat;
}

/** 本轮实际会出现的片段 id（排障/测试用：一眼看出「为什么注入了这段」） */
export function activeFragments(id: SceneId, state: PromptState): string[] {
  return activeFragmentIds(sceneDef(id), state);
}

/**
 * 按状态渲染场景剧本：开场行 + 命中的片段。
 * 场景未命中（chat）或没有任何片段成立时返回空串（调用方以空判跳过注入）。
 */
export function renderScene(id: SceneId, state: PromptState): string {
  return renderSceneBody(sceneDef(id), state);
}
