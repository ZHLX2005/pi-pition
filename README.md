# pition — Notion 个人记录助手（pi 扩展）

把 Notion 数据库变成 pi agent 的持久化存储。agent 通过 7 个 tool 识别对话中的记录内容，自动理解后写入你绑定的 Notion 库——**日常记录默认写到当前 page**（`pition_write` 自动追加/合并属性，按 `appendContent` 写正文），不重复建行。

不做 MCP。单用户固定 token + 自有库 + 定制 tool 语义，原生 pi 扩展更轻。

## 快速开始

```bash
# 1. 装包
pi install npm:@flowot/pi-pition

# 2. 在 pi TUI 里跑配置向导（填 token → 选库 → 补字段说明）
/pition

# 3. 直接用自然语言记东西
> 今天上午跑了 5 公里，中午点了外卖 35 元
# → agent 调 pition_write，属性按类型合并（标签 union、金额累加），正文追加到当前 page
```

配置完成后 7 个 tool 立即可用，无需重启。

### 内置 skill（场景 SOP）

包自带 3 个场景 skill（pi 原生 `pi.skills` 机制分发，装包即有，随包升级自动更新）：

| skill | 触发场景 |
|---|---|
| `pition-daily-log` | 日常记录：记一笔/打卡/吃了/花了/心情/感悟——何时记、写属性还是正文、用哪个 tool |
| `pition-goal-coach` | 锻炼/健身目标：定计划、训练中推进（「开始第2轮」「结束」）、问完成度、断更调整 |
| `pition-setup` | 配置与绑定：首次配置、换库/切空间、补字段说明、助理模式、工具不出现的排查 |

skill 按 description 路由：只有任务匹配时模型才读取全文，不占常驻 token。显式调用：`/skill:pition-goal-coach`。

### 助理模式怎么「看场景」注入（v0.5.0）

开启助理模式（`/pition-mode` 或 `pition_boot stage=set_mode`）后，扩展在每轮请求前用**你的原话**判场景、
再用**当前真实状态**装配内容——只注入此刻成立的部分，而不是把一整本说明书常驻在提示词里：

| 层 | 注入段 | 内容 | 何时出现 |
|---|---|---|---|
| 恒定 | `pition_core` | 库名 + 工具索引 + 3 条硬边界 | 助理模式开就注入 |
| 场景 | `pition_scene` | **按状态装配**的剧本片段（记录 / 锻炼 / 回看 / 配置） | 场景 ≠ 闲聊 |
| 事实 | `pition_fields` | **当前库字段字典**（字段名 + 类型 + append 语义 + 你的字段说明） | 需要写属性时 |
| 易变 | `pition_runtime` | 现在几点、本会话已写入几条、上一轮工具是否失败 | 助理模式开就注入 |
| 运行时 | `pition_span` / `pition_goal` | 进行中事件与已过时长、今日目标进度 | 有数据即注入 |

「按状态装配」是什么意思——同一个锻炼场景，注入的剧本不一样：

| 状态 | 注入的片段 |
|---|---|
| 今天还没定目标 | 「先一轮问完身体情况与倾向，给可量化方案，认可才 set；不传 date」 |
| 目标已在跑 | 「下一项是『俯卧撑』（2/4 轮）→ 报完成就 progress，复述进度 + 鼓励 + 报下一项」 |
| 断更 ≥2 天 | 追加「主动问要不要调轻（update 降 target / 改或清周期），不说教」 |
| 全部达标 | 改为「庆祝 + 帮写当日小结」 |

- 场景有**粘性**：说了「我想练腹肌」之后接一句「好」，仍按锻炼场景处理
- **上一轮的结果会回流**：`pition_write` 报过「没有 page」，下一轮才会出现「改用逃生口建 page」的提示
- 注入里带上了**现在的日期与时刻**（并要求以此为准），模型不再自己推算日期
- 换库后字段字典立即跟着换——你填的字段说明终于直接进入模型视野（此前只用于算覆盖率）
- tool 的 `promptGuidelines` 按场景裁剪（省常驻 token），但**工具本身始终可调用**：不做能力门禁
- 常驻注入有预算门禁（`npm run context:check` 对 `docs/context-budget.json`），防止提示词悄悄膨胀

## 安装

```bash
pi install npm:@flowot/pi-pition
```

装完在 pi TUI 里跑 `/pition` 走配置向导（或让 agent 调 `pition_boot`），配完立即可用。

> 要求 **pi ≥ 0.86**（分层注入依赖 0.86 起的 `sections` 能力）。装在更低版本上时 pition 的
> **工具照常可用**，但助理模式的分层注入会跳过并提示升级一次——不会静默失效。

### 配置存哪、为什么升级不丢

配置持久化在 **pi agent 目录**的 `extensions/pition.config.json`（默认 `~/.pi/agent/extensions/`，`PI_CODING_AGENT_DIR` 可覆盖）——在 npm 包外，重装/升级 `pi install npm:@flowot/pi-pition` 不会清掉；容器/服务器场景只挂载 pi agent 目录即可带上配置。旧版本存在包内（node_modules）的配置会在首次加载时自动迁移到上述位置。开发仓库 / `install.mjs` 物化形态下配置仍在原处（扩展目录向上查找优先）。

开发 / 源码方式：

```bash
git clone https://github.com/ZHLX2005/pi-pition.git
cd pi-pition && npm install
# pi 直接加载源码目录：
#   ~/.pi/agent/settings.json 的 packages 加 "D:/path/to/pi-pition"
```

## Tool 一览

| tool | 用途 |
|---|---|
| `pition_boot` | **元工具**：5 阶段渐进式配置（token → 选库 → 补字段说明 → 助理模式开关 → done），切空间也走它 |
| `pition_write` | **日常主路径**：把属性修改/正文追加写到当前 page（属性默认 append 合并；返回里附 todaySoFar 整页预览） |
| `pition_read` | 读当前 page 完整内容（properties + 所有正文 block） |
| `pition_history` | 翻旧账查 page 列表（带单字段过滤）；日常不调 |
| `pition_create_today` | **逃生口**：定时任务挂了自己手动建 page（默认不调） |
| `pition_span` | **区间事件**：`start` / `end`（跑步、开会、午休）；支持**并行多个**，秒级时长，结束才落 Notion，进行中持续注入全局提示词；`end` 可带 `goalItemName`/`goalDelta` 自动推进今日目标 |
| `pition_goal` | **每日目标**：完整 CRUD + 进度控制（可量化条目列表，如 俯卧撑 4 轮）；进度每次对话自动注入；自动周期 daily/cron 跨天自动归零重开；可绑 Notion 字段做看板展示；未配置 Notion 也可用（冷设置） |

所有运行态 tool **无条件注册**——没绑定库时调用会得到清晰错误，指引 agent 去走 `pition_boot`。

**每个 tool 的完整参数语义见 [`docs/tools.md`](docs/tools.md)；场景级使用 SOP 见包内 `skills/`（`pition-daily-log` / `pition-goal-coach` / `pition-setup`）。**

### `pition_boot` 5 阶段契约

```ts
// 阶段 1：登录落盘 token
{ stage: "token", token: "ntn_..." }
// 阶段 2：列库 / 切空间（选定后设为当前库；之前库的字段 desc 按 dbId 永久保留）
{ stage: "select_db" }                       // 列库
{ stage: "select_db", dbId: "<id>" }         // 直接接管 + 切换
// 阶段 3：提交字段说明（一次性 array，agent 自动化友好）
{ stage: "describe_fields", dbId: "<id>",
  fieldDescriptions: [
    { name: "Name", description: "记录标题，一般是当天日期" },
    { name: "基础", description: "当日核心事项摘要" },
  ],
  bindingDescription: "个人日常记录总表" }
// 阶段 4：切换助理模式（落盘，重启 pi 保留；等价 /pition-mode）
{ stage: "set_mode", enabled: true }
// 阶段 5：查询当前状态
{ stage: "done" }
```

任意阶段可中断；用户只改某一阶段时直接调对应 stage，不必从 `token` 重走。boot 工具的描述里直接拼了当前状态（token / 库 / 字段覆盖率 / 助理模式），agent 一眼可查。

## 属性 append 语义（看板友好）

`pition_write` 的 `properties: [{name, value}]` **默认按字段类型 append 合并**：

| 类型 | 默认（append） | `overwrite: true` |
|---|---|---|
| multi_select | union 选项名（去重） | 替换 |
| rich_text | 拼接 `原值 / 新值` | 替换 |
| number | 累加 | 替换 |
| date | 取更早 | 替换 |
| checkbox | 取 OR | 替换 |
| title / select / status / url / email / phone_number | 永远用新值（单值字段） | — |

例：「运动 30 分钟 + 午餐 35 元」→ 一次调用写 `properties: [{name:"标签", value:"运动,饮食"}, {name:"金额", value:35}]`——标签 union、金额累加，Notion 看板直接按维度统计。

## 区间事件（`pition_span`）

```ts
pition_span({ action: "start", eventName: "跑步", note: "公园 5 公里" })
// → 落盘到 cfg._activeSpans；此后每次模型请求前全局提示词自动注入：
//   「📍 进行中 1 件事：
//     - 跑步（公园 5 公里），已 28 分钟（14:32 开始）」

pition_span({ action: "end", eventName: "跑步", summary: "感觉很好" })
// → 当前 page 追加一段：[14:32-15:00 持续 28 分钟] 跑步（公园 5 公里）— 感觉很好
```

**可以并行多个事件**（边养神边听歌是真实生活）——`_activeSpans` 是数组。
**不需要心跳**：累计时长由 `startedAt` 现算，每次对话自动更新，跨轮次自动增长。
结束时若有多个进行中事件，必须传 `eventName` 指定收尾哪个（否则报错列出全部候选）。

跨重启保留；agent reload 也能记得「还在跑步」。

## 简单值约定

agent 只填简单值，扩展负责转 Notion API 格式：

| Notion 类型 | agent 传 | 例 |
|---|---|---|
| title / rich_text / url / email | 字符串 | `"开会记录"` |
| number | 数字 | `3` |
| select | 选项名（不存在会自动创建） | `"工作"` |
| multi_select | 逗号分隔选项名 | `"运动, 阅读"` |
| checkbox | 布尔 | `true` |
| date | `YYYY-MM-DD` 或 ISO | `"2026-09-28"` |
| status | 状态名 | `"Done"` |

formula / relation / rollup 等计算类字段不可写，不要放进配置。

## 配置

配置**不需要手编 JSON**——pi TUI 跑 `/pition` 四步向导（token → 选库 → 看结构 → 补说明），或让 agent 驱动 `pition_boot`。手编场景（批量迁移）参考 `pition.config.example.json`：

```jsonc
{
  "token": "ntn_...",
  "bindings": {                       // 按 dbId 索引；切空间不丢字段 desc
    "<dbId>": {
      "dbId": "<dbId>",
      "title": "pition",
      "description": "个人日常记录总表",
      "fields": {
        "Name":  { "type": "title", "description": "记录标题" },
        "基础":  { "type": "rich_text", "description": "当日核心事项摘要" },
        "复杂":  { "type": "select", "description": "记录类别标签" }
      }
    }
  },
  "currentBindingId": "<dbId>",       // 当前激活库
  "_assistantMode": false             // 助理模式开关（等价 /pition-mode）
}
```

## token 安全

- `pition.config.json` 含明文 token，**不要提交进 git**（本仓库 `.gitignore` 已屏蔽；`pition.config.example.json` 是空 token 模板）
- token 只在本机被 pi 进程读取，向导不向任何第三方上传
- 换库 / 换 token / 看状态 → `pition_boot stage=done`

## 物化安装（可选，装到 pi agent 目录）

`node scripts/install.mjs` 把 `extensions/pition.ts` + 配置复制到 `<pi-agent-dir>/extensions/`（默认 `~/.pi/agent`，`--agent-dir` 可指定）；一般 npm 安装用户不需要。

## 开发

```bash
npm run check        # 五门：lint → typecheck → test → context:check → smoke（prepublishOnly 同款）
npm test             # vitest（单元 + 集成）
npm run context:generate            # 刷新注入预算台账（docs/context-budget.json）
node scripts/dev/diag-session.mjs   # SDK 会话装配诊断（需先 npm install）
```

目录结构、硬约束（含注入分层与预算门禁）、加新 tool 的流程见 `CONTRIBUTING.md`；
「模型看到什么」的架构图见 `AGENTS.md` 的「注入架构」节与 `.claude/skills/pition-dev/references/C01-上下文多层结构.md`。

## 复用：用 pition 的注入内核造你自己的扩展

`src/injection/` 是**与 pition 领域无关**的注入机械（宿主探测、分层装配、状态驱动片段、
场景路由、tool 结果回流、足迹裁剪、字节度量、一轮编排），**整个目录复制即可复用**。

### 一条命令起步（推荐）

```sh
node <pition>/scripts/new-extension.mjs ~/code/my-ext --name my-ext
cd ~/code/my-ext && npm install && npm test   # 生成的 4 条自检应先全绿
```

它把 `src/injection/` **逐字节复制**过去，并生成一份能跑的骨架（`package.json` / `tsconfig.json` /
`index.ts` / `extensions/<name>.ts` / `src/state.ts` / `src/scenes.ts` / `src/spec.ts` /
`test/injection.test.ts` / `README.md`）——连 pi 版本下界都从内核的 `version.ts` 读，
不会手抄错成旧版本（那是最难查的故障：装上后**零注入且不报错**）。

想手工接管也一样：

```sh
cp -r <pition>/src/injection  <你的扩展>/src/injection
```

然后只需填领域插槽（`InjectionSpec`）：`route` / `buildState` / `build` / `fallback`，
再 `createInjectionRuntime(spec, state).attach(pi)` 一行接上 pi。

- 教程（三步 + 最小骨架 + 换领域时最容易犯的错）：`src/injection/README.md`
- 可照抄的现成例子：`test/injection.test.ts` 的「最小扩展（snip）」一节（16 条断言，全绿）
- 真宿主验证工具：`scripts/dev/host-harness.mjs`（已参数化，换 `root`/`configEnv` 即可复用）

这些纪律都是踩坑踩出来的，照做能避开最难查的一类故障（旧宿主上**静默零注入**：不报错、功能全无）。

发布：bump `package.json` version → 写 `CHANGELOG.md` → `git tag vX.Y.Z && git push origin vX.Y.Z`，GitHub Actions 自动 smoke → npm publish（provenance）→ GitHub Release。

## License

MIT
