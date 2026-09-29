// 向导逻辑验证：不依赖 TUI，用源码同款逻辑跑 列表库 → 取 schema → 过滤可写字段
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(here, "pition.config.json"), "utf8"));
const token = cfg.token;

const WRITABLE = ["title", "rich_text", "number", "select", "multi_select", "status", "checkbox", "date", "url", "email", "phone_number"];
const H = { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };
const api = async (m, p, b) => {
  const r = await fetch("https://api.notion.com" + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${j.code}: ${j.message}`);
  return j;
};

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
    dbs.push({ id: x.id, title: (x.title ?? []).map((t) => t.plain_text).join("") || "(无标题)", n: Object.keys(x.properties ?? {}).length });
  }
  if (!r.has_more) break;
  cursor = r.next_cursor;
}
console.log(`[2] 库总数: ${dbs.length}`);

// 3. 取一个库的 schema，过滤可写字段
const target = dbs.find((d) => d.title === "pition") ?? dbs[0];
const db = await api("GET", `/v1/databases/${target.id}`);
const writable = [];
const skipped = [];
for (const [name, prop] of Object.entries(db.properties ?? {})) {
  (WRITABLE.includes(prop.type) ? writable : skipped).push(`${name}(${prop.type})`);
}
console.log(`[3] 「${target.title}」可写字段: ${writable.join(", ")}`);
console.log(`    跳过(计算类): ${skipped.join(", ") || "无"}`);
console.log("WIZARD LOGIC PASS");
