// 注入预算台账的生成与校验（参考 pi-dynamic-workflows 的 `context:check`）。
//
//   node scripts/check-context-budget.mjs            → 生成/刷新 docs/context-budget.json
//   node scripts/check-context-budget.mjs --check    → 校验台账是否漂移 + 是否超上限（进 npm run check）
//
// 度量对象是**真实注册的 tool**（走 jiti 加载扩展 + 假 pi 捕获），不是手抄的清单——
// 加了 tool / 加了 guideline / 加了 skill，台账就必须跟着动，否则 --check 失败。
//
// 配置隔离：用 PITION_CONFIG 指向临时配置，绝不读用户本机的 pition.config.json。

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = "docs/context-budget.json";
const check = process.argv.includes("--check");

const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": join(
      here,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "index.js",
    ),
    typebox: join(here, "node_modules", "typebox", "build", "index.mjs"),
  },
});

// 1) 真实注册的 tool（假 pi 捕获；配置指向临时文件，不碰用户真实配置）
const smokeDir = mkdtempSync(join(tmpdir(), "pition-budget-"));
const configPath = join(smokeDir, "pition.config.json");
writeFileSync(configPath, JSON.stringify({ token: "ntn_budget_dummy", bindings: {}, currentBindingId: null }));
process.env.PITION_CONFIG = configPath;

const extPath = `file:///${join(here, "extensions", "pition.ts").replace(/\\/g, "/")}`;
const ext = await jiti.import(extPath);
const tools = [];
ext.default({
  registerTool: (t) => tools.push(t),
  registerCommand: () => {},
  on: () => () => {},
  registerShortcut: () => {},
  registerFlag: () => {},
});
rmSync(smokeDir, { recursive: true, force: true });
delete process.env.PITION_CONFIG;

// 2) 已注册 skill 的发现条目（从 package.json#pi.skills 读，不硬编码——新增 skill 自动纳入台账）
//    frontmatter 用 pi 自己的 parseFrontmatter 解析，保证与 pi 加载出来的内容一致。
//    注意 pi.skills 可以是「skill 根目录」也可以是「装 skill 的目录」——两种都支持（递归找 SKILL.md，
//    找到即视为一个 skill，不再往下钻）。
const { parseFrontmatter } = await jiti.import(
  join(here, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"),
);
const manifest = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const declaredRoots = manifest.pi?.skills ?? [];

function findSkillDirs(root) {
  const absolute = join(here, root);
  if (existsSync(join(absolute, "SKILL.md"))) return [root];
  const found = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    found.push(...findSkillDirs(`${root}/${entry.name}`));
  }
  return found;
}

const skillRoots = declaredRoots.flatMap(findSkillDirs).sort();
const skills = skillRoots.map((root) => {
  const { frontmatter } = parseFrontmatter(readFileSync(join(here, root, "SKILL.md"), "utf8"));
  const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  if (!name || !description) throw new Error(`${root}/SKILL.md 必须声明 name 与 description（台账要度量发现条目）`);
  return { root, name, description };
});

// 3) 每个场景实际注入的 section（用固定 fixture 库 + 固定时刻 + 代表性会话事实，
//    保证台账与本机配置/时钟无关）
const {
  buildContextBudget,
  evaluateBudget,
  renderContextBudget,
  BUDGET_FIXTURE_BINDING,
  BUDGET_FIXTURE_NOW,
  BUDGET_FIXTURE_SESSION,
} = await jiti.import(join(here, "src", "context-budget.ts"));
const { buildRoleInjections, GLOBAL_GUIDELINES } = await jiti.import(join(here, "src", "role.ts"));
const { buildPromptState } = await jiti.import(join(here, "src", "prompt-state.ts"));
const { SCENES, activeFragments } = await jiti.import(join(here, "src", "sop.ts"));

const cfg = {
  token: "x",
  bindings: { [BUDGET_FIXTURE_BINDING.dbId]: BUDGET_FIXTURE_BINDING },
  currentBindingId: BUDGET_FIXTURE_BINDING.dbId,
};
const baseState = buildPromptState({ cfg, now: BUDGET_FIXTURE_NOW, session: BUDGET_FIXTURE_SESSION });

// fixture 目标：用于量「有目标」那一档（片段化 SOP 的字节数随状态变，只量一种会漏掉最长的那份）
const fixtureGoals = [
  {
    goalId: "budget-goal",
    title: "今日锻炼计划",
    period: "day",
    date: baseState.today,
    autoPeriod: "daily",
    missedDays: 3,
    createdAt: `${baseState.today}T08:00:00.000+08:00`,
    items: [
      { name: "俯卧撑", target: 4, progress: 2, unit: "轮" },
      { name: "平板支撑", target: 3, progress: 0, unit: "组" },
    ],
  },
];

// 三种状态族 × 每个场景 —— 片段化 SOP 的字节数随状态变，只量一种会漏掉最长的那份：
//   unconfigured：还没配（首次使用，setup 走 no-token/pick-db 分支；其余场景 core 带「未绑定」指路）
//   ready：       token + 库 + 字段说明齐备，今天还没建目标
//   ready+goal：  同上，且有今日目标（train 走 goal-running / self-check 分支）
const families = [
  { suffix: "unconfigured", cfg: { token: "", bindings: {}, currentBindingId: null }, goals: [] },
  { suffix: "ready", cfg, goals: [] },
  { suffix: "ready+goal", cfg, goals: fixtureGoals },
];

const scenes = families.flatMap((family) =>
  Object.keys(SCENES).map((id) => {
    const state = buildPromptState({
      cfg: family.cfg,
      now: BUDGET_FIXTURE_NOW,
      session: BUDGET_FIXTURE_SESSION,
      goals: family.goals,
    });
    return {
      id: `${id}@${family.suffix}`,
      sections: buildRoleInjections(family.cfg, id, state).sections,
      keptTools: SCENES[id].tools,
      fragmentIds: activeFragments(id, state),
    };
  }),
);

const input = { tools, skills, scenes, globalGuidelines: GLOBAL_GUIDELINES };
const budget = buildContextBudget(input);
const rendered = renderContextBudget(input);

// 4) 汇报（CI 日志里直接看到常驻成本）
const s = budget.surfaces;
console.log(`工具数：${tools.length}（snippet ${tools.filter((t) => t.promptSnippet).length}/${tools.length} 覆盖）`);
console.log(`常驻注入（pition 名下，chat 场景不裁剪 = 最坏情况）：${s.ownershipAlwaysOn.bytes} 字节`);
console.log(`  - 全局 guideline：${s.globalGuidelines.bytes} 字节 / ${s.globalGuidelines.lines} 条`);
console.log(`  - tool guideline（未裁剪）：${s.toolGuidelines.bytes} 字节 / ${s.toolGuidelines.lines} 条`);
console.log(`  - tool definition（含 snippet）：${s.toolDefinitions.bytes} 字节`);
for (const t of s.toolDefinitions.tools) {
  console.log(
    `      ${t.name.padEnd(22)} ${String(t.bytes).padStart(5)} = desc ${String(t.descriptionBytes).padStart(4)} + params ${String(t.parametersBytes).padStart(4)}`,
  );
}
console.log(`  - skill 发现条目 ${s.skillsDiscovery.skills.length} 个：${s.skillsDiscovery.bytes} 字节`);
const pruned = new Map(s.sceneInjections.toolGuidelines.map((t) => [t.id, t]));
for (const scene of s.sceneInjections.scenes) {
  const kept = pruned.get(scene.id);
  const prunedCount = tools.length - (kept?.keptTools.length ?? tools.length);
  console.log(
    `  - 场景 ${scene.id.padEnd(12)} sections ${String(scene.bytes).padStart(5)}（core+剧本+易变 ${scene.sopBytes}）· 保留 tool guideline ${String(kept?.bytes ?? 0).padStart(4)}（裁掉 ${prunedCount} 个 tool）`,
  );
  console.log(`      片段：${scene.fragments.length ? scene.fragments.join(", ") : "（无）"}`);
}

const violations = evaluateBudget(budget);
for (const v of violations) console.error(`FAIL: ${v}`);

if (check) {
  const committed = readFileSync(join(here, LEDGER), "utf8");
  if (committed !== rendered) {
    console.error(`FAIL: 注入预算台账已漂移：${LEDGER}（跑 node scripts/check-context-budget.mjs 重新生成并提交）`);
    process.exitCode = 1;
  } else {
    console.log(`${LEDGER} 与当前注入面一致。`);
  }
} else {
  writeFileSync(join(here, LEDGER), rendered);
  console.log(`已写入 ${LEDGER}。`);
}

if (violations.length) process.exitCode = 1;
