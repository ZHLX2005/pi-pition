// 诊断：DefaultResourceLoader 如何解析 ~/.pi/agent/settings.json 的 packages 声明
import { homedir } from "node:os";
import { join } from "node:path";

const PI = "D:/a_js/js_proj/nx-as/node_modules/.pnpm/@earendil-works+pi-coding-agent@0.87.1_ws@8.21.3/node_modules/@earendil-works/pi-coding-agent";
const pi = await import(`file:///${PI}/dist/index.js`.replace(/\\/g, "/"));

// 用户 pi 的真实环境：agentDir=~/.pi/agent，cwd=nx-as（用户在这里启动 pi）
const agentDir = join(homedir(), ".pi", "agent");
const cwd = "D:/a_js/js_proj/nx-as";

const rl = new pi.DefaultResourceLoader({ cwd, agentDir });
await rl.reload();
const r = rl.getExtensions();
console.log("== loaded extensions:", (r.extensions ?? []).length);
for (const e of r.extensions ?? []) console.log("  -", e.path ?? e.name ?? JSON.stringify(e).slice(0, 100));
console.log("== errors:", (r.errors ?? []).length);
for (const err of r.errors ?? []) console.log("  !", err.path ?? err.name ?? "", "→", err.error?.message ?? err.message ?? err.error ?? String(err).slice(0, 200));
