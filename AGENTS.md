# pition 开发规范（给 AI 协作者）

## 项目一句话

pition 是一个 pi coding agent 扩展：把 Notion 数据库变成 agent 的持久化存储。
单库心智（currentBindingId 选定后所有 tool 都操作它）、page 列表对 agent 透明、
属性默认 append 合并、区间事件（span）由全局提示词持续注入。

## Code Quality

- 改代码前完整读目标文件，不要靠搜索片段做宽改动。
- 无构建步骤是刻意的：pi 用 jiti 直接加载 TS 源码。不要引入 dist/esbuild。
- **`extensions/pition.ts` 是纯注册层**（tool schema + 委托 `src/tools/`）；业务逻辑一律写进 `src/`。
- tool 参数 schema 一律 `Type.Array(Type.Object({name, value}))` 数组对，禁 `Type.Record`（MiniMax 嵌套解析会坏）。
- tool execute 第一行必须 `currentBinding()` 或 `loadConfig()` 重读——禁止闭包持有工厂期的 cfg（切库后 handler 会查旧库）。
- tool 的 `description` 不写 cfg 衍生字符串（库标题/字段说明）；要字段名就指向每轮注入的 `pition_fields` 段（补说明用 `pition_boot stage=describe_fields`）。
- 每个 tool 必须有 `promptSnippet`（一行，pi 的 tools 层索引）；`promptGuidelines` 只放 1-3 条工具自身机理。
- match 周围代码风格；单行 helper 只有一处调用就内联。

## 注入架构（「模型看到什么」的唯一入口，改前必读）

一轮 `before_agent_start`（`src/role-mode.ts`）先做**场景路由**与**状态快照**，再分层写进 `sections`。
与领域无关的机械已抽到 **`src/injection/`**（可整目录复制到别的 pi 扩展复用，见 `src/injection/README.md`）；
pition 侧只填插槽，机械部分不要在本项目的领域模块里重实现。

| 层 | section | 内容 | 何时出现 |
| --- | --- | --- | --- |
| 恒定 | `pition_core` | 库标签 + 工具索引 + 3 条硬边界 | 助理模式开 |
| 场景 | `pition_scene` | **按状态装配**的剧本片段（`src/sop.ts`） | 场景 ≠ chat |
| 事实 | `pition_fields` | 当前库字段字典（`src/fields.ts`，带预算截断） | 需要写属性的场景 |
| 易变 | `pition_runtime` | 现在几点 + 本会话写了什么 + 上一轮失败/警告 | 助理模式开（每轮都变） |
| 运行时 | `pition_span` / `pition_goal` | 进行中事件 / 今日目标进度 | 有数据即注入（与助理模式无关） |

- **场景路由**：`src/scene.ts#routeScene(event.prompt, prev)`，优先级 setup > train > recall > log > chat，
  低信息量消息继承上一场景（粘性）。新增场景 = 在 `sop.ts` 加片段 + 在 `scene.ts` 加触发正则 + `test/scene.test.ts` 加用例。
- **SOP 必须片段化、状态驱动**（`SopFragment.when(state)`）：**禁止写「无论什么状态都注入同一段长文」**——
  这是本项目明确整治过的病（教怎么建一个已经建好的目标 = 噪音 + 误导）。片段文案可以是函数以插入真实数字。
- **易变内容单独成段**（`pition_runtime`）：它每轮 diff，不能和稳定内容挤在一个 section，否则稳定层也跟着刷 cache。
  易变层**只放事实不放建议**（建议属场景片段，两边都写就成重复注入）。
- **状态只在 `src/prompt-state.ts` 汇总**（纯函数、`now` 可注入）：要新的动态事实就加进 `PromptState`，
  别在 role/sop 里各读各的 cfg/时间。
- **tool 足迹按场景裁剪**（`src/injection/prune.ts#pruneToolGuidelines`，由 `role.ts` 再导出）：
  只把不相关 tool 的 guideline 文本置空。**禁止 `setActiveTools`**——能力不做场景门禁（见下方已知坑第一条）。
- **禁用 `forceSystemPrompt`**；只用 `promptGuidelines.push` / `sections[name]` 增量注入（保 cache prefix）。
- **tool 结果要回流**：`tool_execution_end` 采集进 `SessionFacts`，失败/警告下一轮带出（模型常忽略 tool 结果里的警告）。
- **宿主能力要先探测**（`src/injection/host.ts#supportsStructuredInjection`）：`sections` / `toolGuidelines` 是 pi 0.86 才有的。
  旧宿主上硬写 `sections[x] = y` 会每轮抛错被 pi 的错误边界吃掉 —— 表现为**静默零注入**。
  探测、跳过 + 提示一次、装配异常降级、**先构造后落地**（不留半成品）都由
  `src/injection/runtime.ts#createInjectionRuntime` 统一负责——不要在 `role-mode.ts` 里另写一遍。
- **注入假设必须过真宿主校验**（`test/host-injection.test.ts`，用真实 loader + ExtensionRunner）。
  只测「假 pi」等于测我自己写的假设——它验证不了「我 mutate 的 options 是不是宿主真正用的那个」。
- **预算门禁**：`npm run context:check` 对着 `docs/context-budget.json`（常驻字节台账）校验；
  改了 tool 描述 / SOP 片段 / prompt-state / skill frontmatter 后必须 `npm run context:generate` 刷新，否则 check 会红。
  细节要进 on-demand skill（`skills/*.md`），不许进常驻 prompt。

## 用这套内核造别的扩展

`src/injection/` 不依赖任何 pition 领域概念，**整目录复制即可复用**。

一条命令起步（生成物自带自检，且 pi 版本下界从内核 `version.ts` 读，不会抄错）：

```sh
node scripts/new-extension.mjs ~/code/my-ext --name my-ext
```

完整教程在 `src/injection/README.md`（含最小可运行骨架 + 换领域时最容易犯的错）；
可照抄的现成例子是 `test/injection.test.ts` 里的「最小扩展（snip）」一节（16 条断言，全绿）。
脚手架本身有 `test/new-extension.test.ts` 兜底：内核复制是否逐字节一致、占位符是否全被替换、
下界是否等于 `MIN_PI_FOR_STRUCTURED`、目标目录已存在是否会拒写。

改动纪律：内核是**跨扩展共享**的，往里加东西前先问「这是机械还是领域」——
领域内容一律留在消费者的适配层（pition 对应 `sop.ts` / `scene.ts` / `prompt-state.ts` / `role.ts`）。

## Commands

```bash
npm run check       # 五门：lint → typecheck → test → context:check → smoke（提交前必跑）
npm run lint:fix    # biome 自动修复
npm test            # vitest（单元 + 集成，含真宿主注入校验）
npm run context:generate            # 刷新注入预算台账（改了注入面就跑）
node scripts/dev/diag-injection.mjs "记一下今天吃了火锅"   # 「模型到底看到什么」：真实注入内容
node scripts/dev/diag-session.mjs   # SDK 会话装配诊断（需先 npm install）
```

改代码后必须跑 `npm run check` 并修到全绿。改了注入面还必须 `npm run context:generate` 并提交台账。
**peer 下界不要随手放宽**：`sections` / `toolGuidelines` 是 pi 0.86 才有的（0.85 实测没有）。

## 发布流程（tag 驱动，GitHub Actions 自动 npm publish）

1. bump `package.json` version
2. `CHANGELOG.md` 的 `## [Unreleased]` 挪到新版本节
3. commit + push main
4. `git tag v0.x.y && git push origin v0.x.y` → release workflow: smoke → 校验 tag=version → npm publish --provenance → GitHub Release
5. 本地 `npm view @flowot/pi-pition versions` 验证收录（本地 publish 返回 `+` 不代表服务端收录）

## Git

- agent 永不 commit/push——除非用户明确要求。
- 禁 `git reset --hard` / `git clean -fd` / force push。
- 工作树保持用户留下的样子。

## 已知坑（全部实证踩过）

| 坑 | 预防 |
| --- | --- |
| 工厂期用 cfg 做注册门禁 → 会话中现配的库看不到运行态 tool | 7 个 tool 无条件注册；execute 内 `currentBinding()` 抛错指引 |
| 用 `setActiveTools` 做场景门禁 → agent 需要时调不到 | 永不改可调用工具集；只裁文本（`pruneToolGuidelines`） |
| 常驻注入膨胀（每轮都付）→ token 涨、还误导模型过度落库 | `npm run context:check` 门禁；细节进 `skills/*.md` |
| **SOP 写成固定长文** → 一半内容是当下不成立的（教怎么建已建好的目标） | 片段化 + `when(state)`；`test/sop.test.ts` 断言片段集随状态变 |
| **宿主 API 变化 → 每轮静默零注入**（不报错、功能全无） | 能力探测 + 提示一次 + 降级兜底；peer 下界钉在 0.86（有 sections 的最早版本） |
| **只测「假 pi」** → 全绿但功能失效（假设错了） | `test/host-injection.test.ts` 走真实 loader + runner；排障用 `diag-injection.mjs` |
| **易变内容混进稳定 section** → 每轮 cache 全刷 | 易变只放 `pition_runtime`；台账里该段另有 `runtimeBytes` 上限 |
| tool 缺 `promptSnippet` → 不进 tools 层索引，模型只能靠 schema 猜 | `test/extension.test.ts` 断言 7/7 覆盖 |
| 场景片段提到白名单外的 tool → 模型按剧本调一个 guideline 被裁掉的 tool | `test/sop.test.ts` 一致性校验 |
| 模型自己推算日期 → 落成未来日期/认错今天 | `pition_runtime` 明确给出现在日期时刻并要求「以此为准」 |
| npm publish 本地返回 `+` 但服务端 404（CDN 延迟/静默拒收） | 必须 `npm view` 验证；同版本重发报 403 就 bump |
| `NODE_AUTH_TOKEN` 新版 npm 不认 | release.yml 里写 `~/.npmrc` |
| smoke-load 依赖本机绝对路径 | 已改为 node_modules 相对解析 + 临时 cfg + PITION_CONFIG 隔离 |
| 中文注释在编辑器转码出现 mojibake | 发现即修；ASCII 安全的标识符优先 |
