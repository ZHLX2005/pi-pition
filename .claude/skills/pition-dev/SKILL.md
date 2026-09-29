---
name: pition-dev
description: pition 项目（Notion 个人记录助手，pi coding agent 扩展）的开发与排障指南。当在本项目新增/修改 tool、调整配置格式、改字段 description、排查扩展不加载或工具不出现、安装部署、跑 E2E 验证时使用。含 pi 加载链路（本项目实证）、排查阶梯、高频坑与验证工作流。
---

# pition 开发指南

pition 把 Notion 数据库变成 pi agent 的持久化存储：agent 通过 6 个 tool 识别对话中的记录内容并自动写入。不依赖 nx-as 源码，自包含成包，通过 `~/.pi/agent/settings.json` 的 `packages` 声明或 `install.mjs` 物化两种方式安装。

## Tool 一览

| tool | 用途 | 要点 |
| --- | --- | --- |
| `pition_boot` | **元工具**：5 阶段渐进式配置（token → 选库 → 补字段说明 → 助理模式开关 → done） | 引导态统一入口；任意阶段可中断；agent 自动化时一次性提交 `fieldDescriptions` 替代逐字段 TUI 输入；助理模式开关走落盘（等价 /pition-mode 命令）。详见 [[A01-设计理念]] |
| `pition_write` | **日常主路径**：改当前 page 属性 + 追加正文 | 属性默认 append 合并（multi_select union / number 累加 / rich_text 拼接 / date 取更早 / checkbox 取 OR）；`overwrite: true` 显式覆盖；返回 todaySoFar 整页预览 |
| `pition_read` | 读当前 page 完整内容 | properties + 所有正文 block |
| `pition_history` | 翻旧账查 page 列表 | 带单字段 filter；日常不调 |
| `pition_create_today` | 逃生口：手动建 page | 默认不调——page 由 Notion 定时任务管，returned warning 时才用 |
| `pition_span` | **区间事件** start/heartbeat/end | start 仅落 cfg._activeSpans（支持并行多事件）；end 才把 `[HH:MM-HH:MM 持续 N 分钟]` 写入当前 page；进行中由 before_agent_start 注入 `sections.pition_span` |

### `pition_boot` 调用契约

```ts
// 阶段 1：登录落盘 token（两阶段提交：先只写 token + 空 bindings）
{ stage: "token", token: "ntn_..." }

// 阶段 2：列库让用户/agent 选
{ stage: "select_db" }                          // → 返回库列表

// 阶段 3：提交字段说明（一次性 array，替代 TUI 逐字段 ui.input）
{ stage: "describe_fields", dbId: "<id>",
  fieldDescriptions: [
    { name: "Name", description: "记录标题，一般是当天日期" },
    { name: "基础", description: "当日核心事项摘要" },
  ],
  bindingDescription: "个人日常记录总表",
  bindingTitle: "pition" }

// 阶段 4：查询当前绑定状态（可指定 dbId 查单库覆盖率）
{ stage: "done" }                               // → 整体状态
{ stage: "done", dbId: "<id>" }                 // → 单库字段覆盖率

// 阶段 5：切换助理模式（落盘，重启 pi 保留；等价于 /pition-mode 命令）
{ stage: "set_mode" }                            // → toggle
{ stage: "set_mode", enabled: true }             // → 强制开
{ stage: "set_mode", enabled: false }            // → 强制关
```

**渐进式回访**：用户只改某一阶段产物时直接调对应 stage，不必从 `token` 重走。

**助理模式落盘**：`_assistantMode` 字段写入 `pition.config.json`，缺省 `false`。`stage=done` 返回里 `assistantMode` 反映当前持久化状态；`/pition-mode` 命令和 `stage=set_mode` 共享同一份 cfg，互为等价入口。

## 工程结构

```
pition/
├── index.ts               # 包入口（pi 包形式加载认包根 index.ts）
├── extensions/
│   └── pition.ts          # 扩展实现：loadConfig + /pition 向导 + 6 个 registerTool
├── pition.config.json     # 配置：token / bindings / 字段 description（数据与代码分离）
├── install.mjs            # 物化到 <agent-dir>/extensions/（nx-as 形态）
├── smoke-load.mjs         # jiti 冒烟（fake pi 数注册的 tool + 命令）
├── diag-loader.mjs        # SDK 诊断：DefaultResourceLoader 解析结果
├── diag-session.mjs       # SDK 诊断：完整会话装配后 session 工具清单
├── diag-command.mjs       # SDK 诊断：命令是否注册
├── wizard-check.mjs       # 向导 Notion 侧逻辑验证（列表库/取 schema/过滤可写字段）
└── e2e-agent.mjs          # 真模型 E2E（SDK 形态）
```

## 配置入口：`/pition` 向导

配置**不需要手编 JSON**。在 pi TUI 里跑 `/pition`，四步交互完成：填 token（实时校验+显示工作区）→ 选库（列出全部可访问库及字段数）→ 看结构（只列可写字段，计算类自动过滤）→ 逐字段补说明。保存后 `ctx.reload()` 热重载，无需重启。

> 📎 本节是 `/pition` 当前实现快照；**产品理念、boot 元工具 4 阶段契约、为什么是"引导态+运行态"双形态** 详见 [[A01-设计理念]]。改向导或新增元 tool 前必看。

实现要点：

- **命令必须无条件注册**（在 `loadConfig()` 之前调 `registerSetupCommand(pi)`）——否则没配置时进不去向导，形成死锁
- 向导用 `ctx.ui.input/select/confirm/notify`；`ctx.hasUI` 为假（`pi -p` 打印模式）时提示改用 TUI
- 向导写配置用 `notionWith(token, ...)`（接受未保存的 token 试连），tools 用 `notion(cfg, ...)`
- 中途取消（`ui.input` 返回 undefined）→ 整次不保存，不留半成品配置
- `isolation`：可写字段白名单 `WRITABLE_TYPES`，与 `toNotionProperty` 支持的集合保持一致

⚠️ `pi -p "/pition"` **不会**触发命令——打印模式把斜杠文本当普通消息发给模型。验证命令注册用 `diag-command.mjs`，实际交互必须在 TUI。

## pi 加载链路（本项目实证，机制出自 pi v0.87.1 源码）

```
pi 启动
 └─ 读 <agent-dir>/settings.json 的 packages: [路径]
     └─ 目录形式 → resolveExtensionEntries() 优先认包根 index.ts → 视为单一扩展
         └─ jiti 加载 index.ts → re-export ./extensions/pition.ts（.ts 后缀！）
             └─ 执行工厂 → loadConfig() 两级查找（extensions/ → 包根）
                 └─ 6 个 tool 全部【无条件】注册（无工厂期门禁）
                     └─ 任一环节静默失败 = 0 工具、0 报错
```

关键机制：

- **jiti 虚拟模块**：`typebox`、`@earendil-works/pi-coding-agent` 由 pi 注入 alias，扩展不需要本地 node_modules
- **index.ts 遮蔽效应**：包根有 index.ts 后 `extensions/` 子目录自动扫描失效——本项目走单一入口形态，勿再放裸扩展文件到包根
- **配置两级查找**（`loadConfig`）：扩展文件在 `extensions/`，配置在包根，逐级向上试

## 配置格式（pition.config.json）

```jsonc
{
  "token": "ntn_...",                  // Notion integration token（库需先"连接"该 integration）
  "bindings": {                         // 单库产品形态 + 历史保留：所有已描述过的库按 dbId 存
    "32位库id": {                        // 切空间时之前库的字段 desc 不会丢
      "dbId": "32位库id",
      "title": "agent 看到的存储名",
      "description": "库用途说明（启动时注入到运行态 tool 的 description 里）",
      "fields": {
        "字段名": { "type": "title|rich_text|number|select|multi_select|status|checkbox|date|url|email|phone_number",
                    "description": "给 agent 的字段语义说明——产品核心，写得越具体 agent 写得越准" }
      }
    }
  },
  "currentBindingId": "32位库id",        // 当前默认操作的库（agent 日常 tool 都用这个）
  "_assistantMode": false,               // 可选：助理模式开关（pition_boot stage=set_mode 或 /pition-mode 切换）
  "_activeSpans": []                     // 可选：进行中的区间事件数组（pition_span start 写入，end 移除）
}
```

- formula / relation / rollup 等计算字段不可写，勿入配置
- 简单值约定：LLM 只填标量，`toNotionProperty()` 负责转 Notion API 格式（`2022-06-28`）
- **属性 append 语义（pition_write）**：`properties: [{name, value}]` 默认按字段类型 append 合并：
  - `multi_select` → union 选项名（去重）；`rich_text` → 拼接 `原值 / 新值`；`number` → 累加；`date` → 取更早；`checkbox` → OR
  - `title` / `select` / `status` / `url` / `email` / `phone_number` 单值字段永远用新值
  - **覆盖需要显式声明**：`{name, value, overwrite: true}` 跳过读旧值直接替换（适用改名/改类别场景）
  - 实现：`mergePropertyValue` + `mergeProperties`，写入前 `GET /v1/pages/{id}` 读旧 properties；全 `overwrite: true` 时跳过读
- 切空间 = 改 `currentBindingId`，之前所有库的 `bindings[dbId].fields` 永久保留
- 改配置后**重启 pi** 生效（工厂启动时一次性读）

## 开发工作流

1. 改 `extensions/pition.ts` 或配置
2. `npm run check` — lint + typecheck + jiti 冒烟三门（smoke-load.mjs 验 6 tool + 2 命令 + boot 5 阶段契约）
3. `node diag-session.mjs` — 三查：extensions 数组含 pition、errors 为 0、tools keys 含 4 个 pition_*
4. 改向导逻辑时跑 `node wizard-check.mjs` — 真 token 验证列表库/schema/可写字段过滤
5. 真模型 E2E：`PI_E2E_BASE_URL=... PI_E2E_TOKEN=... node scripts/dev/e2e-agent.mjs`（或 `pi -p "记一下今天跑了 5 公里"` 走用户 pi 配置）
6. 交互式向导实测：在 pi TUI 里跑 `/pition`（打印模式不触发命令）
7. 部署到 nx-as 形态：`node install.mjs`（装到 `~/.nx-as/pi-agent/extensions/`）

模型直连（测试用）：用户 pi 的 `~/.pi/agent/models.json` 已定义 `new-provider`（MiniMax，anthropic-messages）；CLI 指定 `--provider new-provider --model MiniMax-M3`。

## 高频坑（全部实证踩过）

| 坑 | 表现 | 根因 / 预防 |
| --- | --- | --- |
| **工厂期 cfg 门禁**（最严重） | 会话中现配的库看不到运行态 tool，必须 /reload | `pi.registerTool` 只在工厂执行期有效——**6 个 tool 一律无条件注册**，校验下沉到 `execute` 首行的 `currentBinding()`（抛错指引 agent 去 pition_boot）。详见 [[B01-注入点清单]] §6.4 |
| index.ts 写 `.js` 后缀 | Cannot find module | jiti 按字面找文件，re-export 本地 `.ts` 用 `.ts` |
| 包目录无 index.ts 就 pi install | 加载报错 | 包形式加载必须有包根入口 |
| `Type.Record` 做 tool 参数 | MiniMax 嵌套解析坏（字段名变 `$text`） | 用 `Type.Array(Type.Object({name, value}))` 数组对 |
| model 传字符串 `"provider/id"` | `No API key found for undefined` | `ModelRuntime.getModel()` 拿对象传入 |
| agent-dir 错位 | 工具不出现 | 用户 pi 读 `~/.pi/agent`，nx-as 隔离在 `~/.nx-as/pi-agent`（`PI_CODING_AGENT_DIR`） |

## 错误案例

| 错误操作 | 实际后果 | 正确做法 |
|---------|---------|---------|
| 只看 pi TUI 是否报错来判断加载 | 静默失效被漏判 | 跑 diag-session.mjs 看 tools keys |
| 配置路径写死 `dirname(import.meta.url)` | 包形态安装时读到 null，静默 0 工具 | 两级查找（本目录 → 父目录） |
| 在 pi 源码外猜加载行为 | 反复试错浪费轮次 | 直接读 `packages/coding-agent/src/core/` 的 package-manager.ts / loader.ts |
| curl 直接发中文 JSON body | Windows git bash 编码乱码，Notion 报 validation_error | JSON 写临时文件 `--data-binary @file`，或用 node fetch |
| 在工厂里用 `loadConfig()` 结果 gate 任何注册 | 配置是在会话中现配的 → 门禁在配置之前执行 → 工具/命令缺失 | **命令和 6 个 tool 全部无条件注册**，校验下沉到 `execute` 首行 `currentBinding()` |
| 用 `pi -p "/pition"` 验证命令 | 打印模式当普通消息发给模型，误判"命令没生效" | 交互命令只能在 TUI 里试；注册用 diag-command.mjs 验 |
| **npm publish 返回 `+` 但服务端 404** | 误以为发布成功 | CDN 延迟 + 反钓鱼静默拒收。必须 `npm view <pkg> versions` 验证；同版本重发报 403 就 bump |
| 新版 npm 用 `NODE_AUTH_TOKEN` | CI 报 `ENEEDAUTH` | 必须写 `~/.npmrc`（`echo "//registry.npmjs.org/:_authToken=$NPM_TOKEN" > ~/.npmrc`） |
| `biome check --write` 格式化 `pition.config.json` | 本地 token 配置被改写 | biome.json `files.includes` 里排除该文件 |

## 排查阶梯（工具不出现时，从快到慢）

1. `pi list` — 包声明在不在
2. `npm run check` — 本地三门（lint + typecheck + jiti 冒烟）；冒烟挂了就不用往下查
3. `node scripts/dev/diag-loader.mjs` — 发现层：包被解析成什么、有无 errors
4. `node scripts/dev/diag-session.mjs` — 装配层：工厂执行后 6 个 tool 是否都在 session tools 里
   （如果只有 `pition_boot` 而缺其余 5 个 → 工厂里又加了 cfg 门禁，见高频坑表第一条）
5. `node scripts/dev/diag-command.mjs` — 命令层：`/pition` + `/pition-mode` 是否注册
6. `pi -p` 真模型实测 — 模型层：schema 兼容性问题（看模型反馈的报错形态）

## References

- [[A01-设计理念]] — 引导态（`pition_boot`）的 5 阶段契约 + 助理模式开关的产品逻辑
- [[B00-注入点架构]] — 注入点分类（Tool/Command/Event/...）的元数据与决策树
- [[B01-注入点清单]] — 当前 pition 所有注入点的位置、行号、契约、扩展指引
- [[C00-上下文架构]] — 全局 system prompt 注入的元数据（9 层 section + cache 风险）
- [[C01-上下文多层结构]] — pition 当前向模型注入 system prompt 的 9 层 section 详解 + 决策树
