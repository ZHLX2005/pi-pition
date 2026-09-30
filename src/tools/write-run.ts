// pition_write 的实现：日常主路径 —— 改当前 page 属性 + 追加正文，并返回 todaySoFar 预览。
import { currentBinding } from "../config.ts";
import { notion } from "../notion.ts";
import { blocksToText, contentToBlocks, mergeProperties, readPageProperties } from "../properties.ts";
import { prefixClockToContent, toDate, toLocalIsoString } from "../time.ts";
import { detail, type ToolResponse, type WriteParams } from "../types.ts";

export async function runWrite(params: WriteParams): Promise<ToolResponse> {
  const binding = currentBinding();
  if (!params.properties && !params.appendContent) throw new Error("properties 和 appendContent 至少传一个");
  const when = toDate(params.timestamp);
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
          text: `WARNING: 存储「${binding.title}」还没有任何 page——可能是定时任务没建。Agent 可调 pition_create_today 手动建一条。`,
        },
      ],
      details: detail({ store: binding.title, found: false, warning: "no_page_in_db" }),
    };
  }
  if (params.properties) {
    // 需要先读 page 现有 properties 才能做 append 合并。
    // 全部 overwrite=true 才跳过读；任一 append 都得读。
    const needsMerge = params.properties.some((p) => !p.overwrite);
    const snapshot = needsMerge
      ? readPageProperties(await notion(null, "GET", `/v1/pages/${latest.id}`).then((p: any) => p.properties ?? {}))
      : {};
    const merged = mergeProperties(binding, snapshot, params.properties);
    await notion(null, "PATCH", `/v1/pages/${latest.id}`, { properties: merged });
  }
  if (params.appendContent) {
    const bodyText =
      params.prefixTimestamp === false ? params.appendContent : prefixClockToContent(params.appendContent, when);
    const blocks = contentToBlocks(bodyText);
    await notion(null, "PATCH", `/v1/blocks/${latest.id}/children`, { children: blocks });
  }
  // 写入后立刻读一次 page 全部内容——返回里附 todaySoFar 让模型直接预览 + 追问
  const [pageAfter, blocks] = await Promise.all([
    notion(null, "GET", `/v1/pages/${latest.id}`),
    notion(null, "GET", `/v1/blocks/${latest.id}/children?page_size=100`),
  ]);
  const propsSnapshot = readPageProperties(pageAfter.properties ?? {});
  // 属性按字段说明渲染：field.type/description 加当前值——看板场景下模型拿到能直接复述
  const propsBlock =
    Object.entries(binding.fields)
      .map(([name, meta]) => {
        const v = propsSnapshot[name];
        if (v === undefined || v === null || v === "") return null;
        const vStr = Array.isArray(v) ? v.join(", ") : String(v);
        return `  - ${name} (${meta.type})${meta.description ? ` — ${meta.description}` : ""}: ${vStr}`;
      })
      .filter(Boolean)
      .join("\n") || "  （无）";
  const contentBlock = blocksToText(blocks.results as any[]);
  const todaySoFar = `属性:\n${propsBlock}\n\n正文:\n${contentBlock || "（空）"}`;
  return {
    content: [
      {
        type: "text",
        text: `已写入「${binding.title}」当前 page: ${latest.url}\n\n—— 今日该 page 已记 ——\n${todaySoFar}`,
      },
    ],
    details: detail({
      store: binding.title,
      pageId: latest.id,
      url: latest.url,
      timestamp: toLocalIsoString(when),
      prefixTimestamp: params.prefixTimestamp !== false,
      todaySoFar,
      todayProperties: propsSnapshot,
      todayContent: contentBlock,
    }),
  };
}
