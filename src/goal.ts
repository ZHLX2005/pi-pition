// 目标（goal）状态机：按天持久的可量化条目列表，支持自动周期（cron）。
// 设计要点（全部来自 docs/goal-requirements.md 的用户决策）：
//   - **end 不结束 goal**：span 收尾只对条目做数字加法（progress += delta），
//     goal 生命期由日期决定，不受 span 影响
//   - **不需要主动重置**：无人工清理机制；一次性 goal 按 date 沉底保留；
//     自动周期 goal 跨天自动归零重开（这就是"重置"，不需要人动手）
//   - **自动周期用 cron 语法**：首次设置即可指定（daily 或 5 段 cron——
//     只消费 日/月/星期 字段做「今天是否重开」判断；goal 粒度是天，时分不参与）
//   - **进度允许超出**：显示时 min(progress, target)，实际值保留（超额完成也是完成度）
import { newSpanId } from "./span.ts";
import { toLocalIsoString, toYmd } from "./time.ts";
import type { ActiveGoal, GoalAutoPeriod, GoalItem, PitionConfig } from "./types.ts";

/** 生成唯一 goal id（复用 newSpanId 的时间戳+随机后缀模式） */
export function newGoalId(now: Date = new Date()): string {
  return newSpanId(now).replace(/^span_/, "goal_");
}

/** 今天的 YYYY-MM-DD（本地时区） */
export function todayYmd(now: Date = new Date()): string {
  return toYmd(now);
}

/**
 * 校验 autoPeriod：接受 "daily" 或 5 段 cron 表达式（如 "0 6 * * 1,3,5"）。
 * v1 限制：只消费 日(dom)/月(month)/星期(dow) 三个字段判断「今天是否重开」，
 * 分/时字段忽略——goal 的粒度是「天」，时分刻度对按天目标无意义。
 *
 * cron 必须**在此处完整解析校验**（非法字段 set 时就拒绝）——否则毒丸 goal 落盘后
 * 每次物化都崩，连 update/delete 都无法自救。
 */
export function checkAutoPeriod(autoPeriod: string | undefined | null): GoalAutoPeriod | undefined {
  if (autoPeriod === undefined || autoPeriod === null || autoPeriod === "") return undefined;
  const v = String(autoPeriod).trim();
  if (v === "daily") return v;
  if (/^(\S+\s+){4}\S+$/.test(v)) {
    cronMatchesToday(v, new Date(2026, 0, 1)); // 用固定日期跑一遍完整解析——非法字段在此抛错
    return v as GoalAutoPeriod;
  }
  throw new Error(`autoPeriod 接受 "daily" 或 5 段 cron 表达式（如 "0 6 * * 1,3,5" = 周一三五重开）：${autoPeriod}`);
}

/** cron 单字段解析：支持 * 、数字、范围 a-b、步进 *&#47;n 或 a-b/n；返回命中的集合 */
function cronFieldValues(field: string, min: number, max: number): Set<number> | null {
  if (field === "*") return null; // null = 不限
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron 步进非法: ${part}`);
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const m = range.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) throw new Error(`cron 字段非法: ${field}`);
      lo = Number(m[1]);
      hi = m[2] !== undefined ? Number(m[2]) : lo;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron 字段越界: ${field}（允许 ${min}-${max}）`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/**
 * cron 表达式今天是否命中（5 段：分 时 日 月 星期；只看 日/月/星期）。
 * 标准 cron 语义：dom 与 dow 都被限定时取 OR，其中之一被限定时取 AND。
 * 星期：0 与 7 都=周日（对齐 cron）；JS getDay() 本来就 0=周日。
 */
export function cronMatchesToday(expr: string, now: Date = new Date()): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron 表达式须 5 段（分 时 日 月 星期）: ${expr}`);
  const dom = cronFieldValues(fields[2], 1, 31);
  const month = cronFieldValues(fields[3], 1, 12);
  const dowRaw = cronFieldValues(fields[4], 0, 7);
  const dow = dowRaw ? new Set([...dowRaw].map((d) => (d === 7 ? 0 : d))) : null;
  if (month && !month.has(now.getMonth() + 1)) return false;
  if (!dom && !dow) return true;
  if (dom && dow) return dom.has(now.getDate()) || dow.has(now.getDay());
  if (dom) return dom.has(now.getDate());
  return dow ? dow.has(now.getDay()) : true;
}

/** goal 今天是否自动重开（autoPeriod 语义） */
export function goalRecursToday(goal: ActiveGoal, now: Date = new Date()): boolean {
  if (!goal.autoPeriod) return false;
  if (goal.autoPeriod === "daily") return true;
  return cronMatchesToday(goal.autoPeriod, now);
}

/** 深拷贝条目并把进度归零（跨天重开用） */
function zeroedItems(items: GoalItem[]): GoalItem[] {
  return items.map((it) => ({ ...it, progress: 0 }));
}

/** YYYY-MM-DD → Date（本地时区正午，避免 DST 边界）；非法返回 null */
function parseYmd(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
}

/** 两个 YYYY-MM-DD 之间隔的天数（a - b） */
function daysBetween(a: string, b: string): number {
  const da = parseYmd(a);
  const db = parseYmd(b);
  if (!da || !db) return 0;
  return Math.round((da.getTime() - db.getTime()) / 86_400_000);
}

/** 判断一个 goal 实例在上一个执行日是否真的执行过（存在任何 progress > 0） */
function hadActivity(g: ActiveGoal): boolean {
  return g.items.some((it) => it.progress > 0);
}

/**
 * 自动周期物化（**原地重开**模型）：autoPeriod goal 且 date < 今天且今天命中 →
 * date 前移到今天、进度归零（同 goalId，历史进度已实时写入 Notion 正文/属性，插件内不留重复记录）。
 * 记录 missedDays（上个执行日到今天的间隔）；上个执行日零活动时注入侧会给 agent 出「自检查」提示。
 * 今天不命中的 cron goal 保持沉睡（date 不动，今天不渲染）。一次性 goal 不动。
 * 返回新数组；与原数组引用相同 = 无变化（调用方据此决定是否落盘）。
 */
export function materializeGoals(goals: ActiveGoal[], now: Date = new Date()): ActiveGoal[] {
  const today = todayYmd(now);
  let changed = false;
  const out = goals.map((g) => {
    if (g.date < today && goalRecursToday(g, now)) {
      changed = true;
      return {
        ...g,
        date: today,
        items: zeroedItems(g.items),
        missedDays: hadActivity(g) ? 0 : Math.max(0, daysBetween(today, g.date)),
      };
    }
    return g;
  });
  return changed ? out : goals;
}

/** 读今天的 goal 列表（含自动周期物化）；materialized 有变化时由调用方负责落盘 */
export function todayGoals(
  goals: ActiveGoal[],
  now: Date = new Date(),
): { list: ActiveGoal[]; materialized: ActiveGoal[] } {
  const materialized = materializeGoals(goals, now);
  const today = todayYmd(now);
  return { list: materialized.filter((g) => g.date === today), materialized };
}

/**
 * 建新 goal 落到指定日期（缺省今天）。
 * 同日已有普通 goal：不带 replace 抛错提示；replace:true 覆盖。
 * 自动周期 goal 不参与同日判重（模板可随时建/改，由 cron 控制重开节奏）。
 * items 必须非空且 target 为正——goal 的本质是可量化，否则退化成清单。
 */
export function setGoal(
  cfg: PitionConfig,
  params: {
    title: string;
    items: Array<{ name: string; target: number; unit?: string }>;
    autoPeriod?: string;
    bindField?: string;
    date?: string;
    replace?: boolean;
    note?: string;
  },
  now: Date = new Date(),
): { cfg: PitionConfig; goal: ActiveGoal; replaced: boolean } {
  const title = params.title?.trim();
  if (!title) throw new Error("action=set 必须传 title");
  if (!Array.isArray(params.items) || params.items.length === 0) {
    throw new Error("action=set 必须传非空 items（可量化条目列表：{name, target, unit?}）");
  }
  const autoPeriod = checkAutoPeriod(params.autoPeriod);
  const date = params.date?.trim() || todayYmd(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`date 必须是 YYYY-MM-DD 格式：${date}`);
  // 未来日期的 goal 在 list/注入里永远不可见（只渲染今天），是"set 成功却查无此 goal"的经典来源
  // （模型在凌晨算错今天日期是高发场景）——set 时直接拒绝。
  if (date > todayYmd(now)) {
    throw new Error(
      `date 不能是未来日期（${date} > 今天 ${todayYmd(now)}）。目标归属今天就不传 date；补录历史才传过去日期`,
    );
  }

  const goals = cfg._activeGoals ?? [];
  const existingIdx = autoPeriod ? -1 : goals.findIndex((g) => g.date === date && !g.autoPeriod);
  if (existingIdx >= 0 && !params.replace) {
    const old = goals[existingIdx];
    throw new Error(
      `${date} 已有目标「${old.title}」。重新规划请显式传 replace:true（会覆盖）；查看进度用 action=list`,
    );
  }
  const replaced = existingIdx >= 0;

  const goal: ActiveGoal = {
    goalId: newGoalId(now),
    title,
    period: "day",
    date,
    items: buildGoalItems(params.items),
    autoPeriod,
    bindField: params.bindField?.trim() || undefined,
    note: params.note?.trim() || undefined,
    createdAt: toLocalIsoString(now),
  };

  const nextGoals = replaced ? goals.map((g, i) => (i === existingIdx ? goal : g)) : [...goals, goal];
  return { cfg: { ...cfg, _activeGoals: nextGoals }, goal, replaced };
}

/** 条目构造 + 校验（set/update 共用） */
function buildGoalItems(items: Array<{ name: string; target: number; unit?: string }>): GoalItem[] {
  return items.map((it) => {
    if (!it?.name?.trim()) throw new Error("条目缺 name");
    const target = Number(it.target);
    if (!Number.isFinite(target) || target <= 0) {
      throw new Error(`条目「${it.name}」的 target 必须是正数：${it.target}`);
    }
    return { name: it.name.trim(), target, progress: 0, unit: it.unit?.trim() || undefined };
  });
}

export interface ProgressGoalResult {
  cfg: PitionConfig;
  goal: ActiveGoal;
  item: GoalItem;
  /** 全部条目都达到 target */
  completed: boolean;
  /** 整体完成度 0-100（逐项 min 封顶） */
  percent: number;
}

/**
 * 定位操作的 goal：goalId 精确匹配；省略时只允许今天唯一，多个报错列出候选
 * （progress / update / delete 共用同一契约——绝不静默取第一个）。
 * 返回 [物化后的 goals 数组, 命中下标]；goals 已含自动周期物化。
 */
function locateGoal(goals: ActiveGoal[], goalId: string | undefined, now: Date): { goals: ActiveGoal[]; idx: number } {
  const today = todayYmd(now);
  const idxs = goals
    .map((g, i) => [g, i] as const)
    .filter(([g]) => g.goalId === goalId || (!goalId && g.date === today));
  if (!idxs.length) {
    throw new Error(
      goalId ? `没有 goalId 为「${goalId}」的目标（今天: ${today}）` : `今天（${today}）没有目标——先用 action=set 建`,
    );
  }
  if (idxs.length > 1) {
    const names = idxs.map(([g]) => `「${g.title}」(${g.goalId})`).join("、");
    throw new Error(`今天有 ${idxs.length} 个目标，必须传 goalId 指定：${names}`);
  }
  return { goals, idx: idxs[0][1] };
}

/**
 * 进度控制（三选一）：delta 数字加法（默认 1，可负回退）/ value 绝对值设置 / reset 归零。
 * goalId 省略时仅今天的一个 goal 才行，多个报错列出候选；
 * 条目不存在报错并列出全部 item 名。自动周期模板跨天先物化再推进。
 */
export function progressGoal(
  cfg: PitionConfig,
  params: { goalId?: string; itemName: string; delta?: number; value?: number; reset?: boolean },
  now: Date = new Date(),
): ProgressGoalResult {
  const itemName = params.itemName?.trim();
  if (!itemName) throw new Error("action=progress 必须传 itemName");
  const modes = [params.delta !== undefined, params.value !== undefined, params.reset === true].filter(Boolean).length;
  if (modes > 1) throw new Error("delta / value / reset 只能传一个");

  const { goals, idx } = locateGoal(materializeGoals(cfg._activeGoals ?? [], now), params.goalId, now);
  const goal = goals[idx];

  const item = goal.items.find((it) => it.name === itemName);
  if (!item) {
    const names = goal.items.map((it) => `「${it.name}」`).join("、");
    throw new Error(`目标「${goal.title}」里没有条目「${itemName}」。现有条目：${names}`);
  }
  if (params.value !== undefined) {
    const v = Number(params.value);
    if (!Number.isFinite(v) || v < 0) throw new Error(`value 必须是非负数字：${params.value}`);
    item.progress = v;
  } else if (params.reset === true) {
    item.progress = 0;
  } else {
    const delta = params.delta === undefined ? 1 : Number(params.delta);
    if (!Number.isFinite(delta)) throw new Error(`delta 必须是数字：${params.delta}`);
    item.progress += delta;
  }

  return {
    cfg: { ...cfg, _activeGoals: goals },
    goal,
    item,
    completed: goalCompleted(goal),
    percent: goalPercent(goal),
  };
}

/**
 * 更新 goal（CRUD 的 U）：改 title / items（同名条目保留进度，新条目从 0 起）/ bindField /
 * autoPeriod / note，**不动进度**。goalId 省略时定位今天唯一 goal。
 */
export function updateGoal(
  cfg: PitionConfig,
  params: {
    goalId?: string;
    title?: string;
    items?: Array<{ name: string; target: number; unit?: string }>;
    bindField?: string | null;
    autoPeriod?: string | null;
    note?: string | null;
  },
  now: Date = new Date(),
): { cfg: PitionConfig; goal: ActiveGoal } {
  const { goals, idx } = locateGoal(materializeGoals(cfg._activeGoals ?? [], now), params.goalId, now);
  const prev = goals[idx];
  const itemsParam = params.items;
  const hasItems = Array.isArray(itemsParam) && itemsParam.length > 0;
  if (itemsParam !== undefined && !hasItems)
    throw new Error("items 若传必须是非空数组（清空条目请直接 delete 后重建）");

  const nextItems: GoalItem[] = hasItems
    ? buildGoalItems(itemsParam ?? []).map((fresh) => {
        const old = prev.items.find((it) => it.name === fresh.name);
        return old ? { ...fresh, progress: old.progress } : fresh;
      })
    : prev.items;

  const next: ActiveGoal = {
    ...prev,
    title: params.title?.trim() || prev.title,
    items: nextItems,
    bindField: params.bindField === null ? undefined : params.bindField?.trim() || prev.bindField,
    autoPeriod: params.autoPeriod === null ? undefined : checkAutoPeriod(params.autoPeriod ?? prev.autoPeriod),
    note: params.note === null ? undefined : params.note?.trim() || prev.note,
  };
  const out = [...goals];
  out[idx] = next;
  return { cfg: { ...cfg, _activeGoals: out }, goal: next };
}

/**
 * 删除 goal（CRUD 的 D）。goalId 省略时删今天唯一 goal（多个报错列候选）；
 * 删的是自动周期模板 = 之后不再自动重开。
 */
export function deleteGoal(
  cfg: PitionConfig,
  params: { goalId?: string },
  now: Date = new Date(),
): { cfg: PitionConfig; removed: ActiveGoal; remaining: number } {
  const { goals, idx } = locateGoal(materializeGoals(cfg._activeGoals ?? [], now), params.goalId, now);
  const removed = goals[idx];
  const rest = goals.filter((_, i) => i !== idx);
  return { cfg: { ...cfg, _activeGoals: rest }, removed, remaining: rest.length };
}

/** 整体完成度百分比（按 target 加权和；逐项封顶，整体恒在 0-100） */
export function goalPercent(goal: ActiveGoal): number {
  const totalTarget = goal.items.reduce((s, it) => s + it.target, 0);
  if (!totalTarget) return 0;
  return Math.round((goal.items.reduce((s, it) => s + Math.min(it.progress, it.target), 0) / totalTarget) * 100);
}

/** 是否全部条目达标 */
export function goalCompleted(goal: ActiveGoal): boolean {
  return goal.items.length > 0 && goal.items.every((it) => it.progress >= it.target);
}

/**
 * 单行属性摘要（给绑定字段覆写用，与注入渲染共用同一进度计算）。
 * 例：`俯卧撑 2/4 轮 · 平板支撑 0/3 组（40%）`；全达标加 `✅ ` 前缀。
 */
export function renderGoalSummary(goal: ActiveGoal): string {
  const parts = goal.items.map(
    (it) => `${it.name} ${Math.min(it.progress, it.target)}/${it.target}${it.unit ? ` ${it.unit}` : ""}`,
  );
  const check = goalCompleted(goal) ? "✅ " : "";
  return `${check}${parts.join(" · ")}（${goalPercent(goal)}%）`;
}

/**
 * 渲染注入文本——**只渲染今天的 goal**；自动周期 goal 跨天自动归零重开；
 * 今天不命中的 cron goal 不出现。无今日 goal 返回空串（调用方以空判跳过注入）。
 */
export function renderGoalsStatus(goals: ActiveGoal[], now: Date = new Date()): string {
  const { list: todays } = todayGoals(goals, now);
  if (!todays.length) return "";
  const lines = todays.map((goal) => {
    const items = goal.items
      .map((it) => `${it.name} ${Math.min(it.progress, it.target)}/${it.target}${it.unit ? ` ${it.unit}` : ""}`)
      .join(" ｜ ");
    const recur = goal.autoPeriod ? (goal.autoPeriod === "daily" ? "（每天）" : `（cron: ${goal.autoPeriod}）`) : "";
    const missed =
      goal.missedDays && goal.missedDays >= 2
        ? ` ⚠️ 已连续 ${goal.missedDays} 天未执行——询问用户是否调整目标（update 条目/降 target/清除自动周期）`
        : "";
    return `- 「${goal.title}」${recur}：${items}（共 ${goalPercent(goal)}%）${missed}`;
  });
  return (
    `🎯 今日目标 ${todays.length} 个：\n${lines.join("\n")}\n` +
    `   → 用户每完成一组/一轮会告诉你；agent 及时报进度 + 鼓励 + 提示下一项，` +
    `完成即调 pition_goal action=progress 推进（做组/次数/时长型目标直接 progress）。\n` +
    `   → 需计时的长任务（跑步/球类）才开 span；span end 可带 goalItemName/goalDelta 一次完成收尾+推进。\n` +
    `   → 全部达标后：庆祝 + 可帮用户回看本月完成情况（pition_history 翻旧账）。`
  );
}
