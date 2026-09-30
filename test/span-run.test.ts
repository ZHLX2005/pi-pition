// span-run 联动回归测试：end 带 goalItemName 推进 goal 的同时，**不能把已结束的 span 复活回磁盘**
// （评审 Bug-1 的拦截断言：span 落盘用 result.cfg，goal 联动基于 result.cfg 推进）。
// Notion IO 全 mock。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/notion.ts", () => ({
  notion: vi.fn(),
}));

import { notion } from "../src/notion.ts";
import { runSpan } from "../src/tools/span-run.ts";
import type { PitionConfig } from "../src/types.ts";

const notionMock = notion as unknown as ReturnType<typeof vi.fn>;

let dir: string;
let cfgFile: string;
let savedAgentDirEnv: string | undefined;
let savedConfigEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pition-spanrun-"));
  cfgFile = join(dir, "pition.config.json");
  savedAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
  savedConfigEnv = process.env.PITION_CONFIG;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PITION_CONFIG = cfgFile;
  notionMock.mockReset();
  notionMock.mockResolvedValue({ results: [{ id: "page-1" }] }); // query latest + PATCH blocks
});

afterEach(() => {
  if (savedAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDirEnv;
  if (savedConfigEnv === undefined) delete process.env.PITION_CONFIG;
  else process.env.PITION_CONFIG = savedConfigEnv;
  rmSync(dir, { recursive: true, force: true });
});

function writeCfg(partial: Partial<PitionConfig>): PitionConfig {
  const cfg: PitionConfig = { token: "ntn_test", bindings: {}, currentBindingId: null, ...partial };
  writeFileSync(cfgFile, JSON.stringify(cfg), "utf8");
  return cfg;
}

const BINDING = { dbId: "d1", title: "日常", fields: { Name: { type: "title" } } };

describe("runSpan end 联动 goal", () => {
  it("end 带 goalItemName：推进 goal 且**不复活已结束的 span**", async () => {
    writeCfg({
      bindings: { d1: BINDING },
      currentBindingId: "d1",
      _activeSpans: [{ spanId: "s1", eventName: "俯卧撑", startedAt: new Date(2026, 9, 1, 14, 0, 0).toISOString() }],
      _activeGoals: [
        {
          goalId: "g1",
          title: "今日锻炼计划",
          period: "day",
          date: "2026-10-01",
          items: [{ name: "俯卧撑", target: 4, progress: 0, unit: "轮" }],
          createdAt: "2026-10-01T14:00:00.000+08:00",
        },
      ],
    });
    const r = await runSpan({ action: "end", eventName: "俯卧撑", goalItemName: "俯卧撑", goalDelta: 1 });
    expect(r.content[0].text).toContain("已结束");
    expect(r.content[0].text).toContain("推进到 1/4");
    // 磁盘上的最终状态：span 已移除 + goal 已推进（Bug-1 拦截断言）
    const saved = JSON.parse(readFileSync(cfgFile, "utf8"));
    expect(saved._activeSpans).toEqual([]);
    expect(saved._activeGoals[0].items[0].progress).toBe(1);
  });

  it("end 联动条目不存在：span 正常收尾 + 文案提示，不影响 span 落盘", async () => {
    writeCfg({
      bindings: { d1: BINDING },
      currentBindingId: "d1",
      _activeSpans: [{ spanId: "s1", eventName: "跑步", startedAt: new Date(2026, 9, 1, 14, 0, 0).toISOString() }],
      _activeGoals: [
        {
          goalId: "g1",
          title: "今日锻炼计划",
          period: "day",
          date: "2026-10-01",
          items: [{ name: "俯卧撑", target: 4, progress: 0, unit: "轮" }],
          createdAt: "2026-10-01T14:00:00.000+08:00",
        },
      ],
    });
    const r = await runSpan({ action: "end", eventName: "跑步", goalItemName: "深蹲" });
    expect(r.content[0].text).toContain("已结束");
    expect(r.content[0].text).toContain("目标推进未生效");
    const saved = JSON.parse(readFileSync(cfgFile, "utf8"));
    expect(saved._activeSpans).toEqual([]); // span 收尾不受联动失败影响
    expect(saved._activeGoals[0].items[0].progress).toBe(0);
  });

  it("end 秒级文案（<1 分钟显示秒）", async () => {
    writeCfg({ bindings: { d1: BINDING }, currentBindingId: "d1" });
    // startedAt 用「当前时间前 47 秒」——跨午夜/固定日期都安全
    const started = new Date(Date.now() - 47_000);
    writeCfg({
      bindings: { d1: BINDING },
      currentBindingId: "d1",
      _activeSpans: [{ spanId: "s1", eventName: "平板支撑", startedAt: started.toISOString() }],
    });
    const r = await runSpan({ action: "end", eventName: "平板支撑" });
    expect(r.content[0].text).toContain("持续 47 秒");
  });
});
