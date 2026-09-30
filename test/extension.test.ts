// 集成测试：用 fake pi 跑完整工厂，验证 6 个 tool + 2 个命令 + 2 个事件订阅都注册，
// 且 before_agent_start handler 真实可执行（能抓到 hoist/闭包类 ReferenceError）。
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
