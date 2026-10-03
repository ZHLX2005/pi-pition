import { describe, expect, it } from "vitest";
import { renderFieldDict } from "../src/fields.ts";
import type { Binding } from "../src/types.ts";

function binding(fields: Binding["fields"], title = "pition"): Binding {
  return { dbId: "d", title, fields };
}

const rich = binding({
  Name: { type: "title", description: "记录标题" },
  金额: { type: "number", description: "当日花销" },
  标签: { type: "multi_select", description: "类别标签" },
  已完成: { type: "checkbox" },
  链接: { type: "url" },
});

describe("renderFieldDict（字段字典）", () => {
  it("带上库名与字段名、类型、说明", () => {
    const text = renderFieldDict(rich);
    expect(text).toContain("pition");
    expect(text).toContain("- Name(title)：记录标题");
    expect(text).toContain("- 标签(multi_select=union)：类别标签");
  });

  it("number / multi_select / checkbox 标出 append 合并语义，单值字段只标类型", () => {
    const text = renderFieldDict(rich);
    expect(text).toContain("金额(number=累加)");
    expect(text).toContain("已完成(checkbox=OR)");
    expect(text).toMatch(/- 链接\(url\)/);
    expect(text).not.toContain("url=");
  });

  it("有说明的字段排在没说明的前面（截断时优先保住有语义的）", () => {
    const text = renderFieldDict(
      binding({ 无说明A: { type: "rich_text" }, 有说明: { type: "number", description: "重要" } }),
    );
    expect(text.indexOf("有说明")).toBeLessThan(text.indexOf("无说明A"));
  });

  it("输出确定：字段声明顺序不同也得到同一份文本（cache 友好）", () => {
    const a = renderFieldDict(
      binding({ B: { type: "number", description: "b" }, A: { type: "title", description: "a" } }),
    );
    const b = renderFieldDict(
      binding({ A: { type: "title", description: "a" }, B: { type: "number", description: "b" } }),
    );
    expect(a).toBe(b);
  });

  it("超预算时截断并告知还有多少字段未列出，且至少保留一行", () => {
    const many = binding(
      Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`字段${i}`, { type: "rich_text", description: "说明".repeat(8) }]),
      ),
    );
    const text = renderFieldDict(many, 400);
    expect(text).toMatch(/另有 \d+ 个字段未列出/);
    expect(text).toContain("- 字段0");
    expect(text).not.toContain("- 字段19");
  });

  it("空字段返回空串（调用方以空判跳过注入）", () => {
    expect(renderFieldDict(binding({}))).toBe("");
  });
});
