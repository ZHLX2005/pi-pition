// 加载冒烟：模拟 pi 的 jiti loader，验证 extensions/pition.ts 能加载并注册 tool + 设置命令。
//
// jiti + pi 包都从仓库自身 node_modules 拿（CI 走 npm ci 后能 resolve），不硬编码路径。
//
// 配置隔离：通过 PITION_CONFIG 环境变量把配置路径指向**临时文件**，
// 绝不触碰仓库里的真实 pition.config.json（此前是就地覆盖 + 事后还原，
// 加载失败时会丢掉用户的真 token）。
//
// 为什么要写临时配置：tool 注册虽然不依赖配置（无条件注册），但工厂里 bootCtx
// 等运行态信息要读 cfg。给一份最小配置让加载路径完整走通。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// 脚本在 scripts/ 下，仓库根是上一级
const scriptDir = dirname(fileURLToPath(import.meta.url));
const here = join(scriptDir, "..");
const piEntry = join(here, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
const typeboxEntry = join(here, "node_modules", "typebox", "build", "index.mjs");

const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": piEntry,
    typebox: typeboxEntry,
  },
});

const extPath = `file:///${join(here, "extensions", "pition.ts").replace(/\\/g, "/")}`;

// 在临时目录放一份最小配置，并用 PITION_CONFIG 指过去 —— 真实配置全程不被读写。
const smokeDir = mkdtempSync(join(tmpdir(), "pition-smoke-"));
const configPath = join(smokeDir, "pition.config.json");
writeFileSync(
  configPath,
  JSON.stringify(
    {
      token: "ntn_smoke_dummy_token_for_jiti_load_only",
      bindings: {
        "smoke-db-id-0000": {
          dbId: "smoke-db-id-0000",
          title: "smoke",
          fields: { Name: { type: "title", description: "smoke" } },
        },
      },
      currentBindingId: "smoke-db-id-0000",
    },
    null,
    2,
  ),
);
process.env.PITION_CONFIG = configPath;
const cleanupCfg = () => rmSync(smokeDir, { recursive: true, force: true });

const mod = await jiti.import(extPath);
console.log("extension loaded, default export:", typeof mod.default);

const tools = [];
const commands = [];
const listeners = [];
const fakePi = {
  registerTool: (t) => tools.push(`${t.name} (${Object.keys(t.parameters?.properties || {}).join("/")})`),
  registerCommand: (name, opts) => commands.push(`${name} — ${opts.description || ""}`),
  on: (event, _handler) => {
    listeners.push(event);
  },
  registerShortcut: () => {},
  registerFlag: () => {},
};
mod.default(fakePi);
cleanupCfg();

console.log("registered tools:");
for (const t of tools) console.log("  -", t);
console.log("registered commands:");
for (const c of commands) console.log("  -", c);

// 契约级校验：pition_boot 必须满足 5 阶段契约
const bootDef = tools.find((t) => t.startsWith("pition_boot "));
if (!bootDef) {
  console.error("FAIL: 未注册 pition_boot 元工具");
  process.exit(1);
}
// 重新加载取真实 def
const probeMod = await jiti.import(extPath);
const bootCaptured = [];
probeMod.default({
  registerTool: (t) => {
    if (t.name === "pition_boot") bootCaptured.push(t);
  },
  registerCommand: () => {},
  on: () => () => {},
  registerShortcut: () => {},
  registerFlag: () => {},
});
const def = bootCaptured[0];
const stages = def.parameters?.properties?.stage?.anyOf?.map((s) => s.const) ?? [];
const expectedStages = ["token", "select_db", "describe_fields", "set_mode", "done"];
for (const s of expectedStages) {
  if (!stages.includes(s)) {
    console.error(`FAIL: pition_boot 缺 stage=${s}`);
    process.exit(1);
  }
}
if (!def.promptGuidelines || def.promptGuidelines.length < 3) {
  console.error("FAIL: pition_boot 缺 promptGuidelines（agent 调用约定）");
  process.exit(1);
}
// set_mode 必须有 enabled 参数
const setModeProps = Object.keys(def.parameters?.properties ?? {});
if (!setModeProps.includes("enabled")) {
  console.error("FAIL: pition_boot 缺 enabled 参数（set_mode 阶段需要）");
  process.exit(1);
}
console.log("pition_boot 5 阶段契约校验通过 (token / select_db / describe_fields / set_mode / done)");

// 7 tool：1 个元工具（pition_boot）+ 6 个运行态 tool
// pition_stores 已删（description 静态拼 storeCtx → 切库后看到旧字段名）；
// pition_query 已删（与 pition_history 实现完全重复，统一用 history）。
const expectedTools = [
  "pition_boot",
  "pition_create_today",
  "pition_goal",
  "pition_read",
  "pition_write",
  "pition_history",
  "pition_span",
];
const missing = expectedTools.filter((n) => !tools.some((line) => line.startsWith(`${n} `)));
if (missing.length) {
  console.error(`FAIL: 缺少 tool: ${missing.join(", ")}`);
  process.exit(1);
}
if (tools.length !== expectedTools.length) {
  console.error(`FAIL: 期望 ${expectedTools.length} 个 tool，实得 ${tools.length}`);
  process.exit(1);
}
if (!commands.some((c) => c.startsWith("pition "))) {
  console.error("FAIL: 未注册 /pition 设置命令");
  process.exit(1);
}
if (!commands.some((c) => c.startsWith("pition-mode "))) {
  console.error("FAIL: 未注册 /pition-mode 切换命令");
  process.exit(1);
}
if (!listeners.includes("before_agent_start")) {
  console.error("FAIL: 未订阅 before_agent_start");
  process.exit(1);
}
if (!listeners.includes("session_start")) {
  console.error("FAIL: 未订阅 session_start");
  process.exit(1);
}

// 真跑 before_agent_start handler：抓 ReferenceError（修复了 currentSpan hoist 后必须能跑）
// 不跑的话 ReferenceError 要到 pi 真启动才会暴露——smoke 之前会漏。
const handlers = {};
const probePi = {
  registerTool: () => {},
  registerCommand: () => {},
  on: (event, handler) => {
    handlers[event] = handler;
  },
  registerShortcut: () => {},
  registerFlag: () => {},
};
const handlerProbeMod = await jiti.import(extPath);
handlerProbeMod.default(probePi);
if (!handlers.before_agent_start) {
  console.error("FAIL: before_agent_start handler 没注册");
  process.exit(1);
}
try {
  await handlers.before_agent_start({
    systemPromptOptions: { promptGuidelines: [], sections: {} },
  });
  console.log("before_agent_start handler 真跑通过（无 ReferenceError）");
} catch (e) {
  console.error(`FAIL: before_agent_start handler 抛错：${e.message}\n${e.stack}`);
  process.exit(1);
}
cleanupCfg();
console.log("SMOKE PASS");
