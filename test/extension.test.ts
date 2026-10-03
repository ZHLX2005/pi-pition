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
  /** 每个事件的全部 handler（pi 会按注册顺序跑全部；`handlers` 只留最后一个，够用的老用例继续用它） */
  const allHandlers: Record<string, Array<(event: any) => unknown>> = {};
  const activeToolCalls: string[][] = [];
  const pi: FakePi & { setActiveTools: (names: string[]) => void } = {
    registerTool: (t) => tools.push(t),
    registerCommand: (name, opts) => commands.push({ name, opts }),
    on: (event, handler) => {
      handlers[event] = handler;
      const list = allHandlers[event] ?? [];
      list.push(handler);
      allHandlers[event] = list;
    },
    registerShortcut: () => {},
    registerFlag: () => {},
    setActiveTools: (names) => activeToolCalls.push(names),
  };
  /** 按注册顺序触发某事件的全部 handler（等价 pi 的派发语义） */
  const fire = async (event: string, payload: any) => {
    for (const handler of allHandlers[event] ?? []) await handler(payload);
  };
  return { pi, tools, commands, handlers, allHandlers, fire, activeToolCalls };
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

  it("每个 tool 都提供 promptSnippet（否则不进 tools 层的 Available tools 索引）", () => {
    const { pi, tools } = harness();
    pitionExtension(pi as any);
    for (const t of tools) {
      expect(typeof t.promptSnippet, `${t.name} 缺 promptSnippet`).toBe("string");
      expect((t.promptSnippet ?? "").length, `${t.name} 的 promptSnippet 太短`).toBeGreaterThan(8);
    }
  });
});

// 端到端注入：助理模式开 + 已绑库时，before_agent_start 必须按场景把剧本/字段字典/裁剪落到
// systemPromptOptions 上——这是「模型看到什么」的唯一通道，静默失灵 = 注入架构整体失效。
describe("pitionExtension 场景化注入（集成）", () => {
  const TOOL_NAMES = [
    "pition_boot",
    "pition_create_today",
    "pition_goal",
    "pition_history",
    "pition_read",
    "pition_span",
    "pition_write",
  ];

  function withConfig<T>(cfg: Record<string, unknown>, fn: () => Promise<T> | T): Promise<T> | T {
    process.env.PITION_CONFIG = join(tmpdir(), `pition-scene-${Date.now()}-${process.pid}.json`);
    writeFileSync(process.env.PITION_CONFIG, JSON.stringify(cfg), "utf8");
    try {
      return fn();
    } finally {
      rmSync(process.env.PITION_CONFIG, { force: true });
      delete process.env.PITION_CONFIG;
    }
  }

  const cfg = {
    token: "ntn_scene",
    bindings: {
      db1: {
        dbId: "db1",
        title: "个人记录",
        description: "日常总表",
        fields: {
          Name: { type: "title", description: "记录标题" },
          金额: { type: "number", description: "当日花销" },
        },
      },
    },
    currentBindingId: "db1",
    _assistantMode: true,
  };

  function freshEvent(prompt: string) {
    return {
      prompt,
      systemPromptOptions: {
        promptGuidelines: [] as string[],
        sections: {} as Record<string, string>,
        toolGuidelines: Object.fromEntries(TOOL_NAMES.map((n) => [n, [`${n} 的约定`]])) as Record<string, string[]>,
      },
    };
  }

  it("锻炼输入 → 注入 train 剧本 + 字段字典 + 绑库信息", async () => {
    await withConfig(cfg, async () => {
      const { pi, handlers } = harness();
      pitionExtension(pi as any);
      const event = freshEvent("今天跑了 5 公里");
      await handlers.before_agent_start(event);
      expect(event.systemPromptOptions.sections.pition_scene).toContain("锻炼场景");
      expect(event.systemPromptOptions.sections.pition_fields).toContain("金额(number=累加)");
      expect(event.systemPromptOptions.sections.pition_core).toContain("个人记录");
    });
  });

  it("闲聊输入 → 只有 core，不注入剧本与字段字典", async () => {
    await withConfig(cfg, async () => {
      const { pi, handlers } = harness();
      pitionExtension(pi as any);
      const event = freshEvent("解释一下什么是闭包");
      await handlers.before_agent_start(event);
      expect(event.systemPromptOptions.sections.pition_core).toBeTruthy();
      expect(event.systemPromptOptions.sections.pition_scene).toBeUndefined();
      expect(event.systemPromptOptions.sections.pition_fields).toBeUndefined();
    });
  });

  it("按场景裁剪 tool guideline：log 裁掉 boot，setup 保留 boot", async () => {
    await withConfig(cfg, async () => {
      const { pi, handlers } = harness();
      pitionExtension(pi as any);

      const logEvent = freshEvent("记一下今天吃了火锅");
      await handlers.before_agent_start(logEvent);
      expect(logEvent.systemPromptOptions.toolGuidelines.pition_boot).toEqual([]);
      expect(logEvent.systemPromptOptions.toolGuidelines.pition_write).toEqual(["pition_write 的约定"]);

      const setupEvent = freshEvent("怎么配置 pition");
      await handlers.before_agent_start(setupEvent);
      expect(setupEvent.systemPromptOptions.toolGuidelines.pition_boot).toEqual(["pition_boot 的约定"]);
      expect(setupEvent.systemPromptOptions.toolGuidelines.pition_history).toEqual([]);
    });
  });

  it("闲聊场景不裁剪任何 tool guideline（保守：宁可多注入也不误伤）", async () => {
    await withConfig(cfg, async () => {
      const { pi, handlers } = harness();
      pitionExtension(pi as any);
      const event = freshEvent("帮我看看这段架构");
      await handlers.before_agent_start(event);
      for (const name of TOOL_NAMES) {
        expect(event.systemPromptOptions.toolGuidelines[name], `${name} 在 chat 场景被裁了`).toHaveLength(1);
      }
    });
  });

  it("场景有粘性：先说锻炼、再说「好」→ 仍是 train", async () => {
    await withConfig(cfg, async () => {
      const { pi, handlers } = harness();
      pitionExtension(pi as any);
      await handlers.before_agent_start(freshEvent("我想练腹肌"));
      const followUp = freshEvent("好");
      await handlers.before_agent_start(followUp);
      expect(followUp.systemPromptOptions.sections.pition_scene).toContain("锻炼场景");
    });
  });

  it("永不调用 setActiveTools：能力不做场景门禁（B01 §6.4 的血债）", async () => {
    await withConfig(cfg, async () => {
      const { pi, handlers, activeToolCalls } = harness();
      pitionExtension(pi as any);
      for (const prompt of ["记一下今天吃了火锅", "开始跑步", "上个月写了什么", "怎么配置 pition", "你好"]) {
        await handlers.before_agent_start(freshEvent(prompt));
      }
      expect(activeToolCalls).toEqual([]);
    });
  });

  it("有 token 但还没选库时：core 给出「去配置」指路，并保留 boot 的 guideline", async () => {
    await withConfig({ token: "ntn_nodb", bindings: {}, currentBindingId: null, _assistantMode: true }, async () => {
      const { pi, handlers } = harness();
      pitionExtension(pi as any);
      const event = freshEvent("记一下今天吃了火锅");
      await handlers.before_agent_start(event);
      expect(event.systemPromptOptions.sections.pition_core).toContain("未绑定");
      expect(event.systemPromptOptions.toolGuidelines.pition_boot).toEqual(["pition_boot 的约定"]);
    });
  });

  it("助理模式关闭时不注入任何 pition section（保持默认 pi 行为）", async () => {
    await withConfig({ ...cfg, _assistantMode: false }, async () => {
      const { pi, handlers } = harness();
      pitionExtension(pi as any);
      const event = freshEvent("记一下今天吃了火锅");
      await handlers.before_agent_start(event);
      expect(event.systemPromptOptions.sections.pition_core).toBeUndefined();
      expect(event.systemPromptOptions.promptGuidelines).toEqual([]);
      expect(event.systemPromptOptions.toolGuidelines.pition_boot).toEqual(["pition_boot 的约定"]);
    });
  });
});

// 动态提示词：注入内容必须随「本轮状态」变，而不是常量长文——
//   易变层带当前时间；tool 结果回流到下一轮；脚本片段随目标/警告增删。
describe("pitionExtension 动态提示词（集成）", () => {
  const today = new Date();
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const baseCfg = {
    token: "ntn_dyn",
    bindings: {
      db1: {
        dbId: "db1",
        title: "个人记录",
        fields: { Name: { type: "title", description: "记录标题" }, 金额: { type: "number", description: "花销" } },
      },
    },
    currentBindingId: "db1",
    _assistantMode: true,
  };

  const goalCfg = {
    ...baseCfg,
    _activeGoals: [
      {
        goalId: "g1",
        title: "今日锻炼计划",
        period: "day",
        date: ymd,
        items: [
          { name: "俯卧撑", target: 4, progress: 2, unit: "轮" },
          { name: "平板支撑", target: 3, progress: 0, unit: "组" },
        ],
        createdAt: `${ymd}T08:00:00.000+08:00`,
      },
    ],
  };

  function freshEvent(prompt: string) {
    return {
      prompt,
      systemPromptOptions: {
        promptGuidelines: [] as string[],
        sections: {} as Record<string, string>,
        toolGuidelines: {
          pition_boot: ["b"],
          pition_create_today: ["ct"],
          pition_goal: ["g"],
          pition_history: ["h"],
          pition_read: ["r"],
          pition_span: ["s"],
          pition_write: ["w"],
        } as Record<string, string[]>,
      },
    };
  }

  function toolEnd(toolName: string, result: unknown, isError = false) {
    return { toolName, result, isError };
  }

  function run<T>(config: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    const path = join(tmpdir(), `pition-dyn-${Date.now()}-${process.pid}.json`);
    process.env.PITION_CONFIG = path;
    writeFileSync(path, JSON.stringify(config), "utf8");
    return fn().finally(() => {
      rmSync(path, { force: true });
      delete process.env.PITION_CONFIG;
    });
  }

  it("易变层每轮注入当前时间锚点（模型不必自己推算日期）", async () => {
    await run(baseCfg, async () => {
      const { pi, handlers } = harness();
      pitionExtension(pi as any);
      const event = freshEvent("你好");
      await handlers.before_agent_start(event);
      const runtime = event.systemPromptOptions.sections.pition_runtime;
      expect(runtime).toContain("现在：");
      expect(runtime).toContain(ymd.replace(/(\d+)-(\d+)-(\d+)/, (_, y, m, d) => `${y}年${Number(m)}月${Number(d)}日`));
      expect(runtime).toContain("不要自己推算");
    });
  });

  it("tool 结果回流：成功的 write 让下一轮提示词知道「本会话已写入 1 条」", async () => {
    await run(baseCfg, async () => {
      const { pi, handlers } = harness();
      pitionExtension(pi as any);

      await handlers.tool_execution_end(
        toolEnd("pition_write", { content: [{ type: "text", text: "已写入「个人记录」当前 page" }] }),
      );
      const event = freshEvent("记一下今天吃了火锅");
      await handlers.before_agent_start(event);

      expect(event.systemPromptOptions.sections.pition_runtime).toContain("本会话已写入 1 条");
      // 片段也跟着变：已写过 → 提示别重复落库
      expect(event.systemPromptOptions.sections.pition_scene).toContain("同一条内容不要重复落库");
    });
  });

  it("tool 警告回流：write 报「没有 page」→ 下一轮才出现逃生口提示", async () => {
    await run(baseCfg, async () => {
      const { pi, handlers } = harness();
      pitionExtension(pi as any);

      const before = freshEvent("记一下今天吃了火锅");
      await handlers.before_agent_start(before);
      expect(before.systemPromptOptions.sections.pition_scene).not.toContain("pition_create_today");

      await handlers.tool_execution_end(
        toolEnd("pition_write", {
          content: [{ type: "text", text: "WARNING: 存储「个人记录」还没有任何 page" }],
          details: { warning: "no_page_in_db" },
        }),
      );
      const after = freshEvent("记一下今天吃了火锅");
      await handlers.before_agent_start(after);

      expect(after.systemPromptOptions.sections.pition_runtime).toContain("该库还没有任何 page");
      expect(after.systemPromptOptions.sections.pition_scene).toContain("pition_create_today");
    });
  });

  it("tool 失败回流：下一轮提示先处理、别原样重试", async () => {
    await run(baseCfg, async () => {
      const { pi, handlers } = harness();
      pitionExtension(pi as any);
      await handlers.tool_execution_end(
        toolEnd("pition_write", { content: [{ type: "text", text: "fetch failed" }] }, true),
      );
      const event = freshEvent("记一下今天吃了火锅");
      await handlers.before_agent_start(event);
      expect(event.systemPromptOptions.sections.pition_runtime).toContain("失败");
      expect(event.systemPromptOptions.sections.pition_runtime).toContain("别原样重试");
    });
  });

  it("非 pition tool 的结果不进入会话事实", async () => {
    await run(baseCfg, async () => {
      const { pi, handlers } = harness();
      pitionExtension(pi as any);
      await handlers.tool_execution_end(toolEnd("bash", { content: [{ type: "text", text: "已写入" }] }));
      const event = freshEvent("你好");
      await handlers.before_agent_start(event);
      expect(event.systemPromptOptions.sections.pition_runtime).not.toContain("已写入");
    });
  });

  it("session_start 清零会话事实（新会话不继承上一会话的写入计数）", async () => {
    await run(baseCfg, async () => {
      const { pi, handlers, fire } = harness();
      pitionExtension(pi as any);
      await handlers.tool_execution_end(toolEnd("pition_write", { content: [{ type: "text", text: "已写入" }] }));
      await fire("session_start", { type: "session_start", reason: "new" });

      const event = freshEvent("你好");
      await handlers.before_agent_start(event);
      expect(event.systemPromptOptions.sections.pition_runtime).not.toContain("本会话已写入");
    });
  });

  it("剧本随目标状态变：有今日目标时 train 给「推进 + 下一项」，没有时给「怎么定计划」", async () => {
    await run(goalCfg, async () => {
      const { pi, handlers } = harness();
      pitionExtension(pi as any);
      const withGoal = freshEvent("我想练腹肌");
      await handlers.before_agent_start(withGoal);
      expect(withGoal.systemPromptOptions.sections.pition_scene).toContain("正在跑");
      expect(withGoal.systemPromptOptions.sections.pition_scene).toContain("俯卧撑");
      // 实时进度只在 pition_goal 段给一次（不重复注入）
      expect(withGoal.systemPromptOptions.sections.pition_goal).toContain("俯卧撑 2/4 轮");
    });

    await run(baseCfg, async () => {
      const { pi, handlers } = harness();
      pitionExtension(pi as any);
      const noGoal = freshEvent("我想练腹肌");
      await handlers.before_agent_start(noGoal);
      expect(noGoal.systemPromptOptions.sections.pition_scene).toContain("还没有今日目标");
      expect(noGoal.systemPromptOptions.sections.pition_goal).toBeUndefined();
    });
  });
});
