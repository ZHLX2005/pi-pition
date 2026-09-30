# Tool 契约参考

7 个 tool 的**完整参数语义**。运行时 schema 是唯一真相源（`extensions/pition.ts`），
本文与之保持同步 —— 改参数时请一并更新。

所有 tool **无条件注册**：未绑定库时调用会抛错并指引 `pition_boot stage=select_db`。

---

## `pition_boot` — 元配置（引导态）

分阶段配置 Notion 集成。description 里动态拼装了当前状态（token / 当前库 / 字段覆盖率 / 助理模式），
agent 第一次看到就知道现状，不必先 ping `stage=done`。

| 参数 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `stage` | `"token" \| "select_db" \| "describe_fields" \| "set_mode" \| "done"` | ✓ | 推进到的阶段 |
| `token` | string | — | `stage=token` 传 `ntn_...`；其它阶段忽略 |
| `dbId` | string | — | `select_db` 选定库；`describe_fields` 必传；`done` 可选查单库覆盖率 |
| `fieldDescriptions` | `{name, description}[]` | — | `describe_fields` 一次性提交所有字段说明 |
| `bindingDescription` | string | — | `describe_fields` 设置库用途说明 |
| `bindingTitle` | string | — | 可选，覆盖 agent 眼中的存储名（默认 Notion 原标题） |
| `enabled` | boolean | — | `set_mode` 强制设置助理模式；缺省 = toggle |

---

## `pition_write` — 日常主路径

把属性修改 / 正文追加写到**当前 page**（按 `last_edited_time` 倒序取 top1）。
写入后返回 `todaySoFar`（属性 + 正文的完整预览），便于 agent 复述与追问。

| 参数 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `properties` | `{name, value, overwrite?}[]` | — | 要改的字段（与 `appendContent` 至少传一个） |
| `appendContent` | string | — | 追加到正文末尾；多段用 `\n\n` 分隔 |
| `timestamp` | string \| number | — | 事件时间（ISO 或 Unix ms），默认当前时间。代写历史事件时手动指定 |
| `prefixTimestamp` | boolean | — | 是否给每段首加 `[HH:MM]`，默认 `true` |

**属性合并语义**（`overwrite` 缺省 = append）：

| 字段类型 | append（默认） | `overwrite: true` |
| --- | --- | --- |
| `multi_select` | union 选项名（去重） | 替换 |
| `rich_text` | 拼接 `原值 / 新值` | 替换 |
| `number` | 累加 | 替换 |
| `date` | 取更早 | 替换 |
| `checkbox` | 取 OR | 替换 |
| `title` / `select` / `status` / `url` / `email` / `phone_number` | 永远用新值（单值字段） | — |

**边界行为**：当前库没有任何 page 时返回 `warning`（不抛错），agent 可改调 `pition_create_today`。

---

## `pition_read` — 读当前 page

| 参数 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| （无） | — | — | 固定读当前 page（top1）的 properties + 所有正文 block |

---

## `pition_history` — 翻旧账（不是默认背景）

| 参数 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `limit` | number | — | 返回条数，默认 10，最大 50 |
| `filter` | `{field, op, value}` | — | 单字段过滤。`op` 为 `equals`（精确）或 `contains`（文本包含）；`value` 类型随字段：checkbox 用布尔、number 用数字、其余用字符串 |

日常记录**不需要**调用；只在用户明确翻历史（「上个月/上周/去年」）时用。

---

## `pition_create_today` — 逃生口

**默认不调用** —— page 由 Notion 定时任务每天 0 点自动建。
仅当 `pition_write` 返回 `warning: no_page_in_db` 时才由 agent 显式调用。

| 参数 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `properties` | `{name, value, overwrite?}[]` | ✓ | 必须含 `title` 类型字段的值 |
| `content` | string | — | 新 page 的初始正文（多段用 `\n\n` 分隔） |
| `timestamp` | string \| number | — | 事件时间（ISO 或 Unix ms），默认当前时间 |
| `prefixContent` | boolean | — | 是否给正文段首加 `[HH:MM]`，默认 `true` |

---

## `pition_span` — 区间事件

记录「开始-持续-结束」的事件（开会 / 跑步 / 午休）。**支持并行多个**。
累计时长由 `startedAt` 现算（每次对话自动更新），**无需心跳**。
`start` 只落盘到 `cfg._activeSpans`（不写 Notion）；`end` 才把整段拼成一条正文写入当前 page。

| 参数 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `action` | `"start" \| "end"` | ✓ | `start` 开新事件；`end` 收尾并写入 Notion |
| `eventName` | string | start 必填 | 事件名。`end` 时按名精确匹配；省略时**仅当只有一个进行中事件**才允许 |
| `note` | string | — | 可选备注（start 时设定；end 时可补充） |
| `summary` | string | — | `end` 时的总结/感受，合并进正文 |
| `goalItemName` | string | — | `end` 可选：今日目标条目名——收尾后把 `goalDelta` 加到该条目进度（联动 pition_goal；end 不结束 goal，只做数字加法） |
| `goalDelta` | number | — | `end` 可选：`goalItemName` 的推进量，默认 1 |

**产出格式**（秒级）：`[14:32:15-15:00:20 持续 28 分 5 秒] 跑步（公园 5 公里）— 感觉很好`

**错误行为**：`end` 时若有多个进行中事件且未传 `eventName` → 报错并列出全部候选。
联动条目不存在 → 不抛错（span 收尾优先），文案提示改用 `pition_goal action=list`。

---

## `pition_goal` — 每日目标（完整 CRUD + 进度控制）

按天的可量化目标（锻炼计划场景）。目标 = 标题 + 条目列表（每条 name/target/unit）。
进度每次对话自动注入全局提示词（`pition_goal` section，实际数字）；
自动周期 goal 跨天自动归零重开（无需人工重置）；**未配置 Notion 也可用（冷设置，进度存插件内部）**。

| 参数 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `action` | `"set" \| "progress" \| "list" \| "update" \| "delete"` | ✓ | 建 / 进度 / 列 / 改（不动进度）/ 删 |
| `title` | string | set 必填 | 目标标题（update 可改） |
| `items` | `{name, target, unit?}[]` | set 必填 | 可量化条目（target 正数）。update 时同名条目保留进度，新条目从 0 起 |
| `autoPeriod` | string \| null | — | 自动周期：`"daily"` 或 5 段 cron（如 `"0 6 * * 1,3,5"` 周一三五重开；只消费 日/月/星期字段）。update 传 null 清除。**首次设置即可指定** |
| `bindField` | string \| null | — | 绑定当前库一个字段：进度摘要自动覆写展示（看板直读）。update 传 null 清除。冷设置可不传 |
| `replace` | boolean | — | set：同日已有目标时须显式 true 才覆盖 |
| `date` | string | — | set：归属日期 YYYY-MM-DD，缺省今天（补录历史日） |
| `goalId` | string | — | progress/update/delete：定位哪个 goal（省略 = 今天唯一；多个时必传） |
| `itemName` | string | progress 必填 | 推进哪条（按条目名） |
| `delta` \| `value` \| `reset` | number / number / boolean | — | progress 三选一：加法（默认 1，可负）/ 绝对值（非负）/ 归零 |
| `note` | string \| null | — | 备注（update 传 null 清除） |

**注入格式**：`🎯 今日目标 1 个：- 「今日锻炼计划」（每天）：俯卧撑 2/4 轮 ｜ 平板支撑 0/3 组（共 29%）`；
连续 ≥2 天零活动时附 `⚠️ 已连续 N 天未执行——询问用户是否调整`。

**绑定字段摘要格式**：`俯卧撑 2/4 轮 · 平板支撑 0/3 组（29%）`，全达标加 `✅ ` 前缀。
字段同步是可选投影：未配置 / 无 page / 写入失败都不影响 goal 本体，仅文案附注。

---

## `pition-mode`（命令，非 tool）

切换助理模式：把整个 pi agent 注入「pition 个人管理助手」定位与行为准则。
等价于 `pition_boot stage=set_mode`（两者共享同一份 cfg，落盘到 `_assistantMode`）。

## `/pition`（命令，非 tool）

交互式配置向导（TUI）：token → 选库 → 看结构 → 逐字段补说明 → 保存 + 热重载。
任意一步取消则整次不保存。RPC 模式走 `extension_ui_request` 子协议。
