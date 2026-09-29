// pition_history 的实现：显式查 page 列表（翻旧账用，不是默认心智）。
import { currentBinding } from "../config.ts";
import { notion } from "../notion.ts";
import { detail, type HistoryParams, type ToolResponse } from "../types.ts";

export async function runHistory(params: HistoryParams): Promise<ToolResponse> {
  const binding = currentBinding();
  const body: Record<string, unknown> = {
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    page_size: Math.min(Math.max(params.limit ?? 10, 1), 50),
  };
  if (params.filter) {
    const { field, op, value } = params.filter;
    const meta = binding.fields[field];
    if (!meta)
      throw new Error(`存储「${binding.title}」没有字段「${field}」。可用: ${Object.keys(binding.fields).join("、")}`);
    body.filter =
      meta.type === "checkbox"
        ? { property: field, checkbox: { equals: Boolean(value) } }
        : meta.type === "number"
          ? { property: field, number: { equals: Number(value) } }
          : {
              property: field,
              [op === "contains" ? "rich_text" : meta.type]: {
                [op === "contains" ? "contains" : "equals"]: String(value),
              },
            };
  }
  const data = await notion(null, "POST", `/v1/databases/${binding.dbId}/query`, body);
  const rows = (data.results as any[]).map((page) => {
    const props: Record<string, unknown> = {};
    for (const [name, p] of Object.entries(page.properties || {})) {
      const anyProp = p as any;
      if (anyProp.title) props[name] = anyProp.title.map((t: any) => t.plain_text).join("");
      else if (anyProp.rich_text) props[name] = anyProp.rich_text.map((t: any) => t.plain_text).join("");
      else if (anyProp.select) props[name] = anyProp.select?.name ?? null;
      else if (anyProp.multi_select) props[name] = anyProp.multi_select.map((o: any) => o.name).join(", ");
      else if (anyProp.checkbox !== undefined) props[name] = anyProp.checkbox;
      else if (anyProp.number !== undefined) props[name] = anyProp.number;
      else if (anyProp.date) props[name] = anyProp.date?.start ?? null;
      else if (anyProp.status) props[name] = anyProp.status?.name ?? null;
    }
    return { id: page.id, last_edited: page.last_edited_time, ...props };
  });
  return {
    content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
    details: detail({ store: binding.title, count: rows.length, page_list_kind: true }),
  };
}
