// 真宿主注入校验：把「注入假设」钉在真实 pi 的装配路径上（不是我们自己写的假 pi）。
//
// 覆盖三类只有真宿主才能发现的问题：
//   1. 我 mutate 的 `event.systemPromptOptions` 是不是宿主后来真正用的那个对象（归一化/合并语义）
//   2. tool guideline 的裁剪在宿主的真实合并（{ ...base, ...run }）下是否真的生效
//   3. 同一状态连续两轮 → options 深度相同（＝ pi 的 section diff 为空 ＝ 稳定层真的稳定，不刷 cache）
//
// 另覆盖新加的**宿主能力探测**：旧宿主（pi < 0.86 没有 sections）必须整体跳过注入 + 提示一次，
// 而不是每轮抛错被错误边界吃掉（那种故障不报错、功能全无）。
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assembleHost, EXPECTED_TOOLS, type HostHarness } from "../scripts/dev/host-harness.mjs";

const cfg = {
  token: "ntn_host",
  bindings: {
    d1: {
      dbId: "d1",
      title: "个人记录",
      description: "日常总表",
      fields: {
        Name: { type: "title", description: "记录标题" },
        金额: { type: "number", description: "当日花销" },
      },
    },
  },
  currentBindingId: "d1",
  _assistantMode: true,
};

/** 取 before_agent_start 的真实 handler（真派发路径下它已经被注册进扩展） */
function roleHandler(): (event: any, ctx?: any) => any {
  const handlers = host.loaded.extensions.flatMap((e) => e.handlers.get("before_agent_start") ?? []);
  if (!handlers.length) throw new Error("扩展没有注册 before_agent_start —— harness 或装配出了问题");
  return handlers[0];
}

let host: HostHarness;

// 装配一次、全程复用：真宿主加载是重活（jiti 编译扩展 + 真 loader），每个用例重来一遍会让
// 这个文件从 3s 涨到 13s。扩展每轮都重读配置与状态，所以复用宿主不影响隔离性——
// 每个用例前用真实的 session_start 派发把会话态清干净即可。
beforeAll(async () => {
  host = await assembleHost({ config: cfg });
}, 30_000);

beforeEach(async () => {
  writeFileSync(host.configPath, JSON.stringify(cfg), "utf8"); // 还原配置（有的用例会改写它）
  await host.fire({ type: "session_start", reason: "new" }); // 会话事实 / 场景粘性清零
});

afterAll(() => host?.dispose());

describe("真宿主注入（真实 pi loader + ExtensionRunner）", () => {
  it("扩展被真实 loader 发现并注册 7 个 tool（清单不手抄）", () => {
    expect(host.loaded.errors).toEqual([]);
    expect([...host.tools].sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const ev of ["before_agent_start", "session_start", "tool_execution_end"]) {
      expect(host.handlers, `未订阅 ${ev}`).toContain(ev);
    }
  });

  it("真实派发后，我写入的 sections 出现在宿主返回的 options 上", async () => {
    const opts = await host.emit("今天跑了 5 公里");
    expect(Object.keys(opts.sections)).toEqual(
      expect.arrayContaining(["pition_core", "pition_scene", "pition_fields", "pition_runtime"]),
    );
    expect(opts.sections.pition_scene).toContain("锻炼场景");
    expect(opts.sections.pition_fields).toContain("金额(number=累加)");
    expect(opts.sections.pition_runtime).toContain("现在：");
  });

  it("tool guideline 裁剪经宿主真实合并后生效（不相关 tool 被摘、相关的保留）", async () => {
    const opts = await host.emit("记一下今天吃了火锅");
    // log 场景：boot / history 被裁，write / goal / span 保留
    expect(opts.toolGuidelines.pition_boot).toEqual([]);
    expect(opts.toolGuidelines.pition_history).toEqual([]);
    expect(opts.toolGuidelines.pition_write).toEqual(["pition_write 的约定"]);

    const setup = await host.emit("怎么配置 pition");
    expect(setup.toolGuidelines.pition_boot).toEqual(["pition_boot 的约定"]);
    expect(setup.toolGuidelines.pition_history).toEqual([]);
  });

  it("稳定层真的稳定：同一状态连续两轮 options 深度相同（＝ section diff 为空）", async () => {
    const first = await host.emit("今天跑了 5 公里");
    const second = await host.emit("今天跑了 5 公里");
    expect(JSON.stringify(second)).toEqual(JSON.stringify(first));
  });

  it("状态跃迁会改变注入内容：设上今日目标后 train 剧本换一套片段", async () => {
    const before = await host.emit("我想练腹肌");
    expect(before.sections.pition_scene).toContain("还没有今日目标");

    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    writeFileSync(
      host.configPath,
      JSON.stringify({
        ...cfg,
        _activeGoals: [
          {
            goalId: "g1",
            title: "今日锻炼计划",
            period: "day",
            date: ymd,
            items: [{ name: "俯卧撑", target: 4, progress: 2, unit: "轮" }],
            createdAt: `${ymd}T08:00:00.000+08:00`,
          },
        ],
      }),
      "utf8",
    );

    const after = await host.emit("我想练腹肌");
    expect(after.sections.pition_scene).toContain("正在跑");
    expect(after.sections.pition_scene).not.toContain("还没有今日目标");
    // 实时进度只在 pition_goal 段给一次（不重复注入）
    expect(after.sections.pition_goal).toContain("俯卧撑 2/4 轮");
  });

  it("tool 结果经真实派发回流：下一轮提示词带上警告，且驱动片段", async () => {
    const before = await host.emit("记一下今天吃了火锅");
    expect(before.sections.pition_scene).not.toContain("pition_create_today");

    await host.fire({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "pition_write",
      isError: false,
      result: {
        content: [{ type: "text", text: "WARNING: 存储「个人记录」还没有任何 page" }],
        details: { warning: "no_page_in_db" },
      },
    });

    const after = await host.emit("记一下今天吃了火锅");
    expect(after.sections.pition_runtime).toContain("该库还没有任何 page");
    expect(after.sections.pition_scene).toContain("pition_create_today");
  });

  it("session_start 经真实派发清零会话事实", async () => {
    await host.fire({
      type: "tool_execution_end",
      toolCallId: "call_2",
      toolName: "pition_write",
      isError: false,
      result: { content: [{ type: "text", text: "已写入" }] },
    });
    expect((await host.emit("你好")).sections.pition_runtime).toContain("本会话已写入 1 条");

    await host.fire({ type: "session_start", reason: "new" });
    expect((await host.emit("你好")).sections.pition_runtime).not.toContain("本会话已写入");
  });

  it("宿主能力探测：没有 sections 的旧宿主 → 不写入（不抛错）+ 只提示一次", async () => {
    // 真宿主的归一化**总是**给出 sections（实测 0.87：`sections: { ...(input.sections ?? {}) }`），
    // 所以旧宿主只能从 handler 入口模拟：给一个没有 sections / toolGuidelines 的裸 event。
    const legacyOptions = { promptGuidelines: [] as string[] };
    const notices: Array<{ m: string; type: string }> = [];
    const ctx = { ui: { notify: (m: string, type: string) => notices.push({ m, type }) } };
    const handler = roleHandler();

    await expect(
      handler({ prompt: "记一下今天吃了火锅", systemPromptOptions: { ...legacyOptions } }, ctx),
    ).resolves.toBeUndefined();
    expect(legacyOptions.promptGuidelines, "旧宿主上不应写入任何 guideline").toEqual([]);

    await handler({ prompt: "记一下今天吃了火锅", systemPromptOptions: { ...legacyOptions } }, ctx);
    expect(notices).toHaveLength(1); // 只提示一次，不刷屏
    expect(notices[0].m).toContain("0.86");
    expect(notices[0].type).toBe("warning");
  });

  it("装配失败时降级为最小注入（而不是整轮零注入）", async () => {
    // 构造一个「今天 + items 缺失」的损坏目标：片段渲染（allGoalsDone）会抛 TypeError。
    // 这正是需要兜底的场景——配置被手改坏时，用户不该面对的是一轮「pition 不存在」。
    const handler = roleHandler();
    const options: {
      sections: Record<string, string>;
      toolGuidelines: Record<string, string[]>;
      promptGuidelines: string[];
    } = { sections: {}, toolGuidelines: {}, promptGuidelines: [] };
    const notices: Array<{ m: string; t: string }> = [];
    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    writeFileSync(
      host.configPath,
      JSON.stringify({
        ...cfg,
        bindings: {},
        currentBindingId: "ghost",
        _activeGoals: [{ goalId: "bad", title: "坏目标", period: "day", date: ymd }],
      }),
      "utf8",
    );

    await handler(
      { prompt: "我想练腹肌", systemPromptOptions: options },
      {
        ui: { notify: (m: string, t: string) => notices.push({ m, t }) },
      },
    );

    expect(options.sections.pition_core).toBeTruthy();
    expect(options.sections.pition_core).toContain("装配失败");
    expect(options.promptGuidelines).toHaveLength(3); // 兜底把全局准则补上
    expect(notices[0]?.m).toContain("降级");

    // 降级不写半成品：场景/字段段一个都不该出现
    expect(options.sections.pition_scene).toBeUndefined();
    expect(options.sections.pition_fields).toBeUndefined();
  });
});
