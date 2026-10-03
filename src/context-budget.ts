// 注入预算台账：把「pition 每轮让模型多看到多少字节」变成可度量、可门禁的数字。
//
// 为什么需要：pition 的注入点分散在两处 ——
//   custom 层 sections（role.ts：pition_core / pition_scene / pition_fields）
//   rules 层 + tools 层（7 个 tool 的 promptSnippet / promptGuidelines / description / schema）
// 谁都能往里加一句，但此前没有任何地方能回答「加了这句，每轮请求涨了多少字节」。
// 参考实现：pi-dynamic-workflows 的 docs/workflow-context-surfaces.json + `context:check`
// ——把常驻上下文面固化成产物，CI 校验是否漂移（该仓库 AGENTS.md：「Keep detailed
// authoring guidance in the on-demand skill, not the always-on prompt.」）。
//
// 本模块**纯函数**（数据进 → 度量出），不碰 fs/进程：脚本负责读盘，测试直接喂数据。
//
// 面（surfaces）的定义与 C01 的 section 层一一对应：
//   globalGuidelines     rules 层：3 条全局 guideline（任何场景都注入）
//   toolGuidelines       rules 层：各 tool 的 promptGuidelines（**最坏情况 = 不裁剪**，即 chat 场景）
//   toolDefinitions      tools 层 + provider 侧工具定义：JSON.stringify({name, description, parameters})
//   skillsDiscovery      skills 层：pi 为每个 skill 注入的发现条目（name + description + location）
//   ownershipAlwaysOn    以上四者之和 = pition 造成的常驻上下文成本（chat 场景下）
//   sceneInjections      custom 层：每个场景实际注入的 section 字节（只在命中场景时付）
import { lineCount, renderSkillEntry, summed, surface, utf8Bytes } from "./injection/index.ts";
import type { SessionFacts } from "./prompt-state.ts";
import type { Binding } from "./types.ts";

/** 常量：度量口径的格式版本；口径变了要 bump（否则台账会被误判为漂移） */
export const BUDGET_FORMAT_VERSION = 1;

/**
 * 度量用的**代表性库**（fixture）。
 *
 * 为什么不用用户的真实 `pition.config.json`：台账要提交进仓库并在 CI 校验，
 * 若随本机配置变化就永远漂移。规模按真实个人记录库取典型值（30 字段、说明 8-20 字、
 * 覆盖 11 种可写类型），保证 pition_fields 面的字节数有意义。
 */
export const BUDGET_FIXTURE_BINDING: Binding = {
  dbId: "budget-fixture",
  title: "个人日常记录",
  description: "个人日常记录总表",
  fields: {
    Name: { type: "title", description: "记录标题，一般是当天日期" },
    基础: { type: "rich_text", description: "当日核心事项摘要" },
    标签: { type: "multi_select", description: "事项类别标签（运动/饮食/工作/学习/社交）" },
    金额: { type: "number", description: "当日花销合计（元）" },
    时长: { type: "number", description: "当日运动时长（分钟）" },
    心情: { type: "select", description: "当日整体心情" },
    状态: { type: "status", description: "当日复盘状态" },
    日期: { type: "date", description: "事项发生日期" },
    已打卡: { type: "checkbox", description: "当日是否完成打卡" },
    参考链接: { type: "url", description: "相关链接" },
    邮箱: { type: "email", description: "相关联系人邮箱" },
    电话: { type: "phone_number", description: "相关联系人电话" },
    早餐: { type: "rich_text", description: "早餐内容" },
    午餐: { type: "rich_text", description: "午餐内容" },
    晚餐: { type: "rich_text", description: "晚餐内容" },
    运动项目: { type: "multi_select", description: "当日运动项目" },
    睡眠时长: { type: "number", description: "昨夜睡眠小时数" },
    体重: { type: "number", description: "当日体重（kg）" },
    阅读: { type: "rich_text", description: "阅读书目与页数" },
    工作: { type: "rich_text", description: "工作事项与产出" },
    学习: { type: "rich_text", description: "学习内容与收获" },
    社交: { type: "rich_text", description: "见了谁、聊了什么" },
    灵感: { type: "rich_text", description: "临时记下的灵感与想法" },
    感悟: { type: "rich_text", description: "当日的反思与感悟" },
    天气: { type: "select", description: "当天天气" },
    地点: { type: "rich_text", description: "主要活动地点" },
    完成度: { type: "number", description: "当日计划完成百分比" },
    优先级: { type: "select", description: "当日主线优先级" },
    备注: { type: "rich_text", description: "其它补充" },
    复查: { type: "checkbox", description: "是否需要复查" },
  },
};

/**
 * 度量用的固定「现在」：用**本地时间构造**（`new Date(y, m, d, h, mi)`），
 * 这样在任何时区跑出来的年月日/星期/时刻都一致——台账才能提交进仓库当门禁。
 * 取 22:21（晚上）是为了让易变层带上最长的一种时段文案。
 */
export const BUDGET_FIXTURE_NOW = new Date(2026, 9, 3, 22, 21, 0);

/**
 * 度量用的代表性会话事实：写过 1 条 + 上一轮带 warning —— 易变层的最坏（最长）形态。
 * 现实里这三种行不会同时都在，按最坏情况度量才不会漏算。
 */
export const BUDGET_FIXTURE_SESSION: SessionFacts = {
  writes: 1,
  last: {
    tool: "pition_write",
    failed: false,
    summary: "已写入「个人日常记录」当前 page: https://www.notion.so/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    warning: "no_page_in_db",
    at: "22:18",
  },
};

/** 度量用的最小 tool 形状（pi 的 ToolDefinition 子集） */
export interface BudgetTool {
  name: string;
  description?: string;
  /** pi 把 promptSnippet 拼进 tools 层的「Available tools」列表 */
  promptSnippet?: string;
  /** pi 只把 selectedTools 里每个 tool 的这些句子拼进 rules 层 */
  promptGuidelines?: string[];
  parameters?: unknown;
}

export interface BudgetInput {
  tools: BudgetTool[];
  /** 每个已注册 skill 的发现条目（name/description 来自 SKILL.md frontmatter） */
  skills: Array<{ root: string; name: string; description: string }>;
  /**
   * 每个场景在助理模式下实际注入的 section 文本 + 该场景保留 guideline 的 tool
   * （keptTools 用来量化「场景裁剪」省下的字节）
   */
  scenes: Array<{ id: string; sections: Record<string, string>; keptTools?: string[]; fragmentIds?: string[] }>;
  /** 全局 guideline（role.ts 的 GLOBAL_GUIDELINES） */
  globalGuidelines: string[];
}

export interface ByteSurface {
  serialization: string;
  bytes: number;
  lines: number;
}

export interface ContextBudget {
  formatVersion: number;
  encoding: "utf8";
  sources: string[];
  surfaces: {
    globalGuidelines: ByteSurface;
    toolGuidelines: ByteSurface & { tools: Array<{ name: string; bytes: number; lines: number }> };
    toolDefinitions: ByteSurface & {
      /** 每个 tool 的常驻字节拆成 description / parameters 两块——瘦身时直接看哪块贵 */
      tools: Array<{ name: string; bytes: number; descriptionBytes: number; parametersBytes: number }>;
    };
    skillsDiscovery: ByteSurface & { skills: Array<{ root: string; bytes: number }> };
    ownershipAlwaysOn: ByteSurface;
    sceneInjections: {
      serialization: "UTF-8 bytes of each scene's injected sections (custom layer, only when the scene matches)";
      /** 场景 section 总量 = core + scene 剧本 + runtime（不含字段字典——它另有上限） */
      scenes: Array<{
        id: string;
        bytes: number;
        sopBytes: number;
        /** 该状态下真正出现的片段 id —— 台账用来回答「这段为什么出现」 */
        fragments: string[];
        sections: Array<{ name: string; bytes: number }>;
      }>;
      /** 每个场景保留 guideline 的 tool 及其 guideline 字节 —— 量化「按场景裁剪」省下多少 */
      toolGuidelines: Array<{ id: string; keptTools: string[]; bytes: number }>;
    };
  };
  ceilings: typeof BUDGET_CEILINGS;
}

/**
 * 门禁上限（字节）。取「当前实测 + ~7%」留出正常迭代空间：
 * 一旦某次改动让常驻成本显著上涨，`npm run check` 会直接失败，逼作者把细节挪回
 * on-demand skill，而不是让常驻提示词悄悄膨胀。
 */
export const BUDGET_CEILINGS = {
  /** pition 常驻上下文（最坏情况：chat 场景不裁剪 tool guidelines） */
  ownershipAlwaysOnBytes: 18000,
  /** 单场景的 section 注入面 = pition_core + pition_scene + pition_runtime（字段字典另算） */
  sceneSopBytes: 3000,
  /** 字段字典单段（对应 src/fields.ts 的 FIELD_DICT_MAX_CHARS 预算） */
  fieldDictBytes: 3600,
  /** 易变层单段（每轮都 diff，必须小；超了说明有人往运行态快照里塞了不该塞的东西） */
  runtimeBytes: 520,
};

// 度量原语（字节/行数/转义/技能条目）在 src/injection/bytes.ts —— 与领域无关，可复用。
const bytes = utf8Bytes;
const lines = lineCount;

/** 度量全部注入面（纯函数；同输入必得同输出，台账才能当门禁用） */
export function buildContextBudget(input: BudgetInput): ContextBudget {
  const globalText = input.globalGuidelines.map((g) => `- ${g}`).join("\n");

  const toolGuidelineSurfaces = input.tools.map((t) => {
    const text = (t.promptGuidelines ?? []).map((g) => `- ${g}`).join("\n");
    return { name: t.name, bytes: bytes(text), lines: lines(text) };
  });
  const toolGuidelineBytes = toolGuidelineSurfaces.reduce((sum, t) => sum + t.bytes, 0);
  const toolGuidelineLines = toolGuidelineSurfaces.reduce((sum, t) => sum + t.lines, 0);

  // snippet 也算常驻（pi 把 promptSnippet 拼进 tools 层的 Available tools 列表）
  const snippetText = input.tools.map((t) => `- ${t.name}: ${t.promptSnippet ?? ""}`).join("\n");
  const toolDefinitionSurfaces = input.tools.map((t) => {
    const descriptionBytes = bytes(t.description ?? "");
    const parametersBytes = bytes(JSON.stringify(t.parameters ?? null));
    return { name: t.name, bytes: descriptionBytes + parametersBytes, descriptionBytes, parametersBytes };
  });
  const toolDefinitionBytes = toolDefinitionSurfaces.reduce((sum, t) => sum + t.bytes, 0) + bytes(snippetText);

  // 与 pi 的 formatSkillsForPrompt 逐字符对齐（4 空格缩进 + escapeXml + location 指到 SKILL.md）
  const skillSurfaces = input.skills.map((s) => ({ root: s.root, bytes: bytes(renderSkillEntry(s)) }));
  const skillBytes = skillSurfaces.reduce((sum, s) => sum + s.bytes, 0);

  const sceneSurfaces = input.scenes.map((scene) => {
    const sections = Object.entries(scene.sections).map(([name, text]) => ({ name, bytes: bytes(text) }));
    return {
      id: scene.id,
      bytes: sections.reduce((sum, s) => sum + s.bytes, 0),
      sopBytes: sections.filter((s) => s.name !== "pition_fields").reduce((sum, s) => sum + s.bytes, 0),
      fragments: scene.fragmentIds ?? [],
      sections,
    };
  });

  const guidelineBytesByName = new Map(toolGuidelineSurfaces.map((t) => [t.name, t.bytes]));
  const sceneToolGuidelineSurfaces = input.scenes.map((scene) => ({
    id: scene.id,
    keptTools: scene.keptTools ?? input.tools.map((t) => t.name),
    bytes: (scene.keptTools ?? input.tools.map((t) => t.name)).reduce(
      (sum, name) => sum + (guidelineBytesByName.get(name) ?? 0),
      0,
    ),
  }));

  const globalSurface = surface("UTF-8 bytes of LF-joined Pi prompt guideline bullets", globalText);
  const alwaysOnBytes = globalSurface.bytes + toolGuidelineBytes + toolDefinitionBytes + skillBytes;

  return {
    formatVersion: BUDGET_FORMAT_VERSION,
    encoding: "utf8",
    sources: [
      "src/role.ts#GLOBAL_GUIDELINES",
      "src/tools/*.ts（promptSnippet / promptGuidelines / description / parameters）",
      "src/sop.ts#SCENES",
      "package.json#pi.skills + skills/*/SKILL.md",
    ],
    surfaces: {
      globalGuidelines: globalSurface,
      toolGuidelines: {
        ...summed(
          "sum of UTF-8 bytes of each tool's LF-joined prompt guideline bullets (worst case: no scene pruning)",
          toolGuidelineBytes,
          toolGuidelineLines,
        ),
        tools: toolGuidelineSurfaces,
      },
      toolDefinitions: {
        ...summed(
          "sum of UTF-8 bytes of JSON.stringify({name, description, parameters}) per tool, plus the tools-layer snippet lines",
          toolDefinitionBytes,
          input.tools.length,
        ),
        tools: toolDefinitionSurfaces,
      },
      skillsDiscovery: {
        ...summed(
          "sum of UTF-8 bytes of normalized Pi skill XML (name + description + location) per registered skill",
          skillBytes,
          input.skills.length,
        ),
        skills: skillSurfaces,
      },
      ownershipAlwaysOn: summed(
        "sum of globalGuidelines, toolGuidelines, toolDefinitions and skillsDiscovery (worst case: no scene pruning)",
        alwaysOnBytes,
        0,
      ),
      sceneInjections: {
        serialization: "UTF-8 bytes of each scene's injected sections (custom layer, only when the scene matches)",
        scenes: sceneSurfaces,
        toolGuidelines: sceneToolGuidelineSurfaces,
      },
    },
    ceilings: BUDGET_CEILINGS,
  };
}

/** 门禁评估：超限返回人类可读的违规说明（空数组 = 通过） */
export function evaluateBudget(budget: ContextBudget): string[] {
  const violations: string[] = [];
  const alwaysOn = budget.surfaces.ownershipAlwaysOn.bytes;
  if (alwaysOn > BUDGET_CEILINGS.ownershipAlwaysOnBytes) {
    violations.push(
      `常驻注入 ${alwaysOn} 字节 > 上限 ${BUDGET_CEILINGS.ownershipAlwaysOnBytes}：把细节挪回 on-demand skill（skills/*.md），别加进常驻 prompt`,
    );
  }
  for (const scene of budget.surfaces.sceneInjections.scenes) {
    if (scene.sopBytes > BUDGET_CEILINGS.sceneSopBytes) {
      violations.push(
        `场景 ${scene.id} 的 core+剧本+易变层 ${scene.sopBytes} 字节 > 上限 ${BUDGET_CEILINGS.sceneSopBytes}：精简 src/sop.ts 的该场景片段或收紧 src/role.ts 的 core`,
      );
    }
    const fields = scene.sections.find((s) => s.name === "pition_fields");
    if (fields && fields.bytes > BUDGET_CEILINGS.fieldDictBytes) {
      violations.push(
        `场景 ${scene.id} 的字段字典 ${fields.bytes} 字节 > 上限 ${BUDGET_CEILINGS.fieldDictBytes}：调小 src/fields.ts 的 FIELD_DICT_MAX_CHARS`,
      );
    }
    const runtime = scene.sections.find((s) => s.name === "pition_runtime");
    if (runtime && runtime.bytes > BUDGET_CEILINGS.runtimeBytes) {
      violations.push(
        `场景 ${scene.id} 的易变层（pition_runtime）${runtime.bytes} 字节 > 上限 ${BUDGET_CEILINGS.runtimeBytes}：它每轮都进上下文，只放「现在的时刻 + 本会话已发生的事」`,
      );
    }
  }
  return violations;
}

/** 渲染成确定性 JSON（生成脚本与 `--check` 比对的是同一份文本） */
export function renderContextBudget(input: BudgetInput): string {
  return `${JSON.stringify(buildContextBudget(input), null, 2)}\n`;
}
