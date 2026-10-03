// 字段字典：把「当前库有哪些可写字段、每个字段什么语义、append 怎么合并」渲染成注入段。
//
// 为什么需要它：字段 description 是 pition 让用户填的**产品核心**（「写得越具体 agent 写得越准」），
// 但在此之前它只被用于算覆盖率——agent 侧唯一的字段来源是 `pition_boot stage=done`（且只给覆盖率、
// 不给字段名）。结果：agent 想写属性必须多一次往返（pition_read / boot）去猜字段名。
//
// 三条设计约束：
//   1. **确定性排序**（有 description 优先 → 类型优先级 → 名称）——注入内容不变才能 cache hit
//   2. **预算截断**：整段字符数超限就截断并告知还有几个字段未列出，绝不无限膨胀
//   3. **只读当前库**：切库后内容随之变化（有意的——这就是「准确」的定义）
import type { Binding } from "./types.ts";

/** 默认预算（字符）：约 40 个中等长度字段；超出的走截断提示 */
export const FIELD_DICT_MAX_CHARS = 1200;

/** 类型优先级：越靠前越可能在记录里被用到（截断时优先保住） */
const TYPE_RANK: Record<string, number> = {
  title: 0,
  number: 1,
  multi_select: 2,
  select: 3,
  date: 4,
  rich_text: 5,
  checkbox: 6,
  status: 7,
  url: 8,
  email: 9,
  phone_number: 10,
};

/** append 合并语义提示（与 properties.ts 的 mergePropertyValue 一致） */
const APPEND_HINT: Record<string, string> = {
  multi_select: "union",
  number: "累加",
  rich_text: "拼接",
  date: "取更早",
  checkbox: "OR",
};

interface FieldLine {
  name: string;
  type: string;
  description: string;
  /** 渲染后的一行（排序与截断都按它的长度算，避免两处口径不一致） */
  text: string;
}

/** 单行渲染：`- 字段名(type=append语义)：说明`（单值字段无 append 语义，只写 type） */
function renderLine(name: string, type: string, description: string): string {
  const append = APPEND_HINT[type];
  const meta = append ? `${type}=${append}` : type;
  return `- ${name}(${meta})${description ? `：${description}` : ""}`;
}

/** 排序：有 description 优先 → 类型优先级 → 名称（保证同库同输出，cache 友好） */
function sortFields(lines: FieldLine[]): FieldLine[] {
  return [...lines].sort((a, b) => {
    const aDesc = a.description ? 0 : 1;
    const bDesc = b.description ? 0 : 1;
    if (aDesc !== bDesc) return aDesc - bDesc;
    const aRank = TYPE_RANK[a.type] ?? 99;
    const bRank = TYPE_RANK[b.type] ?? 99;
    if (aRank !== bRank) return aRank - bRank;
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
}

/**
 * 渲染当前库的字段字典。
 * 无字段时返回空串（调用方以空判跳过注入）。
 */
export function renderFieldDict(binding: Binding, maxChars: number = FIELD_DICT_MAX_CHARS): string {
  const lines = sortFields(
    Object.entries(binding.fields ?? {}).map(([name, meta]) => ({
      name,
      type: meta?.type ?? "",
      description: meta?.description ?? "",
      text: renderLine(name, meta?.type ?? "", meta?.description ?? ""),
    })),
  );
  if (!lines.length) return "";

  const head = `📋 当前库「${binding.title}」可写字段（properties[].name 必须与下列完全一致）：`;
  const tailNote = "（没有说明的字段先按字段名判断；仍不确定就调 pition_boot stage=describe_fields 补说明）";

  const kept: string[] = [];
  let used = head.length;
  for (const line of lines) {
    if (used + line.text.length + 1 > maxChars) break;
    kept.push(line.text);
    used += line.text.length + 1;
  }
  // 至少保住第一条，避免预算过小导致整段空转
  if (!kept.length) kept.push(lines[0].text);

  const omitted = lines.length - kept.length;
  const omittedNote =
    omitted > 0 ? `\n（另有 ${omitted} 个字段未列出——需要时调 pition_boot stage=describe_fields 查看）` : "";
  return `${head}\n${kept.join("\n")}${omittedNote}\n${tailNote}`;
}
