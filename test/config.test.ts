import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { currentBinding, currentSpans, loadConfig, normalizeConfig, saveConfig } from "../src/config.ts";

describe("normalizeConfig —— 历史格式兼容", () => {
  it("无 token / 非对象 返回 null", () => {
    expect(normalizeConfig(null)).toBeNull();
    expect(normalizeConfig("x")).toBeNull();
    expect(normalizeConfig({})).toBeNull();
    expect(normalizeConfig({ token: 123 })).toBeNull();
  });

  it("当前格式原样通过", () => {
    const cfg = normalizeConfig({
      token: "t",
      bindings: { d1: { dbId: "d1", title: "x", fields: {} } },
      currentBindingId: "d1",
    });
    expect(cfg?.currentBindingId).toBe("d1");
    expect(Object.keys(cfg!.bindings)).toEqual(["d1"]);
  });

  it("老格式 bindings 数组 → Record（key = dbId）", () => {
    const cfg = normalizeConfig({
      token: "t",
      bindings: [
        { dbId: "d1", title: "a", fields: {} },
        { dbId: "d2", title: "b", fields: {} },
      ],
    });
    expect(Object.keys(cfg!.bindings).sort()).toEqual(["d1", "d2"]);
    expect(cfg!.currentBindingId).toBe("d1"); // 缺省取第一个
  });

  it("更老格式 binding 单对象 → bindings", () => {
    const cfg = normalizeConfig({ token: "t", binding: { dbId: "solo", title: "x", fields: {} } });
    expect(cfg!.bindings.solo.title).toBe("x");
    expect(cfg!.currentBindingId).toBe("solo");
  });

  it("currentBindingId 指向不存在的库时回退到第一个", () => {
    const cfg = normalizeConfig({
      token: "t",
      bindings: { d1: { dbId: "d1", title: "x", fields: {} } },
      currentBindingId: "ghost",
    });
    expect(cfg!.currentBindingId).toBe("d1");
  });

  it("_activeSpan（单对象）→ _activeSpans（数组）", () => {
    const span = { spanId: "s1", eventName: "跑步", startedAt: "2026-09-29T10:00:00.000Z" };
    expect(normalizeConfig({ token: "t", bindings: {}, _activeSpan: span })!._activeSpans).toEqual([span]);
    expect(normalizeConfig({ token: "t", bindings: {}, _activeSpans: [span] })!._activeSpans).toEqual([span]);
  });
});

describe("loadConfig / saveConfig —— 真实文件读写", () => {
  let dir: string;
  let cfgUrl: string; // 指向 <dir>/extensions/pition.ts，使配置解析落在 <dir>
  let cfgFile: string;
  let agentHome: string; // PI_CODING_AGENT_DIR 指向的临时目录（兜底配置家）
  let savedAgentDirEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pition-test-"));
    mkdirSync(join(dir, "extensions"), { recursive: true });
    cfgUrl = `file:///${join(dir, "extensions", "pition.ts").replace(/\\/g, "/")}`;
    cfgFile = join(dir, "pition.config.json");
    // 把 pi agent 目录劫持到临时位置——测试绝不读写真实的 ~/.pi/agent
    agentHome = join(dir, "agent-home");
    savedAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentHome;
  });
  afterEach(() => {
    if (savedAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDirEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it("无配置 → null", () => {
    expect(loadConfig(cfgUrl)).toBeNull();
  });

  it("fresh saveConfig 落在 pi agent 目录（npm 重装不丢的家）", () => {
    const cfg = { token: "ntn_x", bindings: {}, currentBindingId: null };
    saveConfig(cfg, cfgUrl);
    const expected = join(agentHome, "extensions", "pition.config.json");
    expect(existsSync(expected)).toBe(true);
    expect(loadConfig(cfgUrl)).toEqual(cfg);
    expect(readFileSync(expected, "utf8").endsWith("\n")).toBe(true);
  });

  it("包外 walk-up 配置仍然优先（仓库开发模式不变，agent 目录不产生文件）", () => {
    const cfg = { token: "ntn_repo", bindings: {}, currentBindingId: null };
    writeFileSync(cfgFile, JSON.stringify(cfg), "utf8");
    expect(loadConfig(cfgUrl)).toEqual(cfg);
    expect(existsSync(join(agentHome, "extensions"))).toBe(false);
  });

  it("node_modules 内的配置被自动迁移到 pi agent 目录", () => {
    const nmDir = join(dir, "node_modules", "pkg");
    mkdirSync(join(nmDir, "extensions"), { recursive: true });
    const cfg = { token: "ntn_legacy", bindings: {}, currentBindingId: null };
    writeFileSync(join(nmDir, "pition.config.json"), JSON.stringify(cfg), "utf8");
    const nmUrl = `file:///${join(nmDir, "extensions", "pition.ts").replace(/\\/g, "/")}`;

    const migratedHome = join(agentHome, "extensions", "pition.config.json");
    expect(loadConfig(nmUrl)).toEqual(cfg);
    expect(existsSync(migratedHome)).toBe(true);
    // 幂等：旧文件仍在（拷贝不是移动），但后续读写走 agent 目录
    expect(existsSync(join(nmDir, "pition.config.json"))).toBe(true);
    expect(loadConfig(nmUrl)).toEqual(cfg);
  });

  it("非法 JSON → null（不抛错）", () => {
    writeFileSync(cfgFile, "{ not json", "utf8");
    expect(loadConfig(cfgUrl)).toBeNull();
  });
});

describe("currentBinding / currentSpans —— 依赖注入的解析器", () => {
  it("未配置时 currentBinding 抛错并指引 pition_boot", () => {
    expect(() => currentBinding(() => null)).toThrowError(/pition_boot stage=token/);
  });

  it("未选库时 currentBinding 抛错并指引 select_db", () => {
    expect(() => currentBinding(() => ({ token: "t", bindings: {}, currentBindingId: null }))).toThrowError(
      /stage=select_db/,
    );
  });

  it("选了库时返回该库对象", () => {
    const b = { dbId: "d1", title: "x", fields: {} };
    const got = currentBinding(() => ({ token: "t", bindings: { d1: b }, currentBindingId: "d1" }));
    expect(got).toBe(b);
  });

  it("currentSpans 无配置/无 span 时返回空数组", () => {
    expect(currentSpans(() => null)).toEqual([]);
    expect(currentSpans(() => ({ token: "t", bindings: {}, currentBindingId: null }))).toEqual([]);
  });
});
