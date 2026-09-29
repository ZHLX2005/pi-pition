// 诊断：完整复刻 CLI 会话装配，看扩展工具是否进 session
//
// 用法: node scripts/dev/diag-session.mjs
// 前置: 仓库根 npm install
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { piEntry, REPO_ROOT } from "./resolve-pi.mjs";

const pi = await import(pathToFileURL(piEntry).href);

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const rl = new pi.DefaultResourceLoader({ cwd: REPO_ROOT, agentDir });
await rl.reload();
const ext = rl.getExtensions();
console.log(
  "extensions:",
  ext.extensions.map((e) => e.resolvedPath ?? e.path),
);
console.log(
  "tools collected at load:",
  ext.extensions.flatMap((e) => [...(e.tools?.keys?.() ?? [])]),
);

const { session } = await pi.createAgentSession({
  resourceLoader: rl,
  sessionManager: pi.SessionManager.inMemory(),
});
const all = session.getAllTools?.() ?? [];
console.log(
  "session tools:",
  all.map((t) => t.name ?? t),
);
session.dispose();
