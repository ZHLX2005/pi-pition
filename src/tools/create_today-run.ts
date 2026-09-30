// pition_create_today 的实现：逃生口 —— 定时任务挂了时手动建当前 page。
import { currentBinding } from "../config.ts";
import { notion } from "../notion.ts";
import { buildProperties, contentToBlocks } from "../properties.ts";
import { autoFillDateProperty, prefixClockToContent, toDate, toLocalIsoString } from "../time.ts";
import { type CreateTodayParams, detail, type ToolResponse } from "../types.ts";

export async function runCreateToday(params: CreateTodayParams): Promise<ToolResponse> {
  const binding = currentBinding();
  const when = toDate(params.timestamp);
  const props = autoFillDateProperty(binding, params.properties, when);
  const page = await notion(null, "POST", "/v1/pages", {
    parent: { database_id: binding.dbId },
    properties: buildProperties(binding, props),
  });
  if (params.content) {
    const bodyText = params.prefixContent === false ? params.content : prefixClockToContent(params.content, when);
    const blocks = contentToBlocks(bodyText);
    await notion(null, "PATCH", `/v1/blocks/${page.id}/children`, { children: blocks });
  }
  return {
    content: [
      {
        type: "text",
        text: `已新建当前 page 到「${binding.title}」: ${page.url}（注意：定时任务可能挂了，请检查 Notion automation）`,
      },
    ],
    details: detail({
      store: binding.title,
      pageId: page.id,
      url: page.url,
      timestamp: toLocalIsoString(when),
      prefixContent: params.prefixContent !== false,
      escape: true,
    }),
  };
}
