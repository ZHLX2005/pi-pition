// pition_goal 的实现：set / progress / list / update / delete 五个 action（完整 CRUD + 进度控制）。
// 状态机在 src/goal.ts（纯函数、有单测）——这里只做绑定字段同步（Notion IO）与文案。
//
// **冷设置**（FR8）：goal 数据持久在插件内部配置（pition.config.json 的 _activeGoals），
// 未配置 Notion（无 token/绑定库）时全部 action 可用；bindField 是可选投影，
// 仅在「已配置且字段存在」时同步，缺席/失败不影响 goal 本体。
import { currentBinding, loadConfig, saveConfig } from "../config.ts";
import {
  deleteGoal,
  goalPercent,
  progressGoal,
  renderGoalSummary,
  setGoal,
  todayGoals,
  todayYmd,
  updateGoal,
} from "../goal.ts";
import { notion } from "../notion.ts";
import { toNotionProperty } from "../properties.ts";
import { detail, type GoalParams, type ToolResponse } from "../types.ts";

/** 冷设置容错：读绑定库（可能未配置 → null） */
function bindingIfConfigured(): {
  dbId: string;
  title: string;
  fields: Record<string, { type: string; description?: string }>;
} | null {
  try {
    return currentBinding();
  } catch {
    return null;
  }
}

/**
 * 把 goal 完成摘要覆写进绑定字段（当前 page）。
 * 可选投影：无绑定库（冷设置）/无 page/写入失败都**不抛错**——goal 状态已落盘，
 * 属性展示是锦上添花。返回 undefined=成功，string=失败原因，null=没写（无绑定/无 page）。
 */
async function writeGoalToPage(
  params: { dbId: string; bindField: string; fieldType: string; summary: string },
  pageId?: string,
): Promise<string | undefined | null> {
  let targetId = pageId;
  if (!targetId) {
    const q = await notion(null, "POST", `/v1/databases/${params.dbId}/query`, {
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: 1,
    });
    targetId = (q.results as any[])[0]?.id;
  }
  if (!targetId) return null;
  try {
    await notion(null, "PATCH", `/v1/pages/${targetId}`, {
      properties: { [params.bindField]: toNotionProperty(params.fieldType, params.summary) },
    });
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

/** 同步绑定字段（尽力而为）；返回给文案附注的括号说明（空串=成功或没绑） */
async function trySyncBindField(
  binding: { dbId: string; fields: Record<string, { type: string }> } | null,
  goal: { bindField?: string; items: any[] },
  pageId?: string,
): Promise<string> {
  if (!goal.bindField) return "";
  if (!binding) return "（未配置 Notion，进度只存插件内部——冷设置模式）";
  const fieldType = binding.fields[goal.bindField]?.type;
  if (!fieldType) return `（绑定字段「${goal.bindField}」已不在库 schema 里，跳过属性同步）`;
  const err = await writeGoalToPage(
    { dbId: binding.dbId, bindField: goal.bindField, fieldType, summary: renderGoalSummary(goal as any) },
    pageId,
  );
  if (err === null) return "（当前库还没有 page，属性待首个 page 建好后同步）";
  if (err) return `（属性同步失败: ${err}）`;
  return "";
}

/** progress 成功后给 agent 的行为钩子文案 */
function celebrateText(
  item: { name: string; progress: number; target: number; unit?: string },
  completed: boolean,
): string {
  const left = item.target - item.progress;
  if (completed) return "🎉 今日目标全部完成！记得帮用户把当日小结写入 Notion（pition_write）。";
  if (left > 0) return `「${item.name}」还剩 ${left}——给用户明确的鼓励和下一步提示。`;
  return `「${item.name}」已达标（超出 ${-left}）！`;
}

export async function runGoal(params: GoalParams): Promise<ToolResponse> {
  const cfg = loadConfig();
  if (!cfg) throw new Error("pition 未配置");
  const binding = bindingIfConfigured();

  if (params.action === "set") {
    // bindField 只在已配置时校验；冷设置（无绑定库）不校验（没有 schema 可对照）
    if (params.bindField && binding) requireBindableField(binding, params.bindField);
    const { cfg: next, goal, replaced } = setGoal(cfg, params as any);
    saveConfig(next);
    const syncNote = await trySyncBindField(binding, goal);
    const verb = replaced ? "已覆盖" : "已建立";
    const recurNote = goal.autoPeriod
      ? goal.autoPeriod === "daily"
        ? "（自动周期：每天）"
        : `（自动周期 cron: ${goal.autoPeriod}）`
      : "";
    return {
      content: [
        {
          type: "text",
          text: `🎯 ${verb}目标「${goal.title}」（${goal.date}）${recurNote}${syncNote}：${renderGoalSummary(goal)}\n进度会自动注入每次对话。每完成一组/一轮 → 我直接 progress 推进并报进度；需计时的长任务（跑步/球类）说「开始 xx」我会记 span，结束时一次完成收尾+推进。`,
        },
      ],
      details: detail({ action: "set", goal, replaced, bindFieldSync: syncNote || "ok" }),
    };
  }

  if (params.action === "progress") {
    const r = progressGoal(cfg, {
      goalId: params.goalId,
      itemName: params.itemName ?? "",
      delta: params.delta,
      value: params.value,
      reset: params.reset,
    });
    saveConfig(r.cfg);
    const syncNote = await trySyncBindField(binding, r.goal);
    return {
      content: [
        {
          type: "text",
          text: `📈 「${r.item.name}」推进到 ${r.item.progress}/${r.item.target}${r.item.unit ? ` ${r.item.unit}` : ""}，整体 ${r.percent}%。${celebrateText(r.item, r.completed)}${syncNote}`,
        },
      ],
      details: detail({
        action: "progress",
        goalId: r.goal.goalId,
        item: r.item,
        percent: r.percent,
        completed: r.completed,
        bindFieldSync: syncNote || "ok",
      }),
    };
  }

  if (params.action === "update") {
    const { cfg: next, goal } = updateGoal(cfg, params as any);
    saveConfig(next);
    const syncNote = await trySyncBindField(binding, goal);
    return {
      content: [
        {
          type: "text",
          text: `✏️ 已更新目标「${goal.title}」${syncNote}：${renderGoalSummary(goal)}\n（条目同名保留进度，新条目从 0 起；autoPeriod 传 null 可清除自动周期）`,
        },
      ],
      details: detail({ action: "update", goal, bindFieldSync: syncNote || "ok" }),
    };
  }

  if (params.action === "delete") {
    const { cfg: next, removed, remaining } = deleteGoal(cfg, { goalId: params.goalId });
    saveConfig(next);
    return {
      content: [
        {
          type: "text",
          text: `🗑 已删除目标「${removed.title}」（${removed.autoPeriod ? "自动周期一并移除，之后不再重开" : removed.date}）。剩余目标 ${remaining} 个。`,
        },
      ],
      details: detail({ action: "delete", removed: removed.goalId, remaining }),
    };
  }

  // action === "list"（物化今日实例并落盘——跨天首次 list/注入自动开新的一天）
  const today = todayYmd();
  const { list, materialized } = todayGoals(cfg._activeGoals ?? []);
  if (materialized !== (cfg._activeGoals ?? [])) saveConfig({ ...cfg, _activeGoals: materialized });
  if (!list.length) {
    // 自诊断：为空时报告插件内还存着什么、今天几号——set 传错日期 / 状态被清可当场看出
    const others = (cfg._activeGoals ?? [])
      .slice(-3)
      .map((g) => `「${g.title}」@${g.date}${g.autoPeriod ? `(${g.autoPeriod === "daily" ? "每天" : "cron"})` : ""}`)
      .join("、");
    const hint = others
      ? `。插件内现存（按 date 分区，只渲染今天）：${others}——若有目标但日期不是 ${today}，说明 set 时 date 传错了（重 set 不带 date 即可）`
      : "——用 action=set 建一个";
    return {
      content: [{ type: "text", text: `今天（${today}）还没有目标${hint}` }],
      details: detail({ action: "list", goals: [], today, storedGoals: (cfg._activeGoals ?? []).length }),
    };
  }
  return {
    content: [
      {
        type: "text",
        text: `🎯 今日目标：\n${list
          .map(
            (g) =>
              `- 「${g.title}」：${g.items
                .map((it) => `${it.name} ${it.progress}/${it.target}${it.unit ? ` ${it.unit}` : ""}`)
                .join("、")}（${goalPercent(g)}%）${g.bindField ? ` [绑定字段: ${g.bindField}]` : ""}`,
          )
          .join("\n")}`,
      },
    ],
    details: detail({ action: "list", goals: list }),
  };
}

/** 字段不存在时给 agent 的可用字段清单错误 */
function requireBindableField(
  binding: { title: string; fields: Record<string, { type: string }> },
  bindField: string,
): void {
  if (!binding.fields[bindField]) {
    throw new Error(
      `存储「${binding.title}」没有字段「${bindField}」，无法绑定。可用字段: ${Object.keys(binding.fields).join("、")}`,
    );
  }
}
