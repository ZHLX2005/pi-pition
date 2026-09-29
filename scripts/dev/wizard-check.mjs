// 向导逻辑验证：不依赖 TUI，用源码同款逻辑跑 列表库 → 取 schema → 过滤可写字段
//
// 用法: node scripts/dev/wizard-check.mjs
// 前置: 仓库根有 pition.config.json（含真实 Notion token）
import { readFileSync } from "node:fs";
import { createNotionClient } from "./notion-fetch.mjs";
import { repoPath } from "./resolve-pi.mjs";

const cfg = JSON.parse(readFileSync(repoPath("pition.config.json"), "utf8"));
const api = createNotionClient(cfg.token);

const WRITABLE = [
  "title",
  "rich_text",
  "number",
  "select",
  "multi_select",
  "status",
  "checkbox",
  "date",
  "url",
  "email",
  "phone_number",
];

// 1. whoami
const me = await api("GET", "/v1/users/me");
console.log("[1] 工作区:", me.bot?.workspace_name);

// 2. 列表库（分页）
const dbs = [];
let cursor;
for (let i = 0; i < 5; i++) {
  const body = { filter: { property: "object", value: "database" }, page_size: 100 };
  if (cursor) body.start_cursor = cursor;
  const r = await api("POST", "/v1/search", body);
  for (const x of r.results ?? []) {
    dbs.push({
      id: x.id,
      title: (x.title ?? []).map((t) => t.plain_text).join("") || "(无标题)",
      n: Object.keys(x.properties ?? {}).length,
    });
  }
  if (!r.has_more) break;
  cursor = r.next_cursor;
}
console.log(`[2] 库总数: ${dbs.length}`);

// 3. 取当前绑定库的 schema，过滤可写字段（优先用 cfg.currentBindingId）
const boundId = cfg.currentBindingId;
const target =
  (boundId && dbs.find((d) => d.id === boundId)) ??
  dbs.find((d) => d.title === cfg.bindings?.[boundId]?.title) ??
  dbs[0];
if (!target) {
  console.error("FAIL: token 看不到任何库");
  process.exit(1);
}
const db = await api("GET", `/v1/databases/${target.id}`);
const writable = [];
const skipped = [];
for (const [name, prop] of Object.entries(db.properties ?? {})) {
  (WRITABLE.includes(prop.type) ? writable : skipped).push(`${name}(${prop.type})`);
}
console.log(`[3] 「${target.title}」可写字段: ${writable.join(", ")}`);
console.log(`    跳过(计算类): ${skipped.join(", ") || "无"}`);

// 4. 与 cfg 里记的字段做一致性核对（配置漂移检测）
if (boundId && cfg.bindings?.[boundId]) {
  const cfgFields = new Set(Object.keys(cfg.bindings[boundId].fields ?? {}));
  const liveFields = new Set(Object.keys(db.properties ?? {}).filter((n) => WRITABLE.includes(db.properties[n].type)));
  const missingInCfg = [...liveFields].filter((n) => !cfgFields.has(n));
  const staleInCfg = [...cfgFields].filter((n) => !liveFields.has(n));
  if (missingInCfg.length)
    console.log(
      `    ⚠ 库里新字段但 cfg 未记录: ${missingInCfg.join(", ")}（跑 pition_boot stage=select_db dbId=${boundId} 接管）`,
    );
  if (staleInCfg.length) console.log(`    ⚠ cfg 有但库里已无: ${staleInCfg.join(", ")}`);
  if (!missingInCfg.length && !staleInCfg.length) console.log("    cfg 与库 schema 一致");
}
console.log("WIZARD LOGIC PASS");
