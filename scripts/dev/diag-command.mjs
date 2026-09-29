// 验证 /pition 命令是否注册进 pi 的命令表
import { homedir } from "node:os";
import { join } from "node:path";
const PI = "D:/a_js/js_proj/nx-as/node_modules/.pnpm/@earendil-works+pi-coding-agent@0.87.1_ws@8.21.3/node_modules/@earendil-works/pi-coding-agent";
const pi = await import(`file:///${PI}/dist/index.js`.replace(/\\/g, "/"));

const rl = new pi.DefaultResourceLoader({ cwd: "D:/a_js/js_proj/nx-as", agentDir: join(homedir(), ".pi", "agent") });
await rl.reload();
const ext = rl.getExtensions();
const cmds = ext.extensions.flatMap((e) => [...(e.commands?.keys?.() ?? [])]);
console.log("registered commands:", cmds);
console.log("has /pition:", cmds.includes("pition") ? "YES" : "NO");
