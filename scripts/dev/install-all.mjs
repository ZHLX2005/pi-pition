#!/usr/bin/env node
// install-all.mjs — 一键装到本机 pi agent 实例（默认只装用户主 pi）
//
// 默认扫描 { ~/.pi/agent }。nx-as 隔离沙箱（~/.nx-as/pi-agent）默认不装 —
// 它有自己的 token 注入链路（web 面板后台写入），手装反而会和它打架。
// 确实要装 nx-as 的话，加 --with-nx-as。
//
// 其它自定义目录用 --agent-dir 追加（逗号分隔）。
//
// 用法：
//   node install-all.mjs                          # 默认装 ~/.pi/agent
//   node install-all.mjs --with-nx-as             # 顺带装 ~/.nx-as/pi-agent
//   node install-all.mjs --config ./my.json       # 指定配置
//   node install-all.mjs --agent-dir /custom      # 追加目录（可多次）
//
// 与 install.mjs 的关系：单实例用 install.mjs；多实例用 install-all.mjs。

import { readFileSync, mkdirSync, copyFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  // 收集所有该 flag 的值（支持 --agent-dir 多次）
  const out = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j++) out.push(args[j]);
  return out.length ? out : undefined;
}

const here = dirname(fileURLToPath(import.meta.url));
const configFile = resolve((flag("config") ?? [""])[0] || join(here, "pition.config.json"));
const withNxAs = args.includes("--with-nx-as");
const extraDirs = (flag("agent-dir") ?? []).flatMap((v) => v.split(",").map((s) => s.trim()).filter(Boolean));

// ---- 默认只扫用户主 pi ----
const DEFAULT_DIRS = [
  join(homedir(), ".pi", "agent"),
];
if (withNxAs) DEFAULT_DIRS.push(join(homedir(), ".nx-as", "pi-agent"));

const targets = [...DEFAULT_DIRS, ...extraDirs];

// ---- 读 + 校验配置（沿用 install.mjs 同一套规则）----
if (!existsSync(configFile)) {
  console.error(`✗ 配置文件不存在: ${configFile}`);
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
      console.error(`✗ 绑定「${b.title}」字段「${name}」类型非法: ${meta.type}`);
      process.exit(1);
    }
  }
}

// ---- 扫描：哪些 agent 目录是真的"pi 实例" ----
// 判据（宽松，按优先级匹配任一即视为 pi 实例）：
//   1) settings.json 存在（用户主 pi 通常有）
//   2) extensions/ 子目录存在（已物化过或正在使用）
//   3) auth.json 存在（pi 至少启动过一次）
const isPiAgent = (d) => {
  if (!existsSync(d)) return false;
  return (
    existsSync(join(d, "settings.json")) ||
    existsSync(join(d, "extensions")) ||
    existsSync(join(d, "auth.json"))
  );
};
const candidates = targets.filter(isPiAgent);
const skipped = targets.filter((d) => !candidates.includes(d));

if (!candidates.length) {
  console.error("✗ 没找到任何 pi agent 实例（检查 ~/.pi/agent 和 ~/.nx-as/pi-agent 是否存在 + 含 settings.json）");
  console.error("  提示：用 --agent-dir <path> 手动追加目标目录");
  process.exit(1);
}

// ---- 冲突检测：settings.json packages 指向当前源码目录时，跳过物化 ----
// 源码声明 vs 本地 extensions/ 产物是两种加载形态，共存会重复实例化（5 tool × 2 + 2 命令 × 2，注册冲突）。
// install-all 只该处理「extensions/ 形态」；如果该 agent 已经走 packages 声明，跳过并提示用户二选一。
const conflicts = [];
const realCandidates = [];
for (const agentDir of candidates) {
  const settingsPath = join(agentDir, "settings.json");
  let skip = false;
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const pkgs = Array.isArray(settings.packages) ? settings.packages : [];
      const srcPath = resolve(here);
      if (pkgs.some((p) => resolve(p) === srcPath)) skip = true;
    } catch { /* 解析失败忽略 */ }
  }
  if (skip) conflicts.push(agentDir);
  else realCandidates.push(agentDir);
}

console.log(`找到 ${candidates.length} 个 pi agent 实例:`);
for (const d of candidates) console.log(`  · ${d}${conflicts.includes(d) ? " (已通过 settings.json packages 声明加载 → 跳过物化)" : ""}`);
if (skipped.length) {
  console.log(`跳过 ${skipped.length} 个不存在/无 settings.json 的目录:`);
  for (const d of skipped) console.log(`  · ${d}`);
}
if (conflicts.length) {
  console.log("");
  console.log("⚠ 以下实例已通过 settings.json packages 指向源码目录，install-all 不再写入 extensions/（避免重复加载）。");
  console.log("  如要切换为物化模式：先从 settings.json packages 移除该项，再跑 install-all。");
}
console.log("");

if (!realCandidates.length) {
  console.log("汇总: 0 物化（所有实例都已在 packages 里声明）");
  process.exit(0);
}

// ---- 物化：每个未冲突实例都复制 pition.ts + 写入 pition.config.json ----
const srcExt = join(here, "extensions", "pition.ts");
let okCount = 0, failCount = 0;

for (const agentDir of realCandidates) {
  const extDir = join(agentDir, "extensions");
  const extTarget = join(extDir, "pition.ts");
  const cfgTarget = join(extDir, "pition.config.json");
  try {
    mkdirSync(extDir, { recursive: true });
    copyFileSync(srcExt, extTarget);
    writeFileSync(cfgTarget, JSON.stringify(cfg, null, 2), "utf8");
    console.log(`✓ ${agentDir}`);
    console.log(`    扩展: ${extTarget}`);
    console.log(`    配置: ${cfgTarget}`);
    okCount++;
  } catch (e) {
    console.error(`✗ ${agentDir} 失败: ${e.message}`);
    failCount++;
  }
}

console.log("");
console.log(`汇总: ${okCount} 成功${failCount ? `, ${failCount} 失败` : ""}${conflicts.length ? `, ${conflicts.length} 跳过（已声明）` : ""} — 重启 pi 后生效。`);