# 注入内核（`src/injection/`）

**这个目录不依赖 pition 的任何领域概念**——没有 Notion、没有目标、没有字段字典。
它是「pi 扩展怎么改模型看到的提示词」这套机械的沉淀，可以**整个目录复制到另一个扩展里**直接复用。

pition 是它的第一个（也是当前唯一的）消费者：`src/role.ts` / `src/role-mode.ts` / `src/sop.ts` /
`src/scene.ts` / `src/prompt-state.ts` 都只是「填插槽」的适配层。

## 为什么要有它

这套机械是踩坑踩出来的，每条纪律背后都有一个真实故障：

| 纪律 | 不遵守会发生什么 |
| --- | --- |
| 宿主缺 `sections` 就整体跳过（不猜测性创建字段） | 每轮抛错被 pi 错误边界吃掉 → **静默零注入**（不报错、功能全无） |
| 只改 `promptGuidelines` / `sections` / `toolGuidelines`，禁 `forceSystemPrompt` | 整段替换 = prompt cache 全 miss |
| 永不调 `setActiveTools`，只裁 guideline 文本 | 注册期门禁把「会话中现配的能力」挡在门外 → 工具永远不出现 |
| 注入内容 = `f(状态)`，剧本拆成带 `when` 的片段 | 固定长文必然含当下不成立的内容 → 噪音 + 误导 |
| 每轮都变的内容单独成段（易变层） | 稳定层跟着每轮重刷 cache |
| 先全部构造、再统一落地 | 构造抛错 → 注入一半的半成品 |
| 装配失败降级成最小 core | 这一轮在模型眼里变成「扩展不存在」 |
| tool 结果回流到下一轮 | 模型忽略 WARNING，原样重试 |

## 造一个新扩展

> **有 pition 仓库在手就别手抄**：`node <pition>/scripts/new-extension.mjs <目录> --name <名字>`
> 一条命令把本目录逐字节复制过去，并生成能跑的骨架（含 `package.json` / `tsconfig.json` /
> `src/state.ts` / `src/scenes.ts` / `src/spec.ts` / 最小自检），连 pi 版本下界都从 `version.ts` 读。
> 下面三步是它生成的东西的原理，手工接管时照做。

### 1. 复制内核

```sh
cp -r <pition>/src/injection  <新扩展>/src/injection
```

目录内自带 `index.ts`（barrel），换领域不用改任何一个文件。

### 2. 填插槽（`InjectionSpec`）

只有领域相关的部分需要你写。最小集合：

```ts
const spec: InjectionSpec<MyState, MyScene> = {
  name: "myext",                       // 提示文案里的扩展名
  toolPrefix: "myext_",                // tool_execution_end 只采集这个前缀的结果
  countTool: "myext_save",             // 可选：计入「本会话已写入 N 条」的 tool
  enabled: () => true,                 // 总开关（想做「助理模式」就接这里）
  route: createRouter<MyScene>({       // 场景路由：信号按优先级排列 + 低信息量粘性
    signals: [{ id: "capture", re: /存|收藏/u }, { id: "lookup", re: /找|搜/u }],
    fallback: "chat",
    lowInfo: (p) => isLowInfo(p, /^(?:好|继续|嗯)[。!！]?$/u),
  }),
  buildState: ({ session, now }) => ({ // 每轮一次：读配置/落盘/算快照（抛错 → 降级）
    anchor: timeAnchor(now),
    total: store.total,
    saved: session.writes,
    lastFailed: session.last?.failed === true,
  }),
  build: ({ state, scene }) => ({      // 由状态 + 场景装配本轮注入
    guidelines: ["恒定准则（≤3 条）"],
    sections: assembleLayers<MyState>([
      { name: "myext_core",    render: (s) => `身份 + 工具索引（共 ${s.total} 条）` },
      { name: "myext_scene",   render: (s) => renderSceneBody(SCENES[scene], s) },
      { name: "myext_runtime", render: (s) => `⏱ ${s.anchor.todayLabel} ${s.anchor.clock}` },
    ], state),
    keptTools: SCENES[scene].tools,    // 该场景保留 guideline 的 tool；undefined = 不裁剪
  }),
  runtimeSections: ({ state }) => ({}),// 可选：与场景/开关无关的运行时事实（有数据就注入）
  fallback: () => ({                   // 装配失败时的最小注入
    guidelines: ["剧本装配失败：按 tool description 谨慎行动。"],
    sections: { myext_core: "myext 已降级为最小注入。" },
  }),
};
```

### 3. 接上 pi

```ts
// extensions/myext.ts
import { createInjectionRuntime, emptyRuntimeState } from "../src/injection/index.ts";

export default function (pi: ExtensionAPI) {
  const state = { ...emptyRuntimeState<MyScene>(), enabled: true };
  createInjectionRuntime(spec, state).attach(pi);
  for (const t of tools) pi.registerTool(t);   // tool 一律无条件注册，勿做注册期门禁
}
```

再补三样 pi 侧的东西：`index.ts`（re-export 扩展入口，`.ts` 后缀）、
`package.json` 的 `pi.extensions: ["./extensions/myext.ts"]`、`peerDependencies` 钉
`@earendil-works/pi-coding-agent >= 0.86.0`（`src/injection/version.ts` 是下界的单一真相源）。

**完整可运行骨架**：`test/injection.test.ts` 的「最小扩展（snip）」一节 ——
它用内核现搭了一个代码片段库扩展（2 场景 + 结果回流 + 降级 + 旧宿主跳过），16 条断言全绿。
照抄那一节，把 `SNIP_SCENES` / `snipSpec` 换成你的即可。

## 目录内各件

| 文件 | 职责 |
| --- | --- |
| `version.ts` | 宿主版本下界（`MIN_PI_FOR_STRUCTURED = "0.86.0"`，实测 0.85 无 sections） |
| `host.ts` | 宿主能力探测（按字段存在性判定，不猜版本）+ `InjectionHost` 契约 |
| `clock.ts` | 时间锚点（日期/时刻/时段）——模型不该自己推算日期 |
| `facts.ts` | tool 结果回流（只采集自家前缀 + 摘要截断 + 可选计数） |
| `router.ts` | 场景路由（优先级遍历 + 低信息量粘性） |
| `fragments.ts` | 状态驱动片段：`when` 谓词 + `text` 可插真实数字 |
| `layers.ts` | 分层装配：按变化频率分段，空正文的层不进结果 |
| `prune.ts` | tool 足迹裁剪（只裁文本，不动可调用工具集） |
| `bytes.ts` | 预算度量原语（字节/行数/pi skill 发现条目 XML） |
| `runtime.ts` | 一轮编排：探测 → 收敛 → **构造** → **落地** → 降级；三个事件订阅 |

## 换领域时最容易犯的错

| 错 | 后果 | 正确做法 |
| --- | --- | --- |
| 把「每轮都变」的事实塞进恒定层 | 稳定层每轮重刷 cache | 单独一段易变层 |
| 片段 `when` 里读配置/时间（非纯函数） | 同一状态两轮注入不同 → cache 永远 miss、测试不可复现 | 状态只从 `buildState` 的快照取 |
| 片段提到的 tool 不在该场景 `tools` 白名单里 | 模型按片段调一个 guideline 已被裁掉的 tool | 写一致性测试（pition 的 `test/sop.test.ts`） |
| 用 `setActiveTools` 做场景门禁 | 会话中现配的能力用不了 | 只裁 guideline 文本 |
| 降级路径里也塞场景内容 | 降级就不叫降级了 | 只写 core |
| 易变层里写建议 | 与场景片段重复注入 | 易变层只放事实 |

## 验证怎么做

1. **假 pi 单测**（快）：照 `test/injection.test.ts` 搭一个按注册顺序跑全部 handler 的假 pi。
   注意 `on` 不能写成 `handlers[event] = handler`——那会只留最后一个 handler，
   `session_start` 有多个订阅时被漏掉。
2. **真宿主测试**（慢但必需）：pition 的 `scripts/dev/host-harness.mjs` 已参数化
   （`root` / `configEnv` / `configFile` / `expectedTools`），换成你的扩展即可复用——
   它是唯一能验证「我 mutate 的 `systemPromptOptions` 真是宿主后来用的那个对象」的手段。
   只测假 pi = 假设错了也全绿。
3. **预算门禁**：`bytes.ts` 的原语 + 自己的上限，把常驻字节固化成产物并在 CI 校验漂移
   （pition 的做法见 `src/context-budget.ts` + `scripts/check-context-budget.mjs`）。
