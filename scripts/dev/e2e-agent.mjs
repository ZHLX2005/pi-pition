/**
 * pition E2E（真模型闭环）：起 pi 会话跑自然语言 → 观察是否调用 pition tool → 落到 Notion。
 *
 * 用法:
 *   PI_E2E_BASE_URL=https://api.minimaxi.com/anthropic \
 *   PI_E2E_TOKEN=sk-xxx \
 *   PI_E2E_MODEL=MiniMax-M3 \
 *   PI_E2E_PROVIDER=MiniMax \
 *   node scripts/dev/e2e-agent.mjs
 *
 * 前置:
 *   - 仓库根 npm install
 *   - pition.config.json 已配好（token + bindings）——E2E 会真的写 Notion
 *
 * 说明:
 *   模型通过 pi 的 registerProvider 动态注册（不需要 nx-as 的 store.json）。
 *   如果你的 pi 已配好默认 provider，不传环境变量也能跑（用 pi 默认模型）。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { piEntry, REPO_ROOT, repoPath } from "./resolve-pi.mjs";

const pi = await import(pathToFileURL(piEntry).href);

// ---- 可选：用环境变量注册一个临时 provider（免装 bearer 扩展）----
const {
  PI_E2E_BASE_URL: baseUrl,
  PI_E2E_TOKEN: token,
  PI_E2E_MODEL: modelId = "MiniMax-M3",
  PI_E2E_PROVIDER: providerName = "MiniMax",
} = process.env;

// 用独立 agentDir 避免污染用户真实 ~/.pi/agent
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const extDir = join(agentDir, "extensions");
mkdirSync(extDir, { recursive: true });

// 把本仓库源码挂进去（若用户没通过 packages 声明）
const shadowExt = join(extDir, "pition-e2e-shadow.ts");
const wroteShadow = !existsSync(shadowExt);
if (wroteShadow) {
  // 直接 re-export 本仓库扩展，避免复制文件
  const src = repoPath("extensions", "pition.ts");
  writeFileSync(shadowExt, `export { default } from ${JSON.stringify(pathToFileURL(src).href)};\n`, "utf8");
}

const resourceLoader = new pi.DefaultResourceLoader({ cwd: REPO_ROOT, agentDir });
await resourceLoader.reload();

// ---- 模型：环境变量优先，否则用 pi 默认 ----
let modelObj;
if (baseUrl && token) {
  const modelRuntime = await pi.ModelRuntime.create();
  const provider = {
    name: providerName,
    api: "anthropic-messages",
    baseUrl,
    apiKey: token,
    models: [{ id: modelId, name: modelId, contextWindow: 200000, maxTokens: 8192 }],
  };
  try {
    modelRuntime.registerProvider?.(provider);
  } catch {
    /* 老版本可能没这个 API，忽略 */
  }
  modelObj = modelRuntime.getModel(providerName, modelId);
  if (!modelObj) {
    console.error(`✗ 无法注册模型 ${providerName}/${modelId}（检查 PI_E2E_BASE_URL / TOKEN）`);
    process.exit(1);
  }
} else {
  console.log("（未传 PI_E2E_BASE_URL/TOKEN，使用 pi 默认模型）");
}

const { session } = await pi.createAgentSession({
  resourceLoader,
  sessionManager: pi.SessionManager.inMemory(),
  ...(modelObj ? { model: modelObj } : {}),
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

const cleanup = () => {
  if (wroteShadow && existsSync(shadowExt)) rmSync(shadowExt);
};

try {
  console.log("=== 测试 1: 自然语言 → 写入记录 ===");
  await session.prompt(
    "我在今天的晨会上定了三件事：评审 pition 插件、回复合作邮件、晚上跑步 5 公里。帮我把这条记录存进我的记录存储里。",
  );
  console.log(`\n→ tool 调用: ${toolCalls.join(", ") || "(无!)"}`);
  if (!toolCalls.some((t) => t.startsWith("pition_"))) {
    console.error("FAIL: agent 没有调用 pition tool");
    process.exitCode = 1;
  } else {
    console.log("\n=== 测试 2: 自然语言 → 读取确认 ===");
    toolCalls = [];
    await session.prompt("读一下我当前记录页里写了什么。");
    console.log(`\n→ tool 调用: ${toolCalls.join(", ") || "(无!)"}`);
    if (!toolCalls.some((t) => t.startsWith("pition_"))) {
      console.error("FAIL: 读取也没调 pition tool");
      process.exitCode = 1;
    } else {
      console.log("\nE2E PASS");
    }
  }
} finally {
  session.dispose();
  cleanup();
}
