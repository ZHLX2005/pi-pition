// 诊断：DefaultResourceLoader 如何解析 packages 声明（本仓库作为包源）
//
// 用法: node scripts/dev/diag-loader.mjs
// 前置: 仓库根 npm install（提供 pi 包），~/.pi/agent/settings.json 的 packages 含本仓库路径
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { piEntry, REPO_ROOT } from "./resolve-pi.mjs";

const pi = await import(pathToFileURL(piEntry).href);

// agentDir 可用 PI_CODING_AGENT_DIR 覆盖（隔离环境/容器用）；cwd 默认本仓库
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const cwd = REPO_ROOT;

const rl = new pi.DefaultResourceLoader({ cwd, agentDir });
await rl.reload();
const r = rl.getExtensions();
console.log("agentDir:", agentDir);
console.log("cwd:", cwd);

const extensions = r.extensions ?? [];
console.log("== loaded extensions:", extensions.length);
console.log("== raw keys:", Object.keys(r));
for (const e of extensions) console.log("  -", e.path ?? e.name ?? JSON.stringify(e).slice(0, 100));

// errors 字段名各版本不同，扫描已知候选
const errs = r.errors ?? r.diagnostics ?? [];
console.log("== errors:", errs.length);
for (const err of errs) {
  console.log(
    "  !",
    err.path ?? err.name ?? "",
    "→",
    err.error?.message ?? err.message ?? err.error ?? String(err).slice(0, 200),
  );
}
