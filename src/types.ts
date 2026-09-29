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
}

/** tool execute 返回的 details 统一类型（避免 pi 的 union 推导炸类型） */
export type ToolDetails = Record<string, unknown>;

/** 统一 details 出口：多分支返回不同 details 形状会推成 union 而炸类型，经此 helper 类型恒定 */
export function detail(fields: ToolDetails): ToolDetails {
  return fields;
}
