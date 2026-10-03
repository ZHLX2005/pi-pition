---
name: pition-dev
description: pition 项目（Notion 个人记录助手，pi coding agent 扩展）的开发与排障指南；也是**用 pition 的注入内核 src/injection/ 造别的 pi 扩展**的入口（整目录可复制复用，教程 src/injection/README.md，骨架 test/injection.test.ts）。当在本项目新增/修改 tool、调整注入面（模型看到什么）、改场景 SOP 片段、调配置格式、改字段说明、排查扩展不加载或工具不出现、安装部署、跑验证，或要复用/改动注入内核时使用。含 pi 加载链路（本项目实证）、注入分层与状态驱动片段、注入预算门禁、排查阶梯、高频坑与验证工作流。
---

# pition 开发指南

pition 把 Notion 数据库变成 pi agent 的持久化存储：agent 通过 7 个 tool 识别对话中的记录内容并自动写入。
自包含成包，通过 `~/.pi/agent/settings.json` 的 `packages` 声明或 `scripts/install.mjs` 物化两种方式安装。

> **数据快照：v0.6.0**（分层注入 + 注入预算门禁 + 注入内核可复用）。行号一律不写——实现已按职责拆到 `src/`，
> 定位用**文件 + 函数名**。改注入面前必读 [[C01-上下文多层结构]]。

## Tool 一览（7 个）

| tool | 用途 | 要点 |
| --- | --- | --- |
| `pition_boot` | **元工具**：5 阶段渐进式配置（token → select_db → describe_fields → set_mode → done） | 引导态统一入口；description 里动态拼了当前状态；任意阶段可中断。详见 [[A01-设计理念]] |
| `pition_write` | **日常主路径**：改当前 page 属性 + 追加正文 | 属性默认 append 合并（multi_select union / number 累加 / rich_text 拼接 / date 取更早 / checkbox 取 OR）；`overwrite: true` 显式覆盖；返回 todaySoFar 整页预览 |
| `pition_read` | 读当前 page 完整内容 | properties + 所有正文 block |
| `pition_history` | 翻旧账查 page 列表 | 带单字段 filter；日常不调 |
| `pition_create_today` | 逃生口：手动建 page | 默认不调——page 由 Notion 定时任务管，write 返回 warning 时才用 |
| `pition_span` | **区间事件** start / end | start 仅落 `cfg._activeSpans`（支持并行多事件）；end 才落 Notion；进行中由 `sections.pition_span` 注入；end 可带 goalItemName/goalDelta 联动 goal |
| `pition_goal` | **每日目标**：CRUD + 进度控制 | 5 action（set/progress/list/update/delete）；进度由 `sections.pition_goal` 每轮注入；autoPeriod（daily/cron）跨天自动归零重开；bindField 看板投影；冷设置可用（未配 Notion 也能跑） |

### `pition_boot` 调用契约

```ts
{ stage: "token", token: "ntn_..." }                 // 1 登录落盘（校验 /v1/users/me）
{ stage: "select_db" }                               // 2 列库 → 返回库列表
{ stage: "select_db", dbId: "<id>" }                 // 2' 直接接管 + 切换当前库
{ stage: "describe_fields", dbId: "<id>",            // 3 一次性提交字段说明
  fieldDescriptions: [{ name: "Name", description: "记录标题，一般是当天日期" }],
  bindingDescription: "个人日常记录总表" }
{ stage: "set_mode", enabled: true }                 // 4 助理模式（= /pition-mode）
{ stage: "done" }                                    // 5 查状态（token / 当前库 / 覆盖率 / 助理模式）
```

**渐进式回访**：只改某一阶段产物时直接调对应 stage，不必从 `token` 重走。

## 工程结构

```
pition/
├── index.ts              包入口（pi 包形式加载认包根 index.ts，re-export extensions/pition.ts 用 .ts 后缀）
├── extensions/pition.ts  纯装配层：2 命令 + 2 事件 + 遍历注册 7 个 tool
├── src/                  实现（不 import pi 运行时，普通 Node 进程可直接测）
│   ├── injection/        **注入内核：与 pition 领域无关，整目录可复制到别的扩展复用**
│   │   │                 教程 src/injection/README.md；可照抄骨架 test/injection.test.ts
│   │   ├── version.ts    宿主版本下界 0.86.0（单一真相源）
│   │   ├── host.ts       宿主能力探测（缺 sections 就整体跳过，防静默零注入）
│   │   ├── clock.ts      时间锚点（日期/时刻/时段）
│   │   ├── facts.ts      tool 结果回流（只采集自家前缀 + 截断 + 可选计数）
│   │   ├── router.ts     场景路由机械（优先级 + 低信息量粘性）
│   │   ├── fragments.ts  状态驱动片段（when 谓词 + text 可插真实数字）
│   │   ├── layers.ts     分层装配（按变化频率分段；空正文的层不进结果）
│   │   ├── prune.ts      tool 足迹裁剪（只裁文本，不动可调用工具集）
│   │   ├── bytes.ts      预算度量原语（字节/行数/pi skill 发现条目）
│   │   └── runtime.ts    一轮编排：探测 → 收敛 → 构造 → 落地 → 降级 + 3 个事件订阅
│   ├── scene.ts          场景路由（pition 的信号表；机械在 src/injection/router.ts）
│   ├── sop.ts            场景 SOP 注册表（**状态驱动的片段** + 每场景 tool 白名单）
│   ├── prompt-state.ts   本轮状态快照（时刻/时段/目标/字段覆盖/会话事实）+ 易变层渲染
│   ├── fields.ts         字段字典渲染（预算截断 + 确定性排序）
│   ├── role.ts           分层注入装配（core/scene/fields/runtime）——内核的适配层
│   ├── role-mode.ts      把 pition 领域逻辑接到内核运行时 + /pition-mode
│   ├── context-budget.ts 注入预算度量（纯函数）
│   ├── goal.ts / span.ts / properties.ts / notion.ts / config.ts / time.ts / databases.ts / boot-ctx.ts / wizard.ts / types.ts
│   └── tools/            <name>.ts（schema/描述/snippet）+ <name>-run.ts（实现）
├── skills/               3 个场景 SOP（pi 原生分发）：daily-log / goal-coach / setup
├── docs/                 tools.md（参数契约）、goal-requirements.md、context-budget.json（注入预算台账）
├── scripts/
│   ├── smoke-load.mjs             jiti 冒烟（fake pi 数注册的 tool + 命令 + boot 契约）
│   ├── check-context-budget.mjs   注入预算台账生成/校验（--check）
│   ├── install.mjs                物化到 <agent-dir>/extensions/（一般 npm 用户不需要）
│   └── dev/                       真宿主与诊断工具
│       ├── host-harness.mjs       真 pi loader + ExtensionRunner 装配（+ .d.mts 类型声明）
│       ├── diag-injection.mjs     「模型到底看到什么」：打印这一轮注入的 section / 裁剪结果
│       └── diag-loader / diag-session / diag-command / wizard-check / e2e-agent / notion-fetch
├── pition.config.json    配置（数据与代码分离；不进 git）
└── .claude/skills/pition-dev/     本开发指南（A/B/C 序列 references）
```

## 配置入口：`/pition` 向导

配置**不需要手编 JSON**。在 pi TUI 里跑 `/pition` 四步交互完成；也可全走 `pition_boot`（agent 自动化友好）。

实现要点：

- **命令必须无条件注册**（在 `loadConfig()` 之前调 `registerSetupCommand(pi)`）——否则没配置时进不去向导，形成死锁
- 向导用 `ctx.ui.input/select/confirm/notify`；`ctx.hasUI` 为假（`pi -p` 打印模式）时提示改用 TUI
- 向导写配置用 `notionWith(token, ...)`（接受未保存的 token 试连），tools 用 `notion(cfg, ...)`
- 中途取消（`ui.input` 返回 undefined）→ 整次不保存
- 可写字段白名单 `WRITABLE_TYPES`（formula/relation/rollup 等计算字段自动过滤）

⚠️ `pi -p "/pition"` **不会**触发命令——打印模式把斜杠文本当普通消息发给模型。验证命令注册用 `diag-command.mjs`。

## pi 加载链路（本项目实证，机制出自 pi v0.87.1 源码）

```
pi 启动
 └─ 读 <agent-dir>/settings.json 的 packages: [路径]
     └─ 目录形式 → 优先认包根 index.ts → 视为单一扩展
         └─ jiti 加载 index.ts → re-export ./extensions/pition.ts（.ts 后缀！）
             └─ 执行工厂 → loadConfig() 两级查找（extensions/ → 包根 → agent 目录）
                 └─ 7 个 tool 全部【无条件】注册（无工厂期门禁）
                     └─ 任一环节静默失败 = 0 工具、0 报错
```

关键机制：

- **jiti 虚拟模块**：`typebox`、`@earendil-works/pi-coding-agent` 由 pi 注入 alias，扩展不需要本地 node_modules
- **index.ts 遮蔽效应**：包根有 index.ts 后 `extensions/` 子目录自动扫描失效——单一入口形态，勿再放裸扩展文件到包根
- **配置持久化**：npm 安装形态落 `<agent-dir>/extensions/pition.config.json`（重装/升级不丢）；仓库开发形态在包内 walk-up

## 配置格式（pition.config.json）

```jsonc
{
  "token": "ntn_...",
  "bindings": {                         // 按 dbId 索引；切空间不丢字段说明
    "32位库id": {
      "dbId": "32位库id",
      "title": "agent 看到的存储名",
      "description": "库用途说明",
      "fields": {
        "字段名": { "type": "title|rich_text|number|select|multi_select|status|checkbox|date|url|email|phone_number",
                    "description": "给 agent 的字段语义说明——产品核心，按场景注入（pition_fields）" }
      }
    }
  },
  "currentBindingId": "32位库id",
  "_assistantMode": false,              // 助理模式开关（boot stage=set_mode 或 /pition-mode）
  "_activeSpans": [],                   // 进行中的区间事件（span start 写入，end 移除）
  "_activeGoals": []                    // 按天持久的目标（goal set 写入；按 date 分区，无清理）
}
```

- formula / relation / rollup 等计算字段不可写，勿入配置
- 简单值约定：LLM 只填标量，`toNotionProperty()` 负责转 Notion API 格式
- **属性 append 语义**：`{name, value}` 默认 append（multi_select union / rich_text 拼接 / number 累加 / date 取更早 / checkbox OR）；
  单值字段（title/select/status/url/email/phone_number）永远新值；覆盖需显式 `overwrite: true`
- 切空间 = 改 `currentBindingId`，之前所有库的 `bindings[dbId]` 永久保留
- **配置热生效**：`before_agent_start` 与每个 tool `execute` 都重读 cfg，改完不用重启

## 开发工作流

1. 改 `src/`（业务）或 `extensions/pition.ts`（只做注册/组装）
2. `npm run check` — **五门**：lint → typecheck → test → context:check → smoke
3. 改了注入面（tool 描述/SOP/skill frontmatter/guidelines）→ `npm run context:generate` 刷新台账并一起提交
4. `node scripts/dev/diag-session.mjs` — 装配层：工厂执行后 7 个 tool 是否都在 session tools 里
5. 改向导逻辑时跑 `node scripts/dev/wizard-check.mjs` — 真 token 验证列表库/schema/可写字段过滤
6. 真模型 E2E：`node scripts/dev/e2e-agent.mjs`（或 `pi -p "记一下今天跑了 5 公里"`）
7. 交互式命令实测：在 pi TUI 里跑 `/pition`、`/pition-mode`（打印模式不触发命令）

模型直连（测试用）：用户 pi 的 `~/.pi/agent/models.json` 已定义 `new-provider`（MiniMax，anthropic-messages）；CLI 指定 `--provider new-provider --model MiniMax-M3`。

## 高频坑（全部实证踩过）

| 坑 | 表现 | 根因 / 预防 |
| --- | --- | --- |
| **工厂期 cfg 门禁**（最严重） | 会话中现配的库看不到运行态 tool，必须 /reload | `pi.registerTool` 只在工厂执行期有效——**7 个 tool 一律无条件注册**，校验下沉到 `execute` 首行的 `currentBinding()`。详见 [[B01-注入点清单]] §6.4 |
| **用 `setActiveTools` 做场景门禁** | agent 需要时调不到工具（能力被摘） | 永不改可调用工具集；只裁 guideline **文本**（`pruneToolGuidelines`） |
| **常驻注入膨胀** | token 涨、还误导模型过度落库 | `npm run context:check` 门禁（`docs/context-budget.json`）；细节放 `skills/*.md` |
| **SOP 写成固定长文** | 一半内容是当下不成立的（教怎么建已建好的目标）= 噪音 + 误导 | 片段化 + `when(state)`；状态只从 `PromptState` 取；`test/sop.test.ts` 断言片段随状态变 |
| **易变内容混进稳定 section** | 稳定内容也跟着每轮刷 cache | 每轮都变的只放 `pition_runtime` |
| **tool 结果不回流** | 模型忽略 tool 里的 WARNING，原样重试 | `tool_execution_end` 采集进 `SessionFacts` → 下一轮易变层 + 片段 |
| **片段与白名单不一致** | 模型按片段调一个 guideline 被裁掉的 tool | `test/sop.test.ts` 一致性校验（片段提到的 tool 必须在白名单内 + 无未知标识符） |
| **宿主缺 sections（pi <0.86）** | 每轮抛错被错误边界吃掉 → **静默零注入**，像「模型不听话」 | `src/injection/host.ts` 探测 + 提示一次 + 降级兜底（都由 `runtime.ts` 编排）；peer 下界钉 0.86 |
| **只测假 pi** | 注入假设错了也全绿 | `test/host-injection.test.ts` 走真 loader + runner；`diag-injection.mjs` 看真注入 |
| tool 缺 `promptSnippet` | 不进 pi 的 Available tools 索引，模型只能靠 schema 猜 | `test/extension.test.ts` 断言 7/7 覆盖 |
| index.ts 写 `.js` 后缀 | Cannot find module | jiti 按字面找文件，re-export 本地 `.ts` 用 `.ts` |
| 包目录无 index.ts 就 pi install | 加载报错 | 包形式加载必须有包根入口 |
| `Type.Record` 做 tool 参数 | MiniMax 嵌套解析坏（字段名变 `$text`） | 用 `Type.Array(Type.Object({name, value}))` 数组对 |
| model 传字符串 `"provider/id"` | `No API key found for undefined` | `ModelRuntime.getModel()` 拿对象传入 |
| agent-dir 错位 | 工具不出现 | 用户 pi 读 `~/.pi/agent`；容器/隔离场景用 `PI_CODING_AGENT_DIR` |
| **npm publish 返回 `+` 但服务端 404** | 误以为发布成功 | CDN 延迟 + 反钓鱼静默拒收。必须 `npm view <pkg> versions` 验证；同版本重发报 403 就 bump |
| 新版 npm 用 `NODE_AUTH_TOKEN` | CI 报 `ENEEDAUTH` | 必须写 `~/.npmrc` |
| `biome check --write` 格式化 `pition.config.json` | 本地 token 配置被改写 | biome.json `files.includes` 里排除该文件 |

## 错误案例

| 错误操作 | 实际后果 | 正确做法 |
|---------|---------|---------|
| 只看 pi TUI 是否报错来判断加载 | 静默失效被漏判 | 跑 diag-session.mjs 看 tools keys |
| 配置路径写死 `dirname(import.meta.url)` | 包形态安装时读到 null，静默 0 工具 | 多级查找（本目录 → 父目录 → agent 目录） |
| 在 pi 源码外猜加载行为 | 反复试错浪费轮次 | 直接读 `@earendil-works/pi-coding-agent/dist/core/` 的 package-manager / loader / system-prompt |
| curl 直接发中文 JSON body | Windows git bash 编码乱码，Notion 报 validation_error | JSON 写临时文件 `--data-binary @file`，或用 node fetch |
| 在工厂里用 `loadConfig()` 结果 gate 任何注册 | 配置是在会话中现配的 → 门禁在配置之前执行 → 工具/命令缺失 | **命令和 7 个 tool 全部无条件注册**，校验下沉到 `execute` 首行 |
| 用 `pi -p "/pition"` 验证命令 | 打印模式当普通消息发给模型，误判"命令没生效" | 交互命令只能在 TUI 里试；注册用 diag-command.mjs 验 |
| 把详细用法堆进 tool 的 `promptGuidelines` / role 长文 | 每轮都付 token，且误导模型 | 场景化用法进 `src/sop.ts`，完整版进 `skills/*.md`；常驻只留恒定事实 |
| 把实现从 `role.ts` 搬到 `src/injection/` 却**没同步文档里的 `文件#函数` 引用** | 文档里的 `role.ts#supportsStructuredInjection` 变成假引用（grep 才发现）；下一个人按文档去找，找不到 | **搬实现 = 搬引用**：`git grep -n "role\.ts#\|role-mode\.ts#"` 全量扫一遍 SKILL.md + references/；`package.json#sources` 之类的锚点同理 |
| barrel 里 `export *` 摊平内核 | 与 pition 的同义导出（`partOfDay` / `applyOutcome` / `pruneToolGuidelines`）撞名，TS 直接报错 | 用 `export * as injection from "./injection/index.ts"` 命名空间导出 |
| 往 `src/injection/` 里 import 领域模块 | 「整目录复制到别的扩展」悄悄失效，而且没人会立刻发现 | 内核零外部依赖 + `test/injection.test.ts` 的守卫断言（扫 import，非同目录即红） |

## 排查阶梯（工具不出现时，从快到慢）

1. `pi list` — 包声明在不在
2. `npm run check` — 本地五门；冒烟挂了就不用往下查
3. `node scripts/dev/diag-loader.mjs` — 发现层：包被解析成什么、有无 errors
4. `node scripts/dev/diag-session.mjs` — 装配层：工厂执行后 7 个 tool 是否都在 session tools 里
   （只出现 `pition_boot` 而缺其余 → 工厂里又加了 cfg 门禁，见高频坑表第一条）
5. `node scripts/dev/diag-command.mjs` — 命令层：`/pition` + `/pition-mode` 是否注册
6. `node scripts/dev/diag-injection.mjs "<用户原话>"` — 注入层：这一轮到底注入了哪些 section、
   tool guideline 裁了谁（模型「不听话」时先看这个；`--full` 打印正文）
7. `npm run context:check` — 预算层：注入面字节是否漂移/超限
8. `pi -p` 真模型实测 — 模型层：schema 兼容性问题（看模型反馈的报错形态）

## 用 pition 的注入内核造别的扩展

`src/injection/` 不依赖任何 pition 领域概念，**整目录复制即可复用**。完整教程在
`src/injection/README.md`（三步 + 最小骨架 + 换领域时最容易犯的错）；可照抄的现成例子是
`test/injection.test.ts` 的「最小扩展（snip）」一节。真宿主验证工具
`scripts/dev/host-harness.mjs` 已参数化（`root` / `configEnv` / `configFile` / `expectedTools`）。

## References

- [[A01-设计理念]] — 引导态（`pition_boot`）的 5 阶段契约 + 助理模式开关的产品逻辑
- [[B00-注入点架构]] — 注入点分类（Tool/Command/Event/Context/设置）的元数据与决策树
- [[B01-注入点清单]] — 当前 pition 所有注入点的位置、契约、扩展指引。**新加 tool 前必看 §6 运行态陷阱**
- [[C00-上下文架构]] — pi 的 9 层 system prompt 与 cache 机制总览
- [[C01-上下文多层结构]] — pition 的注入分层（core/scene/fields/runtime/goal/span）+ 场景路由 + **状态驱动片段** + 裁剪 + 预算门禁
