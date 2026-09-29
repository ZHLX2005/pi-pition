import { describe, expect, it } from "vitest";
import { buildRoleInjections } from "../src/role.ts";
import type { PitionConfig } from "../src/types.ts";

const cfgWithBinding: PitionConfig = {
  token: "t",
  bindings: { d1: { dbId: "d1", title: "pition", description: "个人日常记录总表", fields: {} } },
  currentBindingId: "d1",
};

describe("buildRoleInjections", () => {
  it("返回 guidelines（短句）与 sections（长段）两类内容", () => {
    const r = buildRoleInjections(cfgWithBinding);
    expect(r.guidelines.length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(r.sections)).toContain("pition_role");
  });

  it("sections 里带上当前库标题与用途", () => {
    const r = buildRoleInjections(cfgWithBinding);
    expect(r.sections.pition_role).toContain("pition");
    expect(r.sections.pition_role).toContain("个人日常记录总表");
  });

  it("未绑定库时降级为「（未绑定）」而不抛错", () => {
    const r = buildRoleInjections({ token: "t", bindings: {}, currentBindingId: null });
    expect(r.sections.pition_role).toContain("（未绑定）");
  });

  it("guidelines 必须点明「情绪/感悟也算事实事件」这一关键边界", () => {
    const r = buildRoleInjections(cfgWithBinding);
    expect(r.guidelines.join("\n")).toMatch(/情绪|感悟/);
  });

  it("guidelines 必须说明有始有终的活动要用 pition_span", () => {
    const r = buildRoleInjections(cfgWithBinding);
    expect(r.guidelines.join("\n")).toContain("pition_span");
  });

  it("不在注入内容里出现已废弃的 tool 名", () => {
    const r = buildRoleInjections(cfgWithBinding);
    const all = [...r.guidelines, ...Object.values(r.sections)].join("\n");
    expect(all).not.toContain("pition_stores");
    expect(all).not.toContain("pition_query");
    expect(all).not.toContain("pition_add_entry");
    expect(all).not.toContain("pition_update_latest");
    // heartbeat 概念已废除（时长由 startedAt 现算，无需续约）
    expect(all, "注入内容仍提及已废除的 heartbeat").not.toContain("heartbeat");
  });
});
