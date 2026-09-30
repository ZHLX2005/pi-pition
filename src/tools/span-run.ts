// pition_span 的实现：区间事件 —— start 落盘、end 收尾并把整段写入当前 page。
import { currentBinding, loadConfig, saveConfig } from "../config.ts";
import { progressGoal } from "../goal.ts";
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
  let pageId: string | undefined;
  if (latest) {
    pageId = latest.id;
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

  // —— goal 联动（D1：end 不结束 goal，只对条目做数字加法）——
  // 放在 span 落盘之后：联动失败/未命中绝不影响 span 本身（正文已写入、cfg 已保存）。
  // 关键：基于 result.cfg（endSpan 已剔除该 span）推进，progressGoal 返回的新 cfg
  // 才不会把刚结束的 span 复活回磁盘。
  let goalNote = "";
  if (params.goalItemName) {
    try {
      const g = progressGoal(result.cfg, {
        goalId: undefined,
        itemName: params.goalItemName,
        delta: params.goalDelta,
      });
      saveConfig(g.cfg);
      goalNote = `\n📈 目标「${g.item.name}」推进到 ${g.item.progress}/${g.item.target}${g.item.unit ? ` ${g.item.unit}` : ""}，整体 ${g.percent}%${
        g.completed ? " 🎉 今日目标全部完成！" : ""
      }`;
    } catch (e) {
      goalNote = `\n（目标推进未生效: ${(e as Error).message}——可用 pition_goal action=list 查看今日条目）`;
    }
  }

  const stillActive = result.stillActive.length
    ? `（仍在进行：${result.stillActive.map((s) => `「${s.eventName}」`).join("、")}）`
    : "";
  return {
    content: [
      {
        type: "text",
        text: `✅ 「${result.span.eventName}」已结束（持续 ${result.elapsedText}），已写入「${binding.title}」当前 page。${stillActive}${goalNote}`,
      },
    ],
    details: detail({
      action: "end",
      span: result.span,
      pageId,
      paragraphText: result.paragraphText,
      elapsedMin: result.elapsedMin,
      elapsedText: result.elapsedText,
      stillActive: result.stillActive,
    }),
  };
}
