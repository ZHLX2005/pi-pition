// Notion 数据库发现与 schema 读取（配置向导与 pition_boot 共用）。
import { notionWith } from "./notion.ts";
import { type FieldMeta, WRITABLE_TYPES } from "./types.ts";

export interface DbOption {
  id: string;
  title: string;
  fieldCount: number;
}

/** 列出该 token 可访问的库（该 integration 在 Notion 里被「连接」过的） */
export async function listDatabases(token: string): Promise<DbOption[]> {
  const out: DbOption[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const body: Record<string, unknown> = {
      filter: { property: "object", value: "database" },
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;
    const res = await notionWith(token, "POST", "/v1/search", body);
    for (const r of res.results ?? []) {
      out.push({
        id: r.id,
        title: (r.title ?? []).map((t: any) => t.plain_text).join("") || "(无标题)",
        fieldCount: Object.keys(r.properties ?? {}).length,
      });
    }
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return out;
}

/** 取库 schema，只保留可写字段（formula/relation/rollup 等计算类过滤掉） */
export async function fetchFields(token: string, dbId: string): Promise<Record<string, FieldMeta>> {
  const db = await notionWith(token, "GET", `/v1/databases/${dbId}`);
  const fields: Record<string, FieldMeta> = {};
  for (const [name, prop] of Object.entries(db.properties ?? {})) {
    const type = (prop as any).type as string;
    if ((WRITABLE_TYPES as readonly string[]).includes(type)) {
      fields[name] = { type, description: "" };
    }
  }
  return fields;
}
