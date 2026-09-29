// 诊断：完整复刻 CLI 会话装配，看扩展工具是否进 session
import { homedir } from "node:os";
import { join } from "node:path";
const PI = "D:/a_js/js_proj/nx-as/node_modules/.pnpm/@earendil-works+pi-coding-agent@0.87.1_ws@8.21.3/node_modules/@earendil-works/pi-coding-agent";
const pi = await import(`file:///${PI}/dist/index.js`.replace(/\\/g, "/"));

const agentDir = join(homedir(), ".pi", "agent");
const rl = new pi.DefaultResourceLoader({ cwd: "D:/a_js/js_proj/nx-as", agentDir });
await rl.reload();
const ext = rl.getExtensions();
console.log("extensions:", ext.extensions.map((e) => e.resolvedPath ?? e.path));
console.log("tools collected at load:", ext.extensions.flatMap((e) => [...(e.tools?.keys?.() ?? [])]));

const { session } = await pi.createAgentSession({
  resourceLoader: rl,
  sessionManager: pi.SessionManager.inMemory(),
});
const all = session.getAllTools?.() ?? [];
console.log("session tools:", all.map((t) => t.name ?? t));
session.dispose();
