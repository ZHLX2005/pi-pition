# pition_goal 需求文档

> 状态：**已实现（v0.4.1）**｜ 来源：§0-§1 用户原话 + 后续演进 ｜ 实现跟踪：CHANGELOG 0.3.0-0.4.1

## 0. 原始需求（用户原话，未改动）

> 添加一个goal的tool,goal需要设置范围 比如 /天 , 然后后面每次对话都应该提醒,并且span机制 精确到秒 因为这个goal只要用于我的锻炼计划,我需要agent帮助我设置每天的计划 并且实时交流,然后每天汇报自己的完成程度,对于一些实时的汇报 我会利用到span机制 说我开始 xx 第2轮 开始 ,然后结束,这样agent可以自动统计上下文  完成一个span,并且标记这个goal的完成程度 goal具体可以量化 ,并且是列表机制 , 从0-1,或者4轮 这种 可以渐进式的完成 agent这个场景下 应该及时了解用户 给出积极的反馈和引导

## 1. 计划之后的调整（用户反馈原话，按时间序）

给出实施方案后，用户多轮调整（含未编号尾段，一并列出）：

**调整 1**（对 span 收尾与 goal 关系）：

> end不该结束goal,而是end可以选择goal的清单列表的一个item, 然后传入变化值 在这个item的某个进度上面进行数字加法

**调整 2**（对 goal 周期与重置）：

> goal支持 天为单位的类型,不需要主动重置

**调整 3**（对 goal 的 Notion 展示）：

> goal应该在支持绑定一个属性字段, 对今日目标完成的情况进行展示,支持冷设置  原始的goal存在插件内部

**调整 4**（自动周期 + 完整 CRUD + 进度控制 + 对话流，合并自原稿尾段）：

> goal在第一次设置的时候 就能设置自动周期
> goal工具 支持完整的CRUD
> 设置相关的进度控制
> （对话流：用户说想练 → agent 了解身体情况/运动倾向 → 询问是否设置规划任务，推荐每天热身、周135力量训练——cron 定时语法控制 → 用户确认 → agent 给可量化方案落盘）
> 后续每天用户的goal会注入到全局系统提示词里面 ,类似于span的事件机制
> 用户: 我完成了3个哑铃 然后进行扣减 --> 3/10第一组
> agent: 如果过低 应该读取之前完成的记录 如果连续2天没有按照计划执行 询问是否需要调整 ,如果超额完成任务 调查最近一个月的完成进度,从而可以进行一些扩展能力加强 (动态goal的自检查)

**调整 5**（v0.4.1，goal-first 契约）：

> 开启助理模式后，注入的系统提示词强调一下skill的使用，然后优化goal的完成，优先直接通过goal进行推荐 span这个机制只是扩展，比如长任务 可能使用span并且完成goal 比如跑步，但是常见的训练做组训练 和时间无关，就直接在goal内进行process即可

## 2. 决策记录（对应 §1 调整）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | span end 联动语义 | end **不结束 goal**；可选传 `goalItemName` + `goalDelta`，对条目进度做**数字加法**（`progress += delta`）。end 只收尾 span；goal 生命期由日期决定，不受 span 影响 |
| D2 | 周期与重置 | 周期 = **天**；**不需要主动重置**——goal 按 `date`（YYYY-MM-DD）天然分区：注入/列表只渲染今天，历史日沉底保留，无清理/回滚机制 |
| D3 | Notion 展示 + 冷设置 | goal 可**绑定一个属性字段**（bindField）展示完成摘要；但 Notion 是**可选投影**——**冷设置**（未配置 Notion 也能建 goal/推进/查询），原始 goal 存插件内部（`pition.config.json` 的 `_activeGoals`）；bindField 只在已配置且字段存在时同步，缺席/失败不影响 goal 本体 |
| D4 | 自动周期 | **首次设置即可指定**：`daily` 或 5 段 cron（如 `0 6 * * 1,3,5` 周一三五；只消费 日/月/星期字段，时分忽略——goal 粒度是天）。跨天自动原地归零重开（无需人工重置）；非法 cron **set 时即拒绝**（不落毒丸） |
| D5 | 完整 CRUD + 进度控制 | 5 action（set/progress/list/update/delete）；进度三模式（delta 加法默认 1 可负回退 / value 绝对值 / reset 归零，互斥）；update 同名条目保留进度 |
| D6 | goal-first 契约（v0.4.1） | **进度推进默认直接 `action=progress`**——做组/次数/时长型目标与时间无关；span 降为**计时扩展**，只用于需计时的长任务（跑步/球类），end 带 goalItemName/goalDelta 一次完成收尾+推进。助理模式注入同步强调 skill 优先（场景命中先读 skill 再行动） |

## 3. 功能需求（收敛后）

### FR1 goal CRUD + 可量化条目
`set`（title + items[{name,target,unit}]；同日已有须 replace；date 可补录历史，**拒绝未来日期**——v0.3.1 修复线上「set 成功却查无此 goal」实症）/ `progress` / `list` / `update` / `delete`。

### FR2 每次对话提醒
今日 goal 进度注入全局提示词独立 section（`pition_goal`），实际数字实时现算；独立于助理模式（程序性上下文，未绑库也注入）；连续 ≥2 天未执行附 ⚠️ 自检查提示。

### FR3 span 秒级
span 时长精确到秒（`[14:32:15-14:33:02 持续 47 秒]`），span 注入文案同步。

### FR4 span end 联动（D6 演进后 = 计时扩展路径）
span `end` 可选 `goalItemName` + `goalDelta` → 收尾 span 同时推进条目；条目不存在不抛错（span 落盘优先）。**默认路径是直接 progress（D6）**；span 联动保留给需计时的长任务。

### FR5 自动周期（cron）
见 D4；物化模型 = 原地重开（同 goalId、进度归零、date 前移）；missedDays 记录断更天数（自检查数据源）。

### FR6 bindField 可选投影
进度变化时把单行摘要覆写进绑定字段（`俯卧撑 2/4 轮 · 平板支撑 0/3 组（40%）`，全达标 ✅ 前缀）；三容错：未配置 Notion / 无 page / 写入失败都不抛错、不影响 goal 本体。

### FR7 动态自检查
missedDays ≥2 → 注入 ⚠️ 提示 → agent 主动询问调整（update 降 target / 改 cron / 清周期），不说教；超额完成 → 指引回看本月（pition_history）。

### FR8 冷设置
未配置 Notion 全 action 可用，进度存插件内部 `_activeGoals`。

## 4. 非目标

- 不做周/月/自定义周期类型（`period` 字段预留，v1 仅 day）
- 不做自动重置非周期 goal、进度回滚
- span end 不隐式创建 goal；无 goal 时联动参数为空转提示
- 不做 goal 模板管理界面 / 趋势统计图表（后续版本可加）

## 5. 验收标准（实现状态）

| # | 标准 | 状态 |
|---|---|---|
| 1 | `npm run check` 四门全绿 | ✅ 125 用例 / 9 文件 / SMOKE PASS |
| 2 | 状态机单测全覆盖（set/replace/补录/未来日期拒绝、progress 三模式互斥、cron 语义、物化、missedDays、渲染） | ✅ goal.test.ts 34 例 |
| 3 | goal-run 行为层（冷设置/bindField 三容错/5 action）+ span-run 联动回归（不复活 span） | ✅ 10 + 3 例 |
| 4 | FR2 端到端注入断言（goals 存在时 sections.pition_goal 真被填充，含 ⚠️） | ✅ extension.test.ts |
| 5 | 子 agent 评审 ≥98 | ✅ 首轮 85 → 修复 7 项 → 99/100；0.4.1 后复审 93/100（缺口均当轮闭环） |
| 6 | 发布 | ✅ v0.3.0 / v0.3.1 / v0.4.0 / v0.4.1 全部上线，npm latest = 0.4.1 |
