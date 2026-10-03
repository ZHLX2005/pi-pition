# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-10-03

> **0.5.0 从未发布**（那一轮的工作一直留在工作区未提交、未打 tag），它的全部内容包含在 0.6.0 里；
> 下面保留 0.5.0 条目是为了如实记录演进过程。

### Added

- **注入内核 `src/injection/`（可整目录复制到别的 pi 扩展复用）**：把与 pition 领域无关的
  那半注入机械抽出来，pition 降为它的第一个消费者。教程 `src/injection/README.md`，
  可照抄的最小骨架 `test/injection.test.ts`（用内核现搭一个「snip 代码片段库」扩展，16 条断言）：
  - `version.ts` 宿主版本下界 `MIN_PI_FOR_STRUCTURED = 0.86.0`（单点定义，peer/CI/提示文案同源）
  - `host.ts` 宿主能力探测（按字段存在性判定，不猜版本）+ `InjectionHost` 契约
  - `clock.ts` 时间锚点（日期 / 时刻 / 时段，四个派生事实一次算齐）
  - `facts.ts` tool 结果回流（只采集自家前缀 + 摘要截断 + 可选「成功计数」tool）
  - `router.ts` 场景路由机械（信号按优先级遍历 + 低信息量粘性，可自定义语气词表）
  - `fragments.ts` 状态驱动片段（`when` 谓词求值 + `text` 可插真实数字）
  - `layers.ts` 分层装配（按变化频率分段；空正文的层不进结果——缺失比空串正确）
  - `prune.ts` tool 足迹裁剪（只裁文本，不动可调用工具集）
  - `bytes.ts` 预算度量原语（字节 / 行数 / 与 pi `formatSkillsForPrompt` 对齐的 skill 条目 XML）
  - `runtime.ts` 一轮编排 `createInjectionRuntime(spec, state)`：宿主探测 → 状态收敛 →
    **先全部构造再统一落地** → 装配失败降级；并统一订阅 `session_start`（会话事实清零）、
    `tool_execution_end`（结果回流）、`before_agent_start`
- `test/injection.test.ts`（17 例）：内核各件单测 + 最小扩展端到端（分层注入 / 状态变了注入就变 /
  场景粘性 / 足迹裁剪 / 结果回流 / session 清零 / 旧宿主跳过+只提示一次 / 降级不留半成品），
  外加一条**自洽守卫**：内核目录里任何一个 `.ts` 都不许 import 内核之外的东西
  ——否则「整目录复制到别的扩展」这个前提会悄悄失效。

### Changed

- `src/role-mode.ts` 从「自己实现一轮编排」改为**只填领域插槽**（`buildState` / `build` /
  `runtimeSections` / `fallback`），机械交给 `createInjectionRuntime`；`RoleState` 继承内核的
  `RuntimeState`（会话事实 / 上一场景 / 提示标记 / 降级标记）。
- `src/sop.ts` / `src/scene.ts` / `src/prompt-state.ts` / `src/role.ts` / `src/context-budget.ts`
  改为复用内核（`Fragment` / `createRouter` / `timeAnchor` / `assembleLayers` / 字节原语），
  **对外导出与注入内容完全不变**（`docs/context-budget.json` 无需重新生成即通过 `context:check`）。
- `scripts/dev/host-harness.mjs` 参数化（`root` / `configEnv` / `configFile` / `expectedTools`），
  别的扩展可直接复用这套「真 loader + 真 runner + 离线派发」验证。

## [0.5.0] - 2026-10-03

### Added

- **分层注入 + 场景路由（助理模式重做）**：`before_agent_start` 用用户本轮原话判场景
  （`src/scene.ts`，优先级 setup > train > recall > log > chat，低信息量消息继承上一场景），
  只注入该场景需要的内容，而不是把一整本说明书常驻在提示词里：
  - 恒定层 `pition_core`（库名 + 工具索引 + 3 条硬边界）
  - 场景层 `pition_scene`（`src/sop.ts` 的剧本片段：记录 / 锻炼 / 回看 / 配置）
  - 事实层 `pition_fields`（**当前库字段字典**：字段名 + 类型 + append 语义 + 用户填的字段说明）
  - 易变层 `pition_runtime`（见下）
  - 全局 guideline 从 14 条收敛到 3 条，其余下沉到场景片段与 skill
- **状态驱动的动态提示词（SOP 片段化）**：场景剧本从「固定长文」改成**带条件的片段**——
  注入内容 = f(本轮真实状态)。修掉「提示词很容易变得静态」的根因：
  - 没有今日目标时才教「怎么定计划」；目标在跑时改为给「下一项是什么」（带真实数字，
    如「下一项是『俯卧撑』（2/4 轮）」）；断更 ≥2 天才出现自检查片段；全部达标才出现庆祝片段
  - `setup` 按配置进度只给当下那一步（没 token → 补 token；有库未补说明 → 补说明；
    全齐 → 只说「已完整，别重走流程」）
  - `log` 只在上一轮 `pition_write` 真的报过「没有 page」时才提逃生口；
    本会话已写入过才提示「同一条不要重复落库」
- **易变层 `sections.pition_runtime`**：每轮注入「现在：2026年10月3日 周六 22:21 · 晚上
  （日期/时刻一律以此为准，不要自己推算）」+ 本会话已写入条数 + 上一轮 tool 的失败/警告回流。
  单独成段是为了保护 cache：它每轮都 diff，不跟场景 SOP 挤在同一个 section 里。
- **tool 结果回流闭环**（新订阅 `tool_execution_end`）：pition tool 的失败/警告被采集进 `SessionFacts`，
  下一轮提示词带出（模型经常忽略 tool 结果里的 WARNING）；`session_start` 时清零。
- `src/prompt-state.ts`：本轮状态快照（时刻/时段/目标/字段覆盖/会话事实），纯函数、`now` 可注入。
- **字段说明终于进入模型视野**：此前 `fields[].description` 只被用于算覆盖率（等于死数据），
  agent 想写属性必须多一次往返去猜字段名。现在按场景注入 `pition_fields`（确定性排序 + 预算截断）。
- **注入预算台账 + 门禁**（对齐 `pi-dynamic-workflows` 的 `context:check` 做法）：
  `src/context-budget.ts` 度量常驻注入面（全局 guideline / tool guideline / tool definition /
  skill 发现条目 / 各场景 section + 裁剪效果），产物 `docs/context-budget.json`；
  `npm run context:check` 已并入 `npm run check`，超上限即失败——逼细节回到 on-demand skill。
  台账覆盖 **15 个「场景 × 状态」组合**（unconfigured / ready / ready+goal），并记录每个组合
  **实际出现的片段 id**——能回答「这段为什么出现」；易变层另有 `runtimeBytes` 上限。
- **每个 tool 补 `promptSnippet`**：此前 7 个 tool 都不进 pi 的 tools 层「Available tools」索引，
  模型只能靠 schema 猜工具用途。
- 新增第 3 个场景 skill `pition-setup`（配置与绑定：5 阶段流程、字段说明怎么写、换库不丢说明、卡点排查）。
- **真宿主注入校验**（`test/host-injection.test.ts` + `scripts/dev/host-harness.mjs`）：不再只靠「假 pi」验证注入——
  用真实 pi 的 `discoverAndLoadExtensions` + `ExtensionRunner` 跑 `before_agent_start`，断言
  ① 我写入的 sections / tool guideline 裁剪经宿主真实归一化与合并后**真的生效**；
  ② 同一状态连续两轮 options 深度相同（＝ section diff 为空 ＝ 稳定层真的不刷 cache）；
  ③ `session_start` / `tool_execution_end` 走真实派发路径。
- **宿主能力探测 + 降级**：pi < 0.86 没有 `sections` / `toolGuidelines`，此前会每轮抛 TypeError
  并被 pi 的错误边界吃掉——表现为**静默零注入**（不报错、功能全无）。现在整体跳过结构化注入并提示一次；
  装配/渲染异常时降级为最小 `pition_core`（而不是整轮消失），且**先构造后落地**，不留「部分注入」的半成品。
- **排障命令** `node scripts/dev/diag-injection.mjs "记一下今天吃了火锅"`：打印真实宿主这一轮注入的
  section（含字节数）、被裁/保留的 tool guideline；`--config` 走用户配置的**副本**（诊断绝不动真配置）。
- **CI**：floor 兼容档的 pi 版本改为从 `package.json` 的 `peerDependencies` 读取（消除两处漂移），
  并在该档加跑一次真实宿主装配。

### Changed

- **peer 下界修正 `>=0.80.5` → `>=0.86.0`**（实测取证：pi 0.85 的 `BuildSystemPromptOptions` 无 `sections` /
  `toolGuidelines`，0.86 起才有）。原声明会让 0.80–0.85 的用户以为能用，实际是静默零注入。
- 新增 `engines.node: ">=22.19.0"`，与宿主 pi 的引擎要求对齐。
- **tool 的 `promptGuidelines` 按场景裁剪**（`role.ts#pruneToolGuidelines`）：只把不相关 tool 的
  guideline 文本置空，**工具集本身从不改变**（不做能力门禁——注册期/激活期门禁会让 agent
  需要时无路可走）。
- tool `promptGuidelines` 收敛到每个 1-3 条（工具自身机理），场景化用法移入 `src/sop.ts`；
  tool `description` 瘦身（去掉与参数说明/SOP 重复的散文）。
- 有 token 但未选库时也会注入 `pition_core`（带「去配置」指路）——此前未绑定库等于零注入。
- `/pition-mode` 文案更新为「按场景注入助手定位与本场景剧本」。

### Fixed

- 修正多处「要看当前库字段说明先调 `pition_boot stage=done`」的过时指引
  （`stage=done` 只给覆盖率，不给字段名）——统一改为指向注入的 `pition_fields` 段。
- 提示词里给出现在日期与时刻并要求以此为准，消除模型自己推算日期导致的
  「set 带未来日期 / 认错今天」（0.3.1 修过同类线上实症）。
- 宿主 API 变化不再导致「每轮静默零注入」：能力探测 + 一次性提示 + 降级兜底（见 Added）。

## [0.4.1] - 2026-10-01

### Changed

- **进度推进契约调整：goal 优先，span 降为扩展机制**。做组/次数/时长型目标（俯卧撑 N 组、静蹲 N 秒）与时间无关 → 直接 `pition_goal action=progress`（秒级、零开销）；span 只用于**需计时的长任务**（跑步/散步/球类），end 带 goalItemName/goalDelta 一次完成收尾+推进。同步改：助理模式注入（role.ts）、pition_goal promptGuidelines、pition-goal-coach skill。
- 助理模式注入新增 skill 使用指引：场景命中时**先读 skill 再行动**（pition-goal-coach / pition-daily-log），skill 优先于凭记忆。

## [0.4.0] - 2026-10-01

### Added

- **内置 2 个场景 skill（SOP）**，pi 原生 `pi.skills` 机制分发（装包即有、随包升级自动更新、零代码）：
  - `pition-goal-coach`：锻炼目标场景剧本——对话式收集→可量化方案→set（不传 date）→span 联动推进→进度汇报→断更自检查
  - `pition-daily-log`：日常记录剧本——触发判断、工具选择决策树（write/span/create_today/history）、属性看板思维、时间戳语义、写入后动作
- skill 按 description 路由按需读取（不占常驻 token）；`/skill:pition-goal-coach` 可显式调用。

## [0.3.1] - 2026-10-01

### Fixed

- **`pition_goal` set 拒绝未来日期**（线上实症：凌晨对话模型算错今天日期，set 带了未来的 `date`——goal 落盘到未来，而 list/注入只渲染今天，表现为「每日目标设完 1 分钟后消失」）。set 时即报错并提示今天日期，不落不可见毒丸。
- `list` 为空时自诊断：附插件内现存 goal 的 date 分区（「若有目标但日期不是今天，说明 set 时 date 传错了」），agent 可直接引导修复。

## [0.3.0] - 2026-10-01

### Added

- **`pition_goal`：每日目标 tool（第 7 个 tool，完整 CRUD + 进度控制）**。
  可量化条目列表（俯卧撑 4 轮）、5 个 action（set/progress/list/update/delete）、
  进度三模式（delta 加法默认 1 / value 绝对值 / reset 归零）、自动周期（daily 或 5 段 cron，跨天自动归零重开无需人工重置）、
  绑定字段看板展示（进度摘要覆写，✅ 全达标前缀，可选投影——冷设置/无 page/写入失败不影响 goal 本体）、
  未配置 Notion 全功能可用（冷设置，进度存插件内部 `_activeGoals`）。
  需求与决策记录：`docs/goal-requirements.md`。
- **span 秒级精度**：`[14:32:15-14:33:02 持续 47 秒]`（原分钟粒度）；span 注入文案同步秒级（「已 47 秒」）。适配单轮 <1 分钟的训练场景。
- **span end 联动 goal**：`pition_span action=end` 新增可选 `goalItemName`/`goalDelta`——收尾 span 同时推进今日目标条目（数字加法；end 不结束 goal）；联动失败不影响 span 落盘。
- **goal 动态自检查**：连续 ≥2 天零活动的周期目标，注入时附「⚠️ 已连续 N 天未执行——询问用户是否调整」；全部达标后指引回看本月完成情况（pition_history）。
- `pition_goal` 进度每次对话注入全局提示词 `pition_goal` section（实际数字，自动物化跨天实例并落盘）。

### Fixed

- `/pition-mode` 切换重建配置时丢失 `_activeSpans`/`_activeGoals`（改展开保留全部字段）。

### Changed

- `formatSpanRange` 输出秒级时钟；`formatElapsed`（新导出）渲染「47 秒 / 3 分 20 秒 / 1 时 5 分」。

## [0.2.3] - 2026-09-30

### Fixed

- **npm 重装/升级后 Notion 配置丢失**。根因：配置定位在包根（node_modules 内），`pi install` 重装即清空。
  修复：配置持久化家改为 **pi agent 目录** `<agent-dir>/extensions/pition.config.json`（默认 `~/.pi/agent/extensions/`，`PI_CODING_AGENT_DIR` 可覆盖）——包外位置，重装/升级不再丢；容器场景只挂载 pi agent 目录即可。存量 node_modules 内的配置在首次加载时自动迁移（幂等；迁移失败仍用旧路径）。仓库开发模式与 `install.mjs` 物化形态的定位不变（扩展目录向上查找优先）。
  设计对齐：pi-tasks（配置落 `<agent-dir>` + 写前 `mkdirSync`）、pi-fabric（`src/core/agent-dir.ts` 本地镜像 `getAgentDir` 的先例，含 `~` 展开规则）。

### Changed

- `scripts/install.mjs` 默认 agent 目录改为 `~/.pi/agent`（与 pi 官方约定一致）；`scripts/dev/install-all.mjs` 移除额外的沙箱目录分支。
- README 安装节补「配置存哪、为什么升级不丢」；SECURITY.md 敏感数据表更新配置位置。

## [0.2.2] - 2026-09-30

### Fixed

- **`pition_write` / `pition_create_today` 的 `details.timestamp` 与 `pition_span` 的 `startedAt` 跟本地 `[HH:MM]` 差 8 小时**。
  根因是 `Date.toISOString()` 永远输出 UTC（带 `Z`），跟本地化的 `[HH:MM]` 前缀直接比对就错位（典型：北京时区晚 8h）。
  修复：新增 `src/time.ts#toLocalIsoString(when)`，输出 `YYYY-MM-DDTHH:MM:SS.sss±HH:MM`（保留本地时区偏移）；三处 `toISOString()` 全部替换为该函数。

## [0.2.1] - 2026-09-29

### Added

- **质量门全绿**：`npm run check` = biome lint + `tsc --noEmit` + jiti 冒烟，三者均为 0 失败；CI 与 `prepublishOnly` 走同一套。
- `detail()` 统一 details 出口（`Record<string, unknown>`），消除 pi `registerTool` 的 union 类型推导爆炸。
- README 重写：安装改以 `pi install npm:@flowot/pi-pition` 为主，补 6 tool 全表、属性 append 语义矩阵、`pition_span` 区间事件说明。

### Fixed

- `/pition` 向导与 `/pition-mode` 残留的旧 `bindings: []` 数组形态 → `Record<dbId, Binding>` + `currentBindingId`。
- 删除死代码 `fieldsDoc`（字段说明已改由 `pition_boot stage=done` 提供）。
- biome 配置排除 `pition.config.json`（本地 token 文件不应被格式化器改写）。

## [0.2.0] - 2026-09-29

### Changed

- **工程重构（外科手术）**：7 个开发期脚本（diag-* / wizard-check / boot-set-mode-check / install-all / e2e-agent）移入 `scripts/dev/`（不进 npm 发布包）；根目录只留 `install.mjs` 与 `smoke-load.mjs`。
- 新增工程规范文件：`biome.json`、`tsconfig.json`（typecheck 用）、`AGENTS.md`（AI 协作规范）、`CHANGELOG.md`、`LICENSE`、`.npmignore`。

## [0.1.2] - 2026-09-29

### Fixed

- **运行态 tool 全部无条件注册**：去掉工厂期 cfg 门禁。此前会话中现配的库看不到 `pition_write` / `pition_read` / `pition_span` 等 tool（必须 /reload）；现在未绑定库时由 `currentBinding()` 在 execute 首行抛错并指引去 `pition_boot stage=select_db`。

## [0.1.1] - 2026-09-29

### Fixed

- npm 包名从 `pition` 改为 `@flowot/pi-pition`（原名被 npm 反钓鱼拦截）。
- release workflow 的 npm 鉴权改写 `~/.npmrc`（新版 npm 不读 `NODE_AUTH_TOKEN`）。

## [0.1.0] - 2026-09-29

### Added

- 首次发布：`pition_boot`（5 阶段引导）、`pition_write`（主路径）、`pition_read`、`pition_history`、`pition_create_today`（逃生口）、`pition_span`（区间事件 + 全局提示词注入）、`/pition` 向导、`/pition-mode` 助理模式开关。
- CI：jiti 加载冒烟 + pi floor/latest 兼容矩阵；Release：tag 驱动 npm publish（provenance）。
