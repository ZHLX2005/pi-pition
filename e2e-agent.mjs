/**
 * pition E2E（真模型闭环）：bearer 扩展 + pition 扩展同装，起 pi 会话跑自然语言 → tool → Notion。
 *
 * 运行: node e2e-agent.mjs
 * 前置: ~/.nx-as/store.json 有 bearer* 配置；~/.nx-as/pi-agent/extensions/ 有 pition
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PI = "D:/a_js/js_proj/nx-as/node_modules/.pnpm/@earendil-works+pi-coding-agent@0.87.1_ws@8.21.3/node_modules/@earendil-works/pi-coding-agent";
const pi = await import(`file:///${PI}/dist/index.js`.replace(/\\/g, "/"));

const st = JSON.parse(readFileSync(join(homedir(), ".nx-as", "store.json"), "utf8")).settings;
const models = (st.bearerModels || "MiniMax-M3").split(",").map((s) => s.trim()).filter(Boolean);

// 装 e2e bearer 扩展（临时，测试后删）
const agentDir = join(homedir(), ".nx-as", "pi-agent");
writeFileSync(
  join(agentDir, "pition-e2e-bearer.json"),
  JSON.stringify({ provider: "MiniMax", baseUrl: st.bearerBaseUrl, models, token: st.bearerToken }),
);
copyFileSync(join(here, "e2e-bearer.ts"), join(agentDir, "extensions", "pition-e2e-bearer.ts"));

const resourceLoader = new pi.DefaultResourceLoader({ cwd: process.cwd(), agentDir });
await resourceLoader.reload();

// 从运行时模型表解析扩展注册的 MiniMax 模型（model 选项要传模型对象）
const modelRuntime = await pi.ModelRuntime.create();
const modelObj = modelRuntime.getModel("MiniMax", models[0]);
if (!modelObj) {
  console.error(`✗ 模型未注册: MiniMax/${models[0]}（bearer 扩展没生效）`);
  process.exit(1);
}

const { session } = await pi.createAgentSession({
  resourceLoader,
  sessionManager: pi.SessionManager.inMemory(),
  model: modelObj,
  tools: [], // 只留扩展注册的 pition tool
});

let toolCalls = [];
session.subscribe((event) => {
  if (event.type === "tool_execution_start") {
    toolCalls.push(event.toolName);
    console.log(`  [tool] ${event.toolName}`);
  } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

try {
  console.log("=== 测试 1: 自然语言 → 新建记录 ===");
  await session.prompt("我在今天的晨会上定了三件事：评审 pition 插件、回复合作邮件、晚上跑步 5 公里。帮我把这条记录存进我的记录存储里，标题写「晨会待办」。");
  console.log(`\n→ tool 调用: ${toolCalls.join(", ") || "(无!)"}`);
  if (!toolCalls.some((t) => t.startsWith("pition_"))) {
    console.error("FAIL: agent 没有调用 pition tool");
    process.exitCode = 1;
  } else {
    console.log("\n=== 测试 2: 自然语言 → 查询确认 ===");
    toolCalls = [];
    await session.prompt("查一下我的记录存储里最新的一条记录，告诉我标题是什么。");
    console.log(`\n→ tool 调用: ${toolCalls.join(", ") || "(无!)"}`);
    if (!toolCalls.some((t) => t.startsWith("pition_"))) {
      console.error("FAIL: 查询也没调 pition tool");
      process.exitCode = 1;
    } else {
      console.log("\nE2E PASS");
    }
  }
} finally {
  session.dispose();
}
