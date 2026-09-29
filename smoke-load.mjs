// 加载冒烟：模拟 pi 的 jiti loader，验证 extensions/pition.ts 能加载并注册 tool + 设置命令
// jiti + pi 包都从仓库自身 node_modules 拿（CI 环境走 npm ci 后能 resolve），不需要硬编码绝对路径
import { createJiti } from "jiti";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const piEntry = join(here, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
const typeboxEntry = join(here, "node_modules", "typebox", "build", "index.mjs");

const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": piEntry,
    typebox: typeboxEntry,
  },
});

const extPath = "file:///" + join(here, "extensions", "pition.ts").replace(/\\/g, "/");

// CI 环境没有 pition.config.json → factory 早返只注册 boot 不注册运行态 tool。
// 临时写一个最小 cfg（覆盖真 cfg；跑完即还原）让 jiti 走完整 registerTool 路径。
const configPath = join(here, "pition.config.json");
const realCfgBackup = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
writeFileSync(configPath, JSON.stringify({
  token: "ntn_smoke_dummy_token_for_jiti_load_only",
  bindings: {
    "smoke-db-id-0000": {
      dbId: "smoke-db-id-0000",
      title: "smoke",
      fields: {
        Name: { type: "title", description: "smoke" },
      },
    },
  },
  currentBindingId: "smoke-db-id-0000",
}, null, 2));
const restoreCfg = () => {
  if (realCfgBackup !== null) writeFileSync(configPath, realCfgBackup);
  else if (existsSync(configPath)) rmSync(configPath);
};

const mod = await jiti.import(extPath);
console.log("extension loaded, default export:", typeof mod.default);

const tools = [];
const commands = [];
const listeners = [];
const fakePi = {
  registerTool: (t) => tools.push(t.name + " (" + Object.keys(t.parameters?.properties || {}).join("/") + ")"),
  registerCommand: (name, opts) => commands.push(name + " — " + (opts.description || "")),
  on: (event, handler) => { listeners.push(event); },
  registerShortcut: () => {},
  registerFlag: () => {},
};
mod.default(fakePi);
restoreCfg();

console.log("registered tools:");
for (const t of tools) console.log("  -", t);
console.log("registered commands:");
for (const c of commands) console.log("  -", c);

// 契约级校验：pition_boot 必须满足 4 阶段契约
const bootTool = (() => {
  const captures = [];
  const probe = {
    registerTool: (t) => captures.push(t),
    registerCommand: () => {},
    on: () => () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
  };
  return { captures, probe };
})();
// 用首次注册的同名 tool 校验 stage 取值
const bootDef = tools.find((t) => t.startsWith("pition_boot "));
if (!bootDef) {
  console.error("FAIL: 未注册 pition_boot 元工具");
  process.exit(1);
}
// 重新加载取真实 def
const probeMod = await jiti.import(extPath);
const bootCaptured = [];
probeMod.default({
  registerTool: (t) => { if (t.name === "pition_boot") bootCaptured.push(t); },
  registerCommand: () => {}, on: () => () => {}, registerShortcut: () => {}, registerFlag: () => {},
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

// 6 tool：1 个元工具（pition_boot）+ 5 个运行态 tool（pition_create_today / pition_read / pition_write / pition_history / pition_span）
// pition_stores 已删（description 静态拼 storeCtx → 切库后看到旧字段名）；
// pition_query 已删（与 pition_history 实现完全重复，统一用 history）。
const expectedTools = ["pition_boot", "pition_create_today", "pition_read", "pition_write", "pition_history", "pition_span"];
const missing = expectedTools.filter((n) => !tools.some((line) => line.startsWith(n + " ")));
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
  on: (event, handler) => { handlers[event] = handler; },
  registerShortcut: () => {},
  registerFlag: () => {},
};
const handlerProbeMod = await jiti.import(extPath);
handlerProbeMod.default(probePi);
if (!handlers["before_agent_start"]) {
  console.error("FAIL: before_agent_start handler 没注册");
  process.exit(1);
}
try {
  await handlers["before_agent_start"]({
    systemPromptOptions: { promptGuidelines: [], sections: {} },
  });
  console.log("before_agent_start handler 真跑通过（无 ReferenceError）");
} catch (e) {
  console.error(`FAIL: before_agent_start handler 抛错：${e.message}\n${e.stack}`);
  process.exit(1);
}
console.log("SMOKE PASS");
