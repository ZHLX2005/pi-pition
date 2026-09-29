// Notion property 的读写与合并语义。
//
// 简单值约定（LLM 只填标量，本模块负责转 Notion API 格式）：
//   title/rich_text → 字符串；number → 数字；select/multi_select → 选项名字符串；
//   checkbox → 布尔；date → "YYYY-MM-DD" 或 ISO；url/email/phone_number → 字符串
import type { Binding } from "./types.ts";

/** 简单值 → Notion property 格式 */
export function toNotionProperty(type: string, value: any): any {
  switch (type) {
    case "title":
      return { title: [{ text: { content: String(value) } }] };
    case "rich_text":
      return { rich_text: [{ text: { content: String(value) } }] };
    case "number":
      return { number: Number(value) };
    case "select":
      return { select: { name: String(value) } };
    case "multi_select": {
      const names = Array.isArray(value)
        ? value
        : String(value)
            .split(/[,，]/)
            .map((x: string) => x.trim())
            .filter(Boolean);
      return { multi_select: names.map((name: string) => ({ name })) };
    }
    case "status":
      return { status: { name: String(value) } };
    case "checkbox":
      return { checkbox: Boolean(value) };
    case "date":
      return { date: { start: String(value) } };
    case "url":
      return { url: String(value) };
    case "email":
      return { email: String(value) };
    case "phone_number":
      return { phone_number: String(value) };
    default:
      throw new Error(`暂不支持的字段类型: ${type}（请用面板调整该字段的用途或移除）`);
  }
}

/** 首次写入用：逐条转 Notion 格式（不做合并） */
export function buildProperties(
  binding: Binding,
  entries: Array<{ name: string; value: unknown }>,
): Record<string, any> {
  const out: Record<string, any> = {};
  for (const { name, value } of entries) {
    const type = binding.fields[name]?.type;
    if (!type) {
      throw new Error(
        `存储「${binding.title}」没有字段「${name}」。可用字段: ${Object.keys(binding.fields).join("、")}`,
      );
    }
    out[name] = toNotionProperty(type, value);
  }
  return out;
}

/** 把 Notion page 的 properties 渲染成「字段名 → 标量」快照，供合并使用 */
export function readPageProperties(pageProps: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(pageProps || {})) {
    const p = prop as any;
    if (p.title) out[name] = p.title.map((t: any) => t.plain_text).join("");
    else if (p.rich_text) out[name] = p.rich_text.map((t: any) => t.plain_text).join("");
    else if (p.select) out[name] = p.select?.name ?? null;
    else if (p.multi_select) out[name] = p.multi_select.map((o: any) => o.name);
    else if (p.checkbox !== undefined) out[name] = p.checkbox;
    else if (p.number !== undefined) out[name] = p.number;
    else if (p.date) out[name] = p.date?.start ?? null;
    else if (p.status) out[name] = p.status?.name ?? null;
  }
  return out;
}

/**
 * 按字段类型把 next 合并到 current：
 *   overwrite=true → 直接用 next
 *   multi_select → union；rich_text → 拼接「原 / 新」；number → 累加；date → 取更早；checkbox → OR
 *   其它（单值字段）→ 直接用 next
 */
export function mergePropertyValue(type: string, current: unknown, next: unknown, overwrite: boolean): unknown {
  if (overwrite) return next;
  if (current === undefined || current === null || current === "") return next;
  switch (type) {
    case "multi_select": {
      const cur = Array.isArray(current) ? (current as string[]) : [];
      const nxt = Array.isArray(next) ? (next as string[]) : [String(next)];
      return Array.from(new Set([...cur, ...nxt]));
    }
    case "rich_text":
      return `${current} / ${String(next)}`;
    case "number":
      return (Number(current) || 0) + (Number(next) || 0);
    case "date": {
      const a = String(current);
      const b = String(next);
      return a < b ? a : b;
    }
    case "checkbox":
      return Boolean(current) || Boolean(next);
    default:
      return next;
  }
}

/** 在现有快照上合并一批字段，返回 Notion API 形态 */
export function mergeProperties(
  binding: Binding,
  currentSnapshot: Record<string, unknown>,
  entries: Array<{ name: string; value: unknown; overwrite?: boolean }>,
): Record<string, any> {
  const out: Record<string, any> = {};
  for (const { name, value, overwrite } of entries) {
    const type = binding.fields[name]?.type;
    if (!type) {
      throw new Error(
        `存储「${binding.title}」没有字段「${name}」。可用字段: ${Object.keys(binding.fields).join("、")}`,
      );
    }
    out[name] = toNotionProperty(type, mergePropertyValue(type, currentSnapshot[name], value, !!overwrite));
  }
  return out;
}

/** 从 page 的 paragraph blocks 里抽纯文本（用于 todaySoFar 预览） */
export function blocksToText(blocks: any[]): string {
  return blocks
    .filter((b) => b?.type === "paragraph")
    .map((b) => (b.paragraph?.rich_text ?? []).map((t: any) => t.plain_text).join(""))
    .filter(Boolean)
    .join("\n\n");
}

/** 正文按 \n\n 切段 → Notion paragraph blocks */
export function contentToBlocks(bodyText: string): any[] {
  return bodyText
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((text) => ({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ text: { content: text } }] },
    }));
}
