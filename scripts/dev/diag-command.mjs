// 验证 /pition 命令是否注册进 pi 的命令表
//
// 用法: node scripts/dev/diag-command.mjs
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
const cmds = ext.extensions.flatMap((e) => [...(e.commands?.keys?.() ?? [])]);
console.log("registered commands:", cmds);
console.log("has /pition:", cmds.includes("pition") ? "YES" : "NO");
console.log("has /pition-mode:", cmds.includes("pition-mode") ? "YES" : "NO");

if (!cmds.includes("pition")) process.exit(1);
