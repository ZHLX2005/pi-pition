# Contributing to pition

感谢参与。本文件说明**怎么改、怎么验、怎么发**。

## 环境准备

```bash
git clone https://github.com/ZHLX2005/pi-pition.git
cd pi-pition
npm install          # 装 devDependencies（含 pi 包、typebox、jiti、vitest、biome）
```

无需构建步骤——pi 用 jiti 直接加载 TypeScript 源码。

**Node ≥ 22.19**（`engines` 与宿主 pi 对齐）；**pi ≥ 0.86**（`sections` / `toolGuidelines` 是 0.86 才有的，
注入分层依赖它们；0.85 及以下实测没有这两个字段）。

验证 peer 下界（会临时换掉 node_modules 里的 pi，验完 `npm install` 恢复）：

```bash
npm install --no-save @earendil-works/pi-coding-agent@0.86.0
node scripts/dev/diag-injection.mjs "记一下今天吃了火锅"   # 应能正常列出注入的 section
npm test && npm install
```

## 目录结构

```
src/                 按职责分层的实现（无 pi 运行时依赖，纯函数优先）
  injection/         **注入内核：与 pition 领域无关，可整目录复制到别的 pi 扩展复用**
                     （version/host/clock/facts/router/fragments/layers/prune/bytes/runtime）
                     使用教程见 src/injection/README.md；可照抄的骨架见 test/injection.test.ts
  types.ts           领域类型 + WRITABLE_TYPES
  config.ts          配置读写、历史格式归一、currentBinding/currentSpans 解析器
  notion.ts          Notion HTTP 客户端（抗抖动重试 + 超时）
  properties.ts      Notion property 编解码与 append 合并语义
  time.ts            时间戳 / [HH:MM] 前缀 / 区间格式化
  span.ts            区间事件状态机
  goal.ts            每日目标状态机（物化/推进/cron）+ 注入渲染
  scene.ts           场景路由：用户原话 → 场景 id（带粘性）
  sop.ts             场景 SOP 注册表（**状态驱动的片段** + 每场景 tool 白名单）
  prompt-state.ts    本轮状态快照（时刻/时段/目标/字段覆盖/会话事实）+ 易变层渲染
  fields.ts          字段字典渲染（当前库可写字段 + append 语义，带预算截断）
  role.ts            按场景分层装配注入（core/scene/fields/runtime）+ tool 足迹裁剪（内核的适配层）
  role-mode.ts       助理模式：把 pition 领域逻辑接到内核运行时（injection/runtime.ts）
                     + /pition-mode 命令
  context-budget.ts  注入预算度量（常驻字节台账，进 npm run check）
  databases.ts       Notion 库发现与 schema 读取
  wizard.ts          /pition 交互式配置向导
  boot-ctx.ts        boot 描述里的「当前状态」摘要拼装
  tools/             每个 tool 两个文件：<name>.ts 是定义（schema/描述/snippet），<name>-run.ts 是实现
    boot.ts / boot-run.ts            5 阶段配置状态机
    write.ts / write-run.ts          日常主路径：改属性 + 追加正文 + todaySoFar 预览
    read.ts / read-run.ts
    history.ts / history-run.ts
    create_today.ts / create_today-run.ts
    span.ts / span-run.ts
    goal.ts / goal-run.ts            每日目标：CRUD + 进度控制 + bindField 投影
    schemas.ts                       共享参数 schema（PROPERTY_ENTRY / QUERY_FILTER_SCHEMA）
extensions/
  pition.ts          纯装配层：注册 2 命令 + 2 事件 + 遍历注册 7 个 tool
skills/              3 个场景 SOP（pi 原生分发）：daily-log / goal-coach / setup
docs/                契约层文档：tools.md（参数语义）、goal-requirements.md、context-budget.json（注入预算台账）
test/                vitest 单元 + 集成测试（`host-injection.test.ts` 走真实 pi 宿主，
                     `injection.test.ts` 是内核自测 + 最小扩展骨架，
                     `new-extension.test.ts` 是脚手架自检）
scripts/             smoke-load.mjs（jiti 冒烟）、check-context-budget.mjs（预算门禁）、
                     new-extension.mjs（一条命令造新扩展：复制内核 + 生成骨架，
                     配 new-extension.d.mts 给测试一个类型边界）
  dev/               host-harness.mjs（真宿主装配）、diag-injection.mjs（模型看到什么）、
                     diag-session / diag-loader / diag-command / wizard-check / e2e-agent（本机诊断）
```

**分层原则**：`src/` 里的模块**不 import pi 运行时**（除了 `wizard.ts` 的结构化 ctx 契约）。
所有 pi API 调用集中在 `extensions/pition.ts`。这样 `src/` 可以在普通 Node 进程里直接测。

## 开发命令

```bash
npm run check        # 五门：lint → typecheck → test → context:check → smoke（提交前必跑）
npm run lint:fix     # biome 自动修复
npm test             # vitest（单元 + 集成，含真宿主注入校验）
npm run test:watch   # 监听模式
npm run context:generate             # 重新生成 docs/context-budget.json（改了注入面就必须跑）
npm run context:check                # 校验注入预算是否漂移/超限
node scripts/dev/diag-injection.mjs "记一下今天吃了火锅"   # 「模型到底看到什么」——真实宿主注入内容
node scripts/dev/diag-session.mjs    # 本机 pi 会话装配诊断（需先 npm install）
```

> **本机沙箱注意**：vitest 并发时会偶发 `EPERM ... \<tmp>\ssr\<hash>`，后果不是报错而是**静默丢掉
> 部分测试文件**（13 个文件掉到 11 个、退出码仍为 0）。验证请用
> `npx vitest run --no-file-parallelism`。CI 是正常文件系统，不受影响。

## 改代码时的硬约束

1. **tool 一律无条件注册**。不要在工厂里用 `if (!cfg) return` 挡住 `registerTool`——
   配置是在会话中现配的，注册期做门禁会导致工具缺失（详见 `.claude/skills/pition-dev/references/B01-注入点清单.md` §6.4）。
   校验下沉到 `execute` 首行的 `currentBinding()`。

2. **不要闭包捕获工厂期的 cfg**。每个 `execute` 都重新 `loadConfig()`——
   否则切库后仍查旧库。用 `src/config.ts` 的 `currentBinding()` / `currentSpans()`。

3. **tool 参数用 `Type.Array(Type.Object({name, value}))`，不用 `Type.Record`**——
   实测 MiniMax 对 Record 形态的嵌套参数解析会坏（字段名变 `$text`）。

4. **`details` 一律经 `detail({...})` helper 包一层**——pi 的 `registerTool` 会从返回推导
   `AgentToolResult<TDetails>`，多分支不同形状会推成 union 而炸类型。

5. **提示词注入只用 `promptGuidelines.push` 与 `sections[name]`**，
   禁用 `forceSystemPrompt`（整段替换 = prompt cache miss）。

6. **永不调用 `setActiveTools()`**——能力（可调用的 tool 集合）不做场景门禁：把工具摘掉，
   agent 就无从下手，而运行时抛错至少还能指路（同 §1 的血债）。要「少注入」就少注入
   **文本**：`src/injection/prune.ts#pruneToolGuidelines`（由 `role.ts` 再导出）按场景把不相关
   tool 的 `promptGuidelines` 置空。

7. **每个 tool 必须给 `promptSnippet`**（一行）——没有它，tool 不进 pi 的 tools 层
   「Available tools」索引，模型只能靠 schema 猜。`promptGuidelines` 控制在 1-3 条
   工具自身机理，场景化的用法写进 `src/sop.ts`，别堆进 tool。

8. **注入分层不许越界**：恒定事实进 `sections.pition_core`，场景剧本进 `sections.pition_scene`
   （**按状态装配**，只在命中场景出现），库字段字典进 `sections.pition_fields`，每轮都变的那几行
   进 `sections.pition_runtime`；运行时事实（span/goal）由 `role-mode.ts` 独立注入。
   改任何「模型看到什么」前先读 `.claude/skills/pition-dev/references/C01-上下文多层结构.md`。

9. **SOP 必须片段化、状态驱动**：写 `SopFragment`（`when(state)` + `text`），**禁止**在
   `sop.ts` 里堆「无论什么状态都注入的固定长文」——那正是本项目整治过的病（教怎么建一个已经
   建好的目标 = 噪音 + 误导）。动态事实（时间、会话进度、目标状态）一律经 `PromptState` 进片段。
   `test/sop.test.ts` 会断言：片段集随状态变、片段提到的 tool 必须在场景白名单内、文案里不出现
   未知标识符（防拼错 tool/section 名）。

10. **tool 结果要回流**：新增 tool 若会产生「警告/可恢复失败」，在 `tool_execution_end` 里被
    `outcomeFromEvent` 采集（自动），并在对应场景片段里给出对策——别指望模型主动注意 tool 结果。

11. **注入预算有门禁**（`npm run context:check`）：常驻面一旦超上限就失败，逼你把细节挪回
    on-demand skill（`skills/*.md`）而不是让常驻 prompt 悄悄膨胀。改了 tool 描述 / SOP 片段 /
    `prompt-state.ts` / skill frontmatter 后必须 `npm run context:generate` 刷新台账并一起提交。

12. **注入假设必须过真宿主校验**：`test/host-injection.test.ts` 用真实 pi 的
    `discoverAndLoadExtensions` + `ExtensionRunner` 跑 `before_agent_start`（不碰模型、离线）。
    只测「假 pi」（`test/extension.test.ts` 里那个）验证不了「我 mutate 的 options 是不是宿主真正
    用的那个对象」——假设错了会全绿而功能失效。新增注入面时在这个文件里补一条断言。

13. **旧宿主不能崩，也不能装作在干活**：`sections` / `toolGuidelines` 是 pi 0.86 才有的
    （0.85 实测没有）。注入前先 `supportsStructuredInjection()` 探测；不支持就整体跳过并提示一次。
    硬写 `sections[x] = y` 会每轮抛错 → 被 pi 的错误边界吃掉 → **静默零注入**（最难查的一类故障）。
    探测 / 跳过 / 降级 /「先构造后落地」都由 `src/injection/runtime.ts` 统一负责，别在
    `role-mode.ts` 里另写一份。

14. **`noExplicitAny` 在 biome 里是关闭的，这是有意的**：Notion API 的响应结构
    （`page.properties` / `blocks.children`）形状随用户数据库 schema 变化，在接入官方 SDK 前
    无法静态描述；强行标注会引入大量错误的类型断言。规避手段是**把 `any` 限制在 IO 边界**
    （`src/notion.ts` / `src/properties.ts` 的解析函数），业务层用收窄后的类型。

15. **区分「机械」与「领域」**：与 pition 领域无关的注入机械（宿主探测、分层装配、片段求值、
    场景路由、结果回流、足迹裁剪、字节度量、一轮编排）只放进 `src/injection/`；
    pition 特有的内容（Notion/目标/字段字典/场景文案）留在领域模块。
    往内核里加东西前先问一句「另一个扩展会用得到吗」——用不到的就别放进去。
    内核改动要同步 `src/injection/README.md` 与 `test/injection.test.ts`。

## 加/改 tool 的流程

1. 在 `src/` 写纯逻辑（可测），`extensions/pition.ts` 里只做注册 + 组装
2. 在 `test/extension.test.ts` 的 `EXPECTED_TOOLS` 加上新 tool 名
3. 补 `promptSnippet`（必填）+ ≤3 条 `promptGuidelines`；把「什么时候用」写进对应场景的
   `src/sop.ts` **片段**（带 `when` 条件，别写无条件长文），并确认该场景的白名单包含它
   （`test/sop.test.ts` 会校验一致性）
4. 若有新的恒定事实要注入 → 归到 `role.ts` 的某个 section，不要新增 section 名；
   若需要新的动态事实 → 先加进 `PromptState`（`src/prompt-state.ts`），再在片段里消费
5. 给核心行为写单元测试（断言行为，不要写空壳）
6. `npm run context:generate` 刷新预算台账
7. 跑 `npm run check`

## 提交与发布

- 提交信息用祈使句、说清"为什么"而不只是"做了什么"
- 发布走 tag 驱动（CI 自动 npm publish）：
  ```bash
  # 1. 改 package.json version + 更新 CHANGELOG.md
  # 2. commit + push
  git tag v0.x.y && git push origin v0.x.y
  # → GitHub Actions: smoke → 校验 tag==version → npm publish --provenance → GitHub Release
  ```
- 发布后用 `npm view @flowot/pi-pition versions` 确认服务端已收录
  （本地 `npm publish` 返回 `+` 不代表服务端收录）

## License

MIT
