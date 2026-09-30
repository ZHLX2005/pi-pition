// pition 领域类型 —— 配置 / 库绑定 / 字段元数据 / 区间事件
// 无运行时依赖，可被任何模块安全 import。

/** 可写的 Notion 字段类型（formula/relation/rollup 等计算字段不可写） */
export const WRITABLE_TYPES = [
  "title",
  "rich_text",
  "number",
  "select",
  "multi_select",
  "status",
  "checkbox",
  "date",
  "url",
  "email",
  "phone_number",
] as const;

/** 单个 Notion 字段的元信息（type 决定写入格式；description 是给 agent 的语义说明） */
export interface FieldMeta {
  type: string;
  description?: string;
}

/** 一个已绑定的 Notion 库 */
export interface Binding {
  dbId: string;
  title: string;
  description?: string;
  fields: Record<string, FieldMeta>;
}

/** 进行中的区间事件（pition_span start 写入，end 移除） */
export interface ActiveSpan {
  /** 唯一 id */
  spanId: string;
  /** 事件名，如 "开会" / "跑步" / "午休" */
  eventName: string;
  /** 备注 */
  note?: string;
  /** ISO 字符串；渲染时现算 (now - startedAt) 得累计时长 */
  startedAt: string;
}

/** 自动周期类型（goal 首次设置即可指定）：daily 或 5 段 cron（只消费 日/月/星期字段） */
export type GoalAutoPeriod = "daily" | string;

/**
 * goal 的单个可量化条目（进度 = progress += delta 数字加法）
 */
export interface GoalItem {
  name: string;
  target: number;
  progress: number;
  unit?: string;
}

/**
 * 按天持久的目标（无自动重置/清理——按 date 天然分区，注入只渲染今天，历史沉底保留）。
 *
 * 自动周期（autoPeriod="daily"）的 goal 是**模板**：date 是模板创建日（或最近物化日），
 * 新的一天首次被读取/推进时自动物化一份今日实例（进度归零，模板 date 前移）。
 */
export interface ActiveGoal {
  /** 唯一 id（goal_<ts>_<rand>） */
  goalId: string;
  title: string;
  /** 周期类型；v1 仅 day（字段预留扩展） */
  period: "day";
  /** 归属日期 YYYY-MM-DD（本地时区）；模板的 date 随物化前移 */
  date: string;
  items: GoalItem[];
  /** 自动周期；缺省无（一次性当日 goal，跨天沉底） */
  autoPeriod?: GoalAutoPeriod;
  /**
   * 上个执行日零活动的连续天数（物化时记录；执行过=0）。
   * ≥2 时注入侧提示 agent「连续 N 天未执行，询问用户是否调整目标」。
   */
  missedDays?: number;
  /** 绑定当前库的一个可写字段：进度变化时把完成摘要覆写进去（Notion 看板直读；可选投影） */
  bindField?: string;
  note?: string;
  /** ISO 字符串（本地时区） */
  createdAt: string;
}

/** pition 的持久化配置（pition.config.json） */
export interface PitionConfig {
  token: string;
  /** 所有已描述过的库都保留（key = dbId）；切空间/重选时不丢字段 desc */
  bindings: Record<string, Binding>;
  /** 当前默认操作的库 id；切空间 = 改这个值 */
  currentBindingId: string | null;
  /** 助理模式开关；缺省 false（首次装完不自动注入） */
  _assistantMode?: boolean;
  /** 进行中的 span（可并行多个） */
  _activeSpans?: ActiveSpan[];
  /** 按天持久的目标（无自动重置，按 date 分区） */
  _activeGoals?: ActiveGoal[];
}

/** tool execute 返回的 details 统一类型（避免 pi 的 union 推导炸类型） */
type ToolDetails = Record<string, unknown>;

/** 统一 details 出口：多分支返回不同 details 形状会推成 union 而炸类型，经此 helper 类型恒定 */
export function detail(fields: ToolDetails): ToolDetails {
  return fields;
}

/** pi 的 tool execute 返回形状：content（给模型看的文本）+ details（结构化，UI/状态用） */
export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  details: ToolDetails;
}

/** 属性条目（pition_write / pition_create_today 共用） */
export interface PropertyEntry {
  name: string;
  value: string | number | boolean;
  /** true=整段覆盖；缺省=false 按字段类型 append 合并 */
  overwrite?: boolean;
}

/** pition_boot 的参数 */
export interface BootParams {
  stage: "token" | "select_db" | "describe_fields" | "set_mode" | "done";
  token?: string;
  dbId?: string;
  fieldDescriptions?: Array<{ name: string; description: string }>;
  bindingDescription?: string;
  bindingTitle?: string;
  enabled?: boolean;
}

/** pition_write 的参数 */
export interface WriteParams {
  properties?: PropertyEntry[];
  appendContent?: string;
  timestamp?: string | number;
  prefixTimestamp?: boolean;
}

/** pition_create_today 的参数 */
export interface CreateTodayParams {
  properties: PropertyEntry[];
  content?: string;
  timestamp?: string | number;
  prefixContent?: boolean;
}

/** pition_read 的参数（当前无参数；pi 对空 schema 传 object，保持签名一致以便将来扩展） */
export type ReadParams = object;

/** pition_history 的参数 */
export interface HistoryParams {
  limit?: number;
  filter?: { field: string; op: "equals" | "contains"; value: string | number | boolean };
}

/** pition_span 的参数 */
export interface SpanParams {
  action: "start" | "end";
  eventName?: string;
  note?: string;
  summary?: string;
  /** action=end 可选：收尾后把 goalDelta 加到今日 goal 该条目（联动 pition_goal） */
  goalItemName?: string;
  /** action=end 可选：推进量，默认 1 */
  goalDelta?: number;
}

/** pition_goal 的参数 */
export interface GoalParams {
  action: "set" | "progress" | "list" | "update" | "delete";
  /** action=set：目标标题 */
  title?: string;
  /** action=set/update：可量化条目列表（update 同名条目保留进度） */
  items?: Array<{ name: string; target: number; unit?: string }>;
  /**
   * action=set/update：自动周期（首次设置即可指定）。"daily" 或 5 段 cron
   * （如 "0 6 * * 1,3,5" = 周一三五重开；只消费 日/月/星期字段，时分忽略——goal 粒度是天）。
   * update 传 null 清除。
   */
  autoPeriod?: GoalAutoPeriod | null;
  /** action=set/update：绑定当前库的一个可写字段（进度摘要覆写展示；冷设置可不传）。update 传 null 清除 */
  bindField?: string | null;
  /** action=set：同日已有 goal 时须显式 true 才覆盖 */
  replace?: boolean;
  /** action=set：归属日期 YYYY-MM-DD，缺省今天（补录历史日用） */
  date?: string;
  /** action=progress/update/delete：定位哪个 goal（省略=今天唯一） */
  goalId?: string;
  /** action=progress/update：推进哪条（按 item.name 匹配） */
  itemName?: string;
  /** action=progress：数字加法推进量，默认 1（可负回退）；与 value/reset 互斥 */
  delta?: number;
  /** action=progress：绝对值设置（非负）；与 delta/reset 互斥 */
  value?: number;
  /** action=progress：归零该条目；与 delta/value 互斥 */
  reset?: boolean;
  /** action=set/update：备注。update 传 null 清除 */
  note?: string | null;
}
