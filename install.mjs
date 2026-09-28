#!/usr/bin/env node
// pition 安装/更新器：把插件与配置物化到 pi 的 agent 目录
//
// 用法：
//   node install.mjs                          # 用同目录 pition.config.json 安装到默认位置
//   node install.mjs --config ./my.json       # 指定配置文件
//   node install.mjs --agent-dir ~/.pi/agent  # 指定 pi agent 目录（默认 ~/.nx-as/pi-agent）
//
// 安装内容：
//   <agent-dir>/extensions/pition.ts           ← 本包 extensions/pition.ts（复制）
//   <agent-dir>/extensions/pition.config.json  ← 配置（token / 库绑定 / 字段描述）
//
// token 为空或没有绑定任何库时，会写入空绑定配置并提示（pi 加载时 pition 不注册 tool，无害）。

import { readFileSync, mkdirSync, copyFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---- 参数解析 ----
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
}

const here = dirname(fileURLToPath(import.meta.url));
const configFile = resolve(flag("config") || join(here, "pition.config.json"));
const agentDir = resolve(flag("agent-dir") || join(homedir(), ".nx-as", "pi-agent"));

// ---- 读配置 ----
if (!existsSync(configFile)) {
  console.error(`✗ 配置文件不存在: ${configFile}`);
  console.error("  复制 pition.config.json 为模板，填入 Notion integration token 和库绑定后再装。");
  process.exit(1);
}
let cfg;
try {
  cfg = JSON.parse(readFileSync(configFile, "utf8"));
} catch (e) {
  console.error(`✗ 配置不是合法 JSON: ${e.message}`);
  process.exit(1);
}
if (!cfg.token || typeof cfg.token !== "string") {
  console.error("✗ 配置缺少 token（Notion integration token，ntn_ 开头）");
  process.exit(1);
}
if (!Array.isArray(cfg.bindings)) cfg.bindings = [];

// ---- 校验绑定（本地静态检查，不联网）----
const FIELD_TYPES = new Set([
  "title", "rich_text", "number", "select", "multi_select",
  "status", "checkbox", "date", "url", "email", "phone_number",
]);
for (const b of cfg.bindings) {
  if (!b.dbId || !b.title) {
    console.error(`✗ 绑定缺 dbId 或 title: ${JSON.stringify(b).slice(0, 120)}`);
    process.exit(1);
  }
  for (const [name, meta] of Object.entries(b.fields || {})) {
    if (!FIELD_TYPES.has(meta.type)) {
      console.error(`✗ 绑定「${b.title}」字段「${name}」类型非法: ${meta.type}（允许: ${[...FIELD_TYPES].join(", ")}）`);
      process.exit(1);
    }
  }
}

// ---- 物化 ----
const extDir = join(agentDir, "extensions");
mkdirSync(extDir, { recursive: true });
const extTarget = join(extDir, "pition.ts");
const cfgTarget = join(extDir, "pition.config.json");
copyFileSync(join(here, "extensions", "pition.ts"), extTarget);
writeFileSync(cfgTarget, JSON.stringify(cfg, null, 2), "utf8");

console.log(`✓ 扩展:     ${extTarget}`);
console.log(`✓ 配置:     ${cfgTarget}`);
console.log(`  绑定存储: ${cfg.bindings.length ? cfg.bindings.map((b) => b.title).join("、") : "（无——agent 侧不会注册 pition tool）"}`);
console.log("\n重启 nx-as serve（或 pi 会话）后生效。");
