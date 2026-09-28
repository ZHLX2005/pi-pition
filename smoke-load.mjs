// 加载冒烟：模拟 pi 的 jiti loader，验证 extensions/pition.ts 能加载并注册 tool + 设置命令
import { createJiti } from "file:///D:/a_js/js_proj/nx-as/node_modules/.pnpm/jiti@2.7.0/node_modules/jiti/lib/jiti.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PI = "D:/a_js/js_proj/nx-as/node_modules/.pnpm/@earendil-works+pi-coding-agent@0.87.1_ws@8.21.3/node_modules/@earendil-works/pi-coding-agent";
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": `${PI}/dist/index.js`,
    typebox: "D:/a_js/js_proj/nx-as/node_modules/.pnpm/typebox@1.3.27/node_modules/typebox/build/index.mjs",
  },
});

const extPath = "file:///" + join(here, "extensions", "pition.ts").replace(/\\/g, "/");
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

// 5 tool：1 个元工具（pition_boot）+ 4 个运行态 tool（pition_create_today / pition_read / pition_write / pition_history）
// pition_stores 已删（description 静态拼 storeCtx → 切库后看到旧字段名）；
// pition_query 已删（与 pition_history 实现完全重复，统一用 history）。
const expectedTools = ["pition_boot", "pition_create_today", "pition_read", "pition_write", "pition_history"];
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
console.log("SMOKE PASS");
