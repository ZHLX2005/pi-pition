// goal-run 行为层测试：冷设置 / bindField 三容错 / list 物化落盘 / 5 action 文案。
// Notion IO 全 mock（vi.mock 模块级替换 notion()）——goal 本体不依赖 Notion（冷设置），IO 只影响附注文案。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/notion.ts", () => ({
  notion: vi.fn(),
}));

import { notion } from "../src/notion.ts";
import { runGoal } from "../src/tools/goal-run.ts";
import type { PitionConfig } from "../src/types.ts";

const notionMock = notion as unknown as ReturnType<typeof vi.fn>;

// ---- 配置文件隔离：PI_CODING_AGENT_DIR 劫持（同 config.test.ts 手法）----
let dir: string;
let savedAgentDirEnv: string | undefined;
const _cfgUrl = () => {
  const e = process.env.PI_CODING_AGENT_DIR!;
  return `file:///${join(e, "extensions", "pition.ts").replace(/\\/g, "/")}`;
};

beforeEach(() => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), "pition-goalrun-"));
  savedAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  notionMock.mockReset();
  // 默认：query 返回空（无 page）——冷设置/无 page 场景
  notionMock.mockResolvedValue({ results: [] });
});

afterEach(() => {
  if (savedAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDirEnv;
  rmSync(dir, { recursive: true, force: true });
});

// loadConfig 经 import.meta.url 向上找；测试内 config.ts 的真实位置是仓库 src/，
// 向上找不到配置 → 落到 PI_CODING_AGENT_DIR 兜底。但 save/load 都走 configPath(真实 fromUrl)，
// 与 PI_CODING_AGENT_DIR 无关的 walk-up 会命中仓库根的 pition.config.json（如果存在）。
// 所以这里直接用 PITION_CONFIG 显式钉死路径——绕开 fromUrl 定位。
let cfgFile: string;
beforeEach(() => {
  cfgFile = join(dir, "pition.config.json");
  process.env.PITION_CONFIG = cfgFile;
});

afterEach(() => {
  delete process.env.PITION_CONFIG;
});

function writeCfg(partial: Partial<PitionConfig>): PitionConfig {
  const cfg: PitionConfig = {
    token: "ntn_test",
    bindings: {},
    currentBindingId: null,
    ...partial,
  };
  writeFileSync(cfgFile, JSON.stringify(cfg), "utf8");
  return cfg;
}

const BASE = {
  action: "set" as const,
  title: "今日锻炼计划",
  items: [
    { name: "俯卧撑", target: 4, unit: "轮" },
    { name: "平板支撑", target: 3, unit: "组" },
  ],
};

describe("runGoal —— 冷设置（FR8）", () => {
  it("无绑定库：set 可用，附注说明只存插件内部", async () => {
    writeCfg({ token: "ntn_x", bindings: {}, currentBindingId: null });
    const r = await runGoal({ ...BASE, bindField: "完成度" });
    expect(r.content[0].text).toContain("已建立");
    expect(r.content[0].text).toContain("未配置 Notion");
    // goal 已落盘
    const saved = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(cfgFile, "utf8")));
    expect(saved._activeGoals).toHaveLength(1);
    expect(saved._activeGoals[0].items[0].progress).toBe(0);
  });

  it("无绑定库：progress 推进 + list 读回", async () => {
    writeCfg({ token: "ntn_x", bindings: {}, currentBindingId: null });
    await runGoal({ ...BASE });
    const p = await runGoal({ action: "progress", itemName: "俯卧撑", delta: 2 });
    expect(p.content[0].text).toContain("2/4");
    const l = await runGoal({ action: "list" });
    expect(l.content[0].text).toContain("俯卧撑 2/4 轮");
    expect(l.content[0].text).toContain("29%"); // 2/7 = 28.57 → 29（min 封顶加权）
  });

  it("冷设置 + autoPeriod：set 文案含每日标注", async () => {
    writeCfg({ token: "ntn_x", bindings: {}, currentBindingId: null });
    const s = await runGoal({ ...BASE, autoPeriod: "daily" });
    expect(s.content[0].text).toContain("（自动周期：每天）");
  });
});

describe("runGoal —— bindField 同步三容错（FR6）", () => {
  const boundBinding = {
    dbId: "d1",
    title: "日常",
    fields: { 完成度: { type: "rich_text" } },
  };

  it("字段不在 schema：set 报错列可用字段（fail-fast）", async () => {
    writeCfg({ token: "ntn_x", bindings: { d1: boundBinding }, currentBindingId: "d1" });
    await expect(runGoal({ ...BASE, bindField: "不存在的字段" })).rejects.toThrowError(
      /没有字段「不存在的字段」.*可用字段/s,
    );
  });

  it("库无 page：set 成功，附注说明待首个 page", async () => {
    writeCfg({ token: "ntn_x", bindings: { d1: boundBinding }, currentBindingId: "d1" });
    notionMock.mockResolvedValue({ results: [] }); // query 无结果
    const r = await runGoal({ ...BASE, bindField: "完成度" });
    expect(r.content[0].text).toContain("已建立");
    expect(r.content[0].text).toContain("还没有 page");
    expect(r.details.bindFieldSync).toContain("还没有 page"); // 尽力而为不算失败
  });

  it("有 page：set/progress 同步属性覆写（PATCH 调用带 bindField）", async () => {
    writeCfg({ token: "ntn_x", bindings: { d1: boundBinding }, currentBindingId: "d1" });
    notionMock.mockResolvedValue({ results: [{ id: "page-1" }] });
    await runGoal({ ...BASE, bindField: "完成度" });
    const patchCalls = notionMock.mock.calls.filter((c: any[]) => c[1] === "PATCH" && c[2]?.startsWith("/v1/pages/"));
    expect(patchCalls.length).toBe(1);
    expect(patchCalls[0][3].properties.完成度).toBeDefined();
  });

  it("写入失败：不抛错，文案附失败原因", async () => {
    writeCfg({ token: "ntn_x", bindings: { d1: boundBinding }, currentBindingId: "d1" });
    notionMock.mockImplementation((_cfg: any, method: string) => {
      if (method === "PATCH") throw new Error("502 bad gateway");
      return Promise.resolve({ results: [{ id: "page-1" }] });
    });
    const r = await runGoal({ ...BASE, bindField: "完成度" });
    expect(r.content[0].text).toContain("已建立"); // goal 本体落盘优先
    expect(r.content[0].text).toContain("属性同步失败");
    expect(r.content[0].text).toContain("502");
  });
});

describe("runGoal —— 5 action 文案", () => {
  it("set 带 autoPeriod 文案含（每天）", async () => {
    writeCfg({ token: "ntn_x", bindings: {}, currentBindingId: null });
    const r = await runGoal({ ...BASE, autoPeriod: "daily" });
    expect(r.content[0].text).toContain("（自动周期：每天）");
  });

  it("update 同名保留进度 + delete", async () => {
    writeCfg({ token: "ntn_x", bindings: {}, currentBindingId: null });
    await runGoal({ ...BASE });
    await runGoal({ action: "progress", itemName: "俯卧撑", delta: 1 });
    const u = await runGoal({ action: "update", items: [{ name: "俯卧撑", target: 6, unit: "轮" }] });
    expect(u.content[0].text).toContain("1/6");
    const d = await runGoal({ action: "delete" });
    expect(d.content[0].text).toContain("已删除");
    const l = await runGoal({ action: "list" });
    expect(l.content[0].text).toContain("还没有目标");
  });

  it("progress 全部完成文案带庆祝钩子", async () => {
    writeCfg({ token: "ntn_x", bindings: {}, currentBindingId: null });
    await runGoal({ action: "set", title: "小目标", items: [{ name: "深蹲", target: 1 }] });
    const r = await runGoal({ action: "progress", itemName: "深蹲" });
    expect(r.content[0].text).toContain("🎉 今日目标全部完成");
  });
});
