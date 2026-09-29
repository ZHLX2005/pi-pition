// tool 参数 schema 的共享片段。
//
// 注意：属性条目用 `{name, value}` 数组对而非 `Type.Record` ——
// 实测 MiniMax 对 Record 形态的嵌套对象参数解析会坏（字段名变 `$text`）。
import { Type } from "typebox";

/** 单个属性条目（pition_write / pition_create_today 共用） */
export const PROPERTY_ENTRY = Type.Object(
  {
    name: Type.String({ description: "字段名（必须与下列字段之一完全一致）" }),
    value: Type.Union([Type.String(), Type.Number(), Type.Boolean()], {
      description: "字段值：文本/数字/布尔（类型见 tool description 里的字段说明）",
    }),
    overwrite: Type.Optional(
      Type.Boolean({
        description:
          "默认 false=append 合并：multi_select union 选项、rich_text 拼接「原值 / 新值」、number 累加、date 取更早、checkbox 取 OR；true=整段覆盖。title/select/status/url/email/phone_number 单值字段此参数被忽略，永远是新值。",
      }),
    ),
  },
  { description: "一个字段" },
);

/** pition_history 的可选过滤条件 */
export const QUERY_FILTER_SCHEMA = Type.Object(
  {
    field: Type.String({ description: "字段名（必须是该存储已有字段）" }),
    op: Type.Union([Type.Literal("equals"), Type.Literal("contains")], {
      description: "equals=精确匹配，contains=文本包含",
    }),
    value: Type.Union([Type.String(), Type.Boolean(), Type.Number()], {
      description: "比较值（checkbox 用布尔，其余用字符串）",
    }),
  },
  { description: "可选过滤条件（单条件）" },
);
