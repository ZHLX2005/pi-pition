// pition_span 的实现：区间事件 —— start 落盘、end 收尾并把整段写入当前 page。
import { currentBinding, loadConfig, saveConfig } from "../config.ts";
import { notion } from "../notion.ts";
import { endSpan, startSpan } from "../span.ts";
import { detail, type SpanParams, type ToolResponse } from "../types.ts";

export async function runSpan(params: SpanParams): Promise<ToolResponse> {
  const binding = currentBinding();
  const cfg = loadConfig();
  if (!cfg) throw new Error("pition 未配置");

  if (params.action === "start") {
    // 状态机在 src/span.ts（纯函数、有单测）——这里只做落盘与文案
    const { cfg: next, span, totalActive } = startSpan(cfg, params.eventName ?? "", params.note);
    saveConfig(next);
    const others = totalActive > 1 ? `（并行中还有 ${totalActive - 1} 件进行中）` : "";
    return {
      content: [
        {
          type: "text",
          text: `📍 已开始「${span.eventName}」${span.note ? `（${span.note}）` : ""}${others}。\n全局提示词的 pition_span section 会持续注入各事件累计时长（实际数字，不是占位符）。结束请调 pition_span action=end。`,
        },
      ],
      details: detail({ action: "start", span, totalActive }),
    };
  }

  // action === "end"：状态机算出正文，这里负责写 Notion + 落盘
  const result = endSpan(cfg, params.eventName, params.note, params.summary);
  const q = await notion(null, "POST", `/v1/databases/${binding.dbId}/query`, {
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    page_size: 1,
  });
  const latest = (q.results as any[])[0];
  if (latest) {
    await notion(null, "PATCH", `/v1/blocks/${latest.id}/children`, {
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ text: { content: result.paragraphText } }] },
        },
      ],
    });
  }
  saveConfig(result.cfg);
  const stillActive = result.stillActive.length
    ? `（仍在进行：${result.stillActive.map((s) => `「${s.eventName}」`).join("、")}）`
    : "";
  return {
    content: [
      {
        type: "text",
        text: `✅ 「${result.span.eventName}」已结束（持续 ${result.elapsedMin} 分钟），已写入「${binding.title}」当前 page。${stillActive}`,
      },
    ],
    details: detail({
      action: "end",
      span: result.span,
      pageId: latest?.id,
      paragraphText: result.paragraphText,
      elapsedMin: result.elapsedMin,
      stillActive: result.stillActive,
    }),
  };
}
