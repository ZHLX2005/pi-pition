// pition_read 的实现：读当前 page 的完整内容（属性 + 所有正文 block）。
import { currentBinding } from "../config.ts";
import { notion } from "../notion.ts";
import { detail, type ReadParams, type ToolResponse } from "../types.ts";

export async function runRead(_params: ReadParams): Promise<ToolResponse> {
  const binding = currentBinding();
  const q = await notion(null, "POST", `/v1/databases/${binding.dbId}/query`, {
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    page_size: 1,
  });
  const latest = (q.results as any[])[0];
  if (!latest) {
    return {
      content: [
        {
          type: "text",
          text: `存储「${binding.title}」还没有任何 page（warning：定时任务今天可能没建，请确认 Notion automation）。agent 可调 pition_create_today 手动建一条。`,
        },
      ],
      details: detail({ store: binding.title, found: false, warning: "no_page_in_db" }),
    };
  }
  const blocks = await notion(null, "GET", `/v1/blocks/${latest.id}/children?page_size=100`);
  const props: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(latest.properties || {})) {
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
  const content = (blocks.results as any[])
    .map((b) => {
      if (b.type === "paragraph") return b.paragraph.rich_text.map((t: any) => t.plain_text).join("");
      return null;
    })
    .filter(Boolean);
  return {
    content: [{ type: "text", text: JSON.stringify({ properties: props, blocks: content }, null, 2) }],
    details: detail({
      store: binding.title,
      pageId: latest.id,
      url: latest.url,
      lastEdited: latest.last_edited_time,
    }),
  };
}
