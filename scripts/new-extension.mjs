// 脚手架：一条命令造一个新 pi 扩展（把 src/injection/ 内核复制过去 + 生成骨架）。
//
// 为什么有它：`src/injection/` 解决了「注入机械怎么写」，但造新扩展时还得手抄
// test/injection.test.ts 那份骨架、手填 8 个插槽、手配 package.json 的 pi 下界——
// 抄漏一处就是静默故障（最典型：peer 写成旧版本 → 装上后零注入且不报错）。
//
// 设计取舍：
//   1. **只复制 + 生成，不做 npm install / 不联网**——脚本保持可预测，装依赖是用户的事
//   2. 模板用 `{{TOKEN}}` 占位而不是 `${...}`——避免与本文件的模板字符串打架
//   3. 目标目录已存在就**报错退出**，绝不覆盖用户已有的东西
//   4. 生成出来的 `src/injection/` 与仓库里的逐字节相同（test/new-extension.test.ts 有断言）
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const KERNEL_DIR = join(REPO_ROOT, "src", "injection");
const PI_FLOOR = readVersionFloor();

/** 宿主下界从内核的单一真相源读（别在脚手架里再写死一个版本号） */
function readVersionFloor() {
  const src = readFileSync(join(KERNEL_DIR, "version.ts"), "utf8");
  const m = /MIN_PI_FOR_STRUCTURED\s*=\s*"([^"]+)"/.exec(src);
  if (!m) throw new Error("src/injection/version.ts 里找不到 MIN_PI_FOR_STRUCTURED —— 内核被改坏了？");
  return m[1];
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") flags.name = argv[++i];
    else if (a === "--prefix") flags.prefix = argv[++i];
    else if (a === "--force") flags.force = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else positional.push(a);
  }
  return { positional, flags };
}

export const USAGE = `用法：node scripts/new-extension.mjs <目标目录> [--name 扩展名] [--prefix tool前缀] [--force]

  <目标目录>      新扩展的根目录（不存在就创建）
  --name          扩展名，缺省取目标目录名（决定 extensions/<name>.ts 与 package.json 的 name）
  --prefix        tool 名前缀，缺省 "<name>_"（tool_execution_end 只采集这个前缀的结果）
  --force         目标目录已存在时仍然写入（会覆盖同名文件）

生成后：cd <目标目录> && npm install && npm test`;

// ————————————————————————————————————————————————————————————————
// 模板（{{NAME}} / {{PREFIX}} / {{PASCAL}} / {{PI_FLOOR}} 会被替换）
//
// 注意 devDependencies 里的 @types/node 不是装饰：内核的 bytes.ts 用了 Buffer，
// 缺它 tsc 会报 TS2580（Cannot find name 'Buffer'），而 vitest 不报——很容易漏。
// ————————————————————————————————————————————————————————————————

const T = {
  // tsconfig 必须生成：没有它 `tsc --noEmit` 直接 TS18003（no inputs），
  // 而 allowImportingTsExtensions 必须开——本项目所有 import 都带 .ts 后缀
  "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "extensions/**/*.ts", "index.ts"]
}
`,

  "package.json": `{
  "name": "{{NAME}}",
  "version": "0.1.0",
  "description": "TODO: 一句话说明这个 pi 扩展做什么",
  "type": "module",
  "license": "MIT",
  "engines": {
    "node": ">=22.19.0"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": ">={{PI_FLOOR}}"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "{{PI_FLOOR}}",
    "@types/node": "^22.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.1.9"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "pi": {
    "extensions": [
      "./extensions/{{NAME}}.ts"
    ]
  }
}
`,

  "index.ts": `// pi 以包形式加载时认**包根 index.ts**（单一扩展形态）。
// 注意：re-export 本地 .ts 必须带 .ts 后缀 —— jiti 按字面找文件。
export { default } from "./extensions/{{NAME}}.ts";
`,

  "extensions/{{NAME}}.ts": `// {{NAME}} —— 装配层：把领域逻辑接到注入内核。
//
// 这一层只做三件事，别在这里写业务：
//   1. 造运行态（会话事实 / 上一场景 / 提示标记）
//   2. createInjectionRuntime(spec, state).attach(pi) —— 三个事件订阅与一轮编排都由内核负责
//   3. 注册 tool（**无条件注册**：配置是在会话中现配的，工厂期做门禁会让工具永远不出现）
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createInjectionRuntime, emptyRuntimeState } from "../src/injection/index.ts";
import type { SceneId } from "../src/scenes.ts";
import { spec } from "../src/spec.ts";

export default function (pi: ExtensionAPI) {
  // 总开关：想做「助理模式」就把这里换成读配置（并在 spec.enabled 里返回它）
  const state = emptyRuntimeState<SceneId>();
  createInjectionRuntime(spec, state).attach(pi);

  // TODO: 定义并注册你的 tool —— pi.registerTool(...)
  // 纪律：每个 tool 都要有 promptSnippet（否则不进 pi 的 tools 层索引）；
  //       校验下沉到 execute 首行，不要在工厂里用 cfg 做 if (...) return。
}
`,

  "src/state.ts": `// 本轮状态快照：时间锚点 + 领域事实 + 会话事实（纯数据，可测）。
//
// 纪律：片段（scenes.ts）只从这份快照取值，不要在片段的 when 里读配置/时间——
// 那样同一状态两轮会得到不同提示词，cache 永远 miss、测试不可复现。
import { type SessionFacts, timeAnchor, type TimeAnchor } from "./injection/index.ts";

/** 领域侧可变事实（换成你的真实数据源：配置 / 远端 / 内存） */
export const store = { total: 0 };

export interface {{PASCAL}}State {
  anchor: TimeAnchor;
  /** 库里已有多少条 */
  total: number;
  /** 本会话已存几条（来自 tool 结果回流） */
  saved: number;
  /** 上一轮是否失败 */
  lastFailed: boolean;
}

/** 每轮构造一次（可读配置、可落盘；抛错会走 spec.fallback 的降级注入） */
export function buildState(ctx: { session: SessionFacts; now: Date }): {{PASCAL}}State {
  return {
    anchor: timeAnchor(ctx.now),
    total: store.total,
    saved: ctx.session.writes,
    lastFailed: ctx.session.last?.failed === true,
  };
}
`,

  "src/scenes.ts": `// 场景定义 + 路由。
//
// 两条纪律：
//   1. 片段必须带 when（注入内容 = f(状态)）——写无条件长文就是把当下不成立的内容塞给模型
//   2. 片段里提到的 tool 必须在该场景的 tools 白名单里，否则模型会去调一个
//      guideline 已被裁掉的 tool（建议照抄一份一致性测试）
import { createRouter, type Fragment, isLowInfo, renderSceneBody } from "./injection/index.ts";
import type { {{PASCAL}}State } from "./state.ts";

export type SceneId = "capture" | "lookup" | "chat";

export interface SceneDef {
  opening: string;
  fragments: Fragment<{{PASCAL}}State>[];
  /** 该场景保留 promptGuidelines 的 tool；undefined = 不裁剪 */
  tools?: string[];
}

export const SCENES: Record<SceneId, SceneDef> = {
  capture: {
    opening: "【收藏场景】把这段代码存进片段库。",
    fragments: [
      { id: "first-run", when: (s) => s.total === 0, text: "库还是空的：第一次存会顺手建好分类。" },
      {
        id: "dup-guard",
        when: (s) => s.saved > 0,
        text: (s) => \`本会话已存 \${s.saved} 条：同名片段先问覆盖还是新建。\`,
      },
      { id: "lang", text: "存之前确认语言（language 字段必填）。" },
    ],
    tools: ["{{PREFIX}}save"],
  },
  lookup: {
    opening: "【查找场景】先检索再回答，别凭记忆编。",
    fragments: [{ id: "grep", text: "关键词优先；找不到就直说没有。" }],
    tools: ["{{PREFIX}}find"],
  },
  chat: { opening: "", fragments: [], tools: undefined },
};

/** 优先级 = signals 数组顺序；低信息量消息沿用上一场景（粘性） */
export const route = createRouter<SceneId>({
  signals: [
    { id: "lookup", re: /找|搜/u },
    { id: "capture", re: /存|收藏/u },
  ],
  fallback: "chat",
  lowInfo: (p) => isLowInfo(p, /^(?:好|继续|嗯)[。!！]?$/u),
});

/** 按状态渲染场景正文（没有任何内容时返回空串 → 该 section 不注入） */
export function renderScene(id: SceneId, state: {{PASCAL}}State): string {
  return renderSceneBody({ id, ...SCENES[id] }, state);
}
`,

  "src/spec.ts": `// 注入规格：领域相关的部分全在这里，机械部分由内核负责。
//
// 四层按**变化频率**分段（见 ./injection/layers.ts）：
//   core    恒定：身份 + 工具索引        → 全场景 cache hit
//   scene   场景：按状态装配的片段       → 切场景才变
//   runtime 易变：时刻 + 本会话已发生的事 → 每轮变，**必须单独成段**
//
// 易变层只放事实不放建议（建议归场景片段，两边都写就是重复注入）。
import { assembleLayers, type InjectionSpec } from "./injection/index.ts";
import { renderScene, route, type SceneId } from "./scenes.ts";
import { buildState, type {{PASCAL}}State } from "./state.ts";

export const spec: InjectionSpec<{{PASCAL}}State, SceneId> = {
  name: "{{NAME}}",
  toolPrefix: "{{PREFIX}}",
  countTool: "{{PREFIX}}save",
  enabled: () => true,
  route: (prompt, prev) => route(prompt, prev),

  buildState: ({ session, now }) => buildState({ session, now }),

  build: ({ state, scene }) => ({
    guidelines: ["TODO: 恒定的硬边界（≤3 条，只放切场景也成立的部分）"],
    sections: assembleLayers<{{PASCAL}}State>(
      [
        { name: "{{NAME}}_core", render: (s) => \`{{NAME}}（共 \${s.total} 条）。\` },
        { name: "{{NAME}}_scene", render: (s) => renderScene(scene, s) },
        {
          name: "{{NAME}}_runtime",
          render: (s) =>
            \`⏱ \${s.anchor.todayLabel} \${s.anchor.clock}\${s.lastFailed ? " · ⚠️ 上一轮失败，别原样重试" : ""}\`,
        },
      ],
      state,
    ),
    keptTools: undefined, // TODO: 换成 SCENES[scene].tools 以启用足迹裁剪
  }),

  // 装配失败时的最小注入：只写 core —— 别让这一轮在模型眼里变成「扩展不存在」
  fallback: () => ({
    guidelines: ["{{NAME}} 剧本装配失败：按 tool description 谨慎行动。"],
    sections: { "{{NAME}}_core": "{{NAME}} 装配失败，已降级为最小注入。" },
  }),
};
`,

  "test/injection.test.ts": `// 最小自检：用假 pi 跑一轮，确认分层注入 / 结果回流 / 降级 / 旧宿主跳过都活着。
// 加了新场景或新片段，就在这里补一条断言。
import { describe, expect, it } from "vitest";
import { createInjectionRuntime, emptyRuntimeState } from "../src/injection/index.ts";
import type { SceneId } from "../src/scenes.ts";
import { spec } from "../src/spec.ts";
import { store } from "../src/state.ts";

/** 假 pi 的 on 必须 push 到数组并按注册顺序全跑（写成 handlers[event] = h 会漏掉第二个订阅） */
function fakePi() {
  const handlers: Record<string, Array<(e: unknown, c?: unknown) => unknown>> = {};
  return {
    on(event: string, handler: (e: unknown, c?: unknown) => unknown): void {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    async fire(event: Record<string, unknown>, ctx?: unknown): Promise<void> {
      for (const h of handlers[String(event.type)] ?? []) await h(event, ctx);
    },
    async beforeAgentStart(prompt: string, opts: Record<string, unknown>, ctx?: unknown): Promise<void> {
      for (const h of handlers.before_agent_start ?? []) await h({ prompt, systemPromptOptions: opts }, ctx);
    },
  };
}

function freshOptions() {
  return { promptGuidelines: [] as string[], sections: {} as Record<string, string>, toolGuidelines: {} };
}

function mount() {
  const pi = fakePi();
  const state = emptyRuntimeState<SceneId>();
  createInjectionRuntime(spec, state).attach(pi);
  return { pi, state };
}

describe("{{NAME}} 注入", () => {
  it("分层注入：core / scene / runtime 三段都在，且片段随状态变", async () => {
    const { pi } = mount();
    store.total = 0;
    const opts = freshOptions();
    await pi.beforeAgentStart("帮我把这段代码存起来", opts);

    expect(Object.keys(opts.sections).sort()).toEqual(["{{NAME}}_core", "{{NAME}}_runtime", "{{NAME}}_scene"]);
    expect(opts.sections["{{NAME}}_scene"]).toContain("库还是空的");

    store.total = 12;
    const after = freshOptions();
    await pi.beforeAgentStart("帮我把这段代码存起来", after);
    expect(after.sections["{{NAME}}_scene"]).not.toContain("库还是空的");
    store.total = 0;
  });

  it("tool 结果回流：上一轮失败进下一轮易变层", async () => {
    const { pi } = mount();
    await pi.fire({ type: "tool_execution_end", toolName: "{{PREFIX}}save", isError: true, result: {} });
    const opts = freshOptions();
    await pi.beforeAgentStart("再存一次", opts);
    expect(opts.sections["{{NAME}}_runtime"]).toContain("上一轮失败");
  });

  it("宿主不支持（无 sections）：不写入任何内容 + 只提示一次", async () => {
    const { pi } = mount();
    const legacy = { promptGuidelines: [] as string[] };
    const notices: string[] = [];
    const ctx = { ui: { notify: (m: string) => notices.push(m) } };
    await pi.beforeAgentStart("存一段", legacy, ctx);
    await pi.beforeAgentStart("存一段", legacy, ctx);
    expect(legacy.promptGuidelines).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("{{PI_FLOOR}}");
  });

  it("session_start 清零会话事实", async () => {
    const { pi, state } = mount();
    await pi.fire({ type: "tool_execution_end", toolName: "{{PREFIX}}save", result: {} });
    expect(state.session.writes).toBe(1);
    await pi.fire({ type: "session_start", reason: "new" });
    expect(state.session.writes).toBe(0);
  });
});
`,

  // 用普通字符串数组拼：README 里全是反引号，塞进模板字符串会炸
  "README.md": [
    "# {{NAME}}",
    "",
    "由 pition 的 `new-extension.mjs` 生成：注入机械在 `src/injection/`（从 pition 复制，零外部依赖），",
    "领域内容在 `src/state.ts` / `src/scenes.ts` / `src/spec.ts`。",
    "",
    "## 下一步",
    "",
    "1. `npm install`",
    "2. `npm test` —— 先让生成的 4 条自检全绿（它们就是这份骨架的验收标准）",
    "3. 改这三个文件：",
    "   - `src/state.ts` —— 加你的动态事实（时间锚点已给好）",
    "   - `src/scenes.ts` —— 写你的场景与**带 when 的片段**",
    "   - `src/spec.ts` —— 填 tool 前缀、恒定层文案、降级文案；启用足迹裁剪（把 keptTools 换成 SCENES[scene].tools）",
    "4. 在 `extensions/{{NAME}}.ts` 里注册 tool（**无条件注册**，校验下沉到 execute 首行）",
    "5. 装到 pi：`pi install <本目录>`，或在 `~/.pi/agent/settings.json` 的 packages 里加本目录路径",
    "",
    "## 硬纪律（踩坑踩出来的，别违反）",
    "",
    "| 纪律 | 违反会怎样 |",
    "| --- | --- |",
    "| 只改 `promptGuidelines` / `sections` / `toolGuidelines`，禁 `forceSystemPrompt` | 整段替换 = prompt cache 全 miss |",
    "| 永不调 `setActiveTools`，只裁 guideline 文本 | 注册期门禁让「会话中现配的能力」永远不出现 |",
    "| 片段必须带 `when`，注入内容 = f(状态) | 固定长文塞进一堆当下不成立的内容 |",
    "| 每轮变的内容单独成段 | 稳定层跟着每轮重刷 cache |",
    "| 装配失败要降级（只写 core） | 这一轮在模型眼里变成「扩展不存在」 |",
    "| 内核目录不 import 领域模块 | 「整目录复制复用」悄悄失效 |",
    "",
    "完整教程见 `src/injection/README.md`。",
    "",
  ].join("\n"),
};

// ————————————————————————————————————————————————————————————————

function pascal(name) {
  return (
    name
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((p) => p[0].toUpperCase() + p.slice(1))
      .join("") || "My"
  );
}

function fill(template, tokens) {
  let out = template;
  for (const [k, v] of Object.entries(tokens)) out = out.replaceAll(`{{${k}}}`, v);
  return out;
}

/** 真正的生成动作（抛错而不是 process.exit —— 被测试 import 时不该把 vitest 一起关掉） */
export function generate({ target, name, prefix, force = false }) {
  const root = resolve(target);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`扩展名不合法：${name}（只允许小写字母 / 数字 / 连字符）`);
  }
  if (existsSync(root) && !force) {
    throw new Error(`目标目录已存在：${root}\n（要覆盖就加 --force；换个目录更安全）`);
  }
  const toolPrefix = prefix ?? `${name.replace(/-/g, "_")}_`;
  const tokens = { NAME: name, PREFIX: toolPrefix, PASCAL: pascal(name), PI_FLOOR: PI_FLOOR };

  // 1. 复制内核（整目录，逐字节——生成物与仓库里的是同一份）
  cpSync(KERNEL_DIR, join(root, "src", "injection"), { recursive: true });

  // 2. 生成骨架
  const written = [];
  for (const [rel, template] of Object.entries(T)) {
    const out = join(root, fill(rel, tokens));
    mkdirSync(join(out, ".."), { recursive: true });
    writeFileSync(out, fill(template, tokens), "utf8");
    // 统一成正斜杠：Windows 上 slice 出来是 `extensions\snip.ts`，断言与打印都不好写
    written.push(out.slice(root.length + 1).replaceAll("\\", "/"));
  }
  return { root, name, prefix: toolPrefix, floor: PI_FLOOR, files: written };
}

/** CLI 入口：返回退出码（不自己 exit，方便测试直接断言） */
export function main(argv, io = { log: console.log, err: console.error }) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || !positional.length) {
    io.log(USAGE);
    return flags.help ? 0 : 1;
  }

  try {
    const r = generate({
      target: positional[0],
      name: flags.name ?? basename(resolve(positional[0])),
      prefix: flags.prefix,
      force: flags.force,
    });
    io.log(`✅ 已生成扩展骨架：${r.root}`);
    io.log(`   扩展名 ${r.name} · tool 前缀 ${r.prefix} · pi 下界 >=${r.floor}`);
    for (const f of r.files) io.log(`   + ${f}`);
    io.log(`\n下一步：\n  cd ${r.root} && npm install && npm test`);
    io.log(`教程： ${r.root}/src/injection/README.md`);
    return 0;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

// 只有被直接 `node scripts/new-extension.mjs` 时才跑 CLI（被测试 import 时不要动 argv）
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
