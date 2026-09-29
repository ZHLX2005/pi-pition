import { describe, expect, it } from "vitest";
import {
  buildProperties,
  mergeProperties,
  mergePropertyValue,
  readPageProperties,
  toNotionProperty,
} from "../src/properties.ts";
import type { Binding } from "../src/types.ts";

const binding: Binding = {
  dbId: "db1",
  title: "测试库",
  fields: {
    Name: { type: "title" },
    标签: { type: "multi_select" },
    金额: { type: "number" },
    备注: { type: "rich_text" },
    日期: { type: "date" },
    已完成: { type: "checkbox" },
    类别: { type: "select" },
  },
};

describe("toNotionProperty", () => {
  it("title / rich_text 转成 Notion 富文本数组", () => {
    expect(toNotionProperty("title", "标题")).toEqual({ title: [{ text: { content: "标题" } }] });
    expect(toNotionProperty("rich_text", "内容")).toEqual({ rich_text: [{ text: { content: "内容" } }] });
  });

  it("multi_select 支持数组与逗号分隔字符串（含中文逗号）", () => {
    expect(toNotionProperty("multi_select", ["a", "b"])).toEqual({
      multi_select: [{ name: "a" }, { name: "b" }],
    });
    expect(toNotionProperty("multi_select", "运动, 阅读")).toEqual({
      multi_select: [{ name: "运动" }, { name: "阅读" }],
    });
    expect(toNotionProperty("multi_select", "运动，阅读")).toEqual({
      multi_select: [{ name: "运动" }, { name: "阅读" }],
    });
  });

  it("未知类型抛错并给出可操作提示", () => {
    expect(() => toNotionProperty("formula", 1)).toThrowError(/暂不支持/);
  });
});

describe("mergePropertyValue —— 默认 append 语义", () => {
  it("multi_select 取并集并去重", () => {
    expect(mergePropertyValue("multi_select", ["a"], ["a", "b"], false)).toEqual(["a", "b"]);
  });

  it("number 累加", () => {
    expect(mergePropertyValue("number", 10, 5, false)).toBe(15);
  });

  it("rich_text 拼接为「原 / 新」", () => {
    expect(mergePropertyValue("rich_text", "早", "晚", false)).toBe("早 / 晚");
  });

  it("date 取更早的一天", () => {
    expect(mergePropertyValue("date", "2026-09-29", "2026-09-28", false)).toBe("2026-09-28");
    expect(mergePropertyValue("date", "2026-09-27", "2026-09-28", false)).toBe("2026-09-27");
  });

  it("checkbox 取或", () => {
    expect(mergePropertyValue("checkbox", true, false, false)).toBe(true);
    expect(mergePropertyValue("checkbox", false, true, false)).toBe(true);
    expect(mergePropertyValue("checkbox", false, false, false)).toBe(false);
  });

  it("overwrite=true 直接覆盖，不做合并", () => {
    expect(mergePropertyValue("number", 10, 5, true)).toBe(5);
    expect(mergePropertyValue("multi_select", ["a"], ["b"], true)).toEqual(["b"]);
  });

  it("旧值为空时视为首次写入（不产生「 / x」噪音）", () => {
    expect(mergePropertyValue("rich_text", "", "新", false)).toBe("新");
    expect(mergePropertyValue("rich_text", null, "新", false)).toBe("新");
    expect(mergePropertyValue("rich_text", undefined, "新", false)).toBe("新");
  });

  it("单值字段（select/status/title）即使不给 overwrite 也用新值", () => {
    expect(mergePropertyValue("select", "旧", "新", false)).toBe("新");
    expect(mergePropertyValue("status", "旧", "新", false)).toBe("新");
    expect(mergePropertyValue("title", "旧", "新", false)).toBe("新");
  });
});

describe("readPageProperties", () => {
  it("把 Notion page properties 压成标量快照", () => {
    const snap = readPageProperties({
      Name: { title: [{ plain_text: "标题" }] },
      标签: { multi_select: [{ name: "a" }, { name: "b" }] },
      金额: { number: 42 },
      日期: { date: { start: "2026-09-29" } },
      已完成: { checkbox: true },
      类别: { select: { name: "工作" } },
    });
    expect(snap).toEqual({
      Name: "标题",
      标签: ["a", "b"],
      金额: 42,
      日期: "2026-09-29",
      已完成: true,
      类别: "工作",
    });
  });

  it("空 properties 返回空对象而不是崩溃", () => {
    expect(readPageProperties({})).toEqual({});
  });
});

describe("buildProperties / mergeProperties", () => {
  it("buildProperties 逐条转换；未声明字段抛错", () => {
    expect(buildProperties(binding, [{ name: "金额", value: 3 }])).toEqual({ 金额: { number: 3 } });
    expect(() => buildProperties(binding, [{ name: "不存在", value: 1 }])).toThrowError(/没有字段/);
  });

  it("mergeProperties 在快照上合并（number 累加 + multi_select 并集）", () => {
    const out = mergeProperties(binding, { 金额: 10, 标签: ["a"] }, [
      { name: "金额", value: 5 },
      { name: "标签", value: "b" },
    ]);
    expect(out).toEqual({
      金额: { number: 15 },
      标签: { multi_select: [{ name: "a" }, { name: "b" }] },
    });
  });
});
