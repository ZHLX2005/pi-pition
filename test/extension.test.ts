// 集成测试：用 fake pi 跑完整工厂，验证 6 个 tool + 2 个命令 + 2 个事件订阅都注册，
// 且 before_agent_start handler 真实可执行（能抓到 hoist/闭包类 ReferenceError）。
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import pitionExtension from "../extensions/pition.ts";

interface FakePi {
  registerTool(tool: any): void;
  registerCommand(name: string, opts: any): void;
  on(event: string, handler: any): void;
  registerShortcut(...a: any[]): void;
  registerFlag(...a: any[]): void;
}

function harness() {
  const tools: any[] = [];
  const commands: { name: string; opts: any }[] = [];
  const handlers: Record<string, (event: any) => unknown> = {};
  const pi: FakePi = {
    registerTool: (t) => tools.push(t),
    registerCommand: (name, opts) => commands.push({ name, opts }),
    on: (event, handler) => {
      handlers[event] = handler;
    },
    registerShortcut: () => {},
    registerFlag: () => {},
  };
  return { pi, tools, commands, handlers };
}

const EXPECTED_TOOLS = [
  "pition_boot",
  "pition_create_today",
  "pition_goal",
  "pition_read",
  "pition_write",
  "pition_history",
  "pition_span",
];

describe("pitionExtension 装配（集成）", () => {
  it("注册全部 6 个 tool（无条件注册）", () => {
    const { pi, tools } = harness();
    pitionExtension(pi as any);
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("每个 tool 都有 name / label / description / parameters 四要素", () => {
    const { pi, tools } = harness();
    pitionExtension(pi as any);
    for (const t of tools) {
      expect(t.name, `${t.name} 缺 name`).toBeTruthy();
      expect(t.label, `${t.name} 缺 label`).toBeTruthy();
      expect(t.description, `${t.name} 缺 description`).toBeTruthy();
      expect(t.parameters, `${t.name} 缺 parameters`).toBeTruthy();
      expect(typeof t.execute, `${t.name} execute 不是函数`).toBe("function");
    }
  });

  it("注册 /pition 与 /pition-mode 两个命令（无条件）", () => {
    const { pi, commands } = harness();
    pitionExtension(pi as any);
    const names = commands.map((c) => c.name);
    expect(names).toContain("pition");
    expect(names).toContain("pition-mode");
  });

  it("订阅 before_agent_start 与 session_start 两个事件", () => {
    const { pi, handlers } = harness();
    pitionExtension(pi as any);
    expect(Object.keys(handlers)).toContain("before_agent_start");
    expect(Object.keys(handlers)).toContain("session_start");
  });

  it("before_agent_start handler 可执行且不抛（含未配置场景）", async () => {
    const { pi, handlers } = harness();
    pitionExtension(pi as any);
    const event = { systemPromptOptions: { promptGuidelines: [], sections: {} } };
    await expect(handlers.before_agent_start(event)).resolves.not.toThrow();
  });

  // 端到端注入断言（FR2）：今日有 goal 时，before_agent_start 必须把进度写进
  // systemPromptOptions.sections.pition_goal——这是「每次对话提醒」的唯一通道，静默失灵 = 功能整体失效。
  it("今日有 goal 时，before_agent_start 注入 pition_goal section（含进度与 ⚠️ 自检查）", async () => {
    process.env.PITION_CONFIG = join(tmpdir(), `pition-ext-${Date.now()}-${process.pid}.json`);
    try {
      const today = new Date();
      const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      writeFileSync(
        process.env.PITION_CONFIG,
        JSON.stringify({
          token: "ntn_e2e",
          bindings: {},
          currentBindingId: null,
          _assistantMode: true,
          _activeGoals: [
            {
              goalId: "g_e2e",
              title: "今日锻炼",
              period: "day",
              date: ymd,
              items: [{ name: "俯卧撑", target: 4, progress: 2, unit: "轮" }],
              missedDays: 3,
              createdAt: `${ymd}T10:00:00.000+08:00`,
            },
          ],
        }),
        "utf8",
      );
      const { pi, handlers } = harness();
      pitionExtension(pi as any);
      const event = { systemPromptOptions: { promptGuidelines: [], sections: {} } };
      await handlers.before_agent_start(event);
      const section = (event.systemPromptOptions.sections as Record<string, string>).pition_goal ?? "";
      expect(section).toContain("今日目标 1 个");
      expect(section).toContain("俯卧撑 2/4 轮");
      expect(section).toContain("已连续 3 天未执行"); // 自检查提示随注入带出
      // 注：goal section 独立于助理模式（程序性上下文，未绑库也注入）；
      // 助理模式 guidelines 需「已绑定库」才注入，本用例未绑库不断言。
    } finally {
      rmSync(process.env.PITION_CONFIG, { force: true });
      delete process.env.PITION_CONFIG;
    }
  });

  // 注：「未配置库时 tool 抛错」的行为由 currentBinding 的单元测试覆盖
  // （test/config.test.ts），集成测试不依赖本机是否已配置 pition.config.json。

  it("每个运行态 tool 的 execute 都是 async 函数（错误经 reject 抛出而非同步崩）", () => {
    const { pi, tools } = harness();
    pitionExtension(pi as any);
    for (const name of [
      "pition_write",
      "pition_read",
      "pition_span",
      "pition_history",
      "pition_create_today",
      "pition_goal",
    ]) {
      const t = tools.find((x) => x.name === name)!;
      expect(t.execute.constructor.name, `${name} execute 不是 async`).toBe("AsyncFunction");
    }
  });

  it("pition_boot 的 stage 参数覆盖 5 个阶段", () => {
    const { pi, tools } = harness();
    pitionExtension(pi as any);
    const boot = tools.find((t) => t.name === "pition_boot")!;
    const stages = boot.parameters.properties.stage.anyOf.map((s: any) => s.const);
    expect(stages.sort()).toEqual(["describe_fields", "done", "select_db", "set_mode", "token"]);
  });

  it("pition_boot 带 promptGuidelines（agent 调用约定）", () => {
    const { pi, tools } = harness();
    pitionExtension(pi as any);
    const boot = tools.find((t) => t.name === "pition_boot")!;
    expect(boot.promptGuidelines.length).toBeGreaterThanOrEqual(3);
  });

  // 回归防护：任何 tool 的 description / promptGuidelines / schema 描述里
  // 都不得出现已删除的 tool 名（曾发生：boot 的 guideline 教 agent 调 pition_query）
  it("所有 tool 的描述文本都不引用已废弃的 tool 名", () => {
    const { pi, tools } = harness();
    pitionExtension(pi as any);
    const GONE = ["pition_stores", "pition_query", "pition_add_entry", "pition_update_latest"];
    for (const t of tools) {
      const texts = [t.description ?? "", ...(t.promptGuidelines ?? []), JSON.stringify(t.parameters ?? {})].join("\n");
      for (const gone of GONE) {
        expect(texts, `tool ${t.name} 的描述仍引用已删的 ${gone}`).not.toContain(gone);
      }
    }
  });

  // 注：「不需要也不存在 heartbeat 调用」这类**否定式**说明是允许的（它明确劝阻 agent）；
  // 禁止的是把 heartbeat 当成一个可调用的 action/schema 值。
  it("没有任何 tool 把已废除的 heartbeat 当作可调用 action", () => {
    const { pi, tools } = harness();
    pitionExtension(pi as any);
    for (const t of tools) {
      const schema = JSON.stringify(t.parameters ?? {});
      expect(schema, `tool ${t.name} 的 schema 仍含 heartbeat action`).not.toContain('"heartbeat"');
    }
  });
});
