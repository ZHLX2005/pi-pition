# pition — Notion 个人记录助手（pi 扩展）

把 Notion 数据库变成 pi agent 的持久化存储。agent 通过 4 个 tool 识别对话中的记录内容，自动理解后写入你绑定的 Notion 库——**日常记录默认写到最新一条记录**（按最后编辑时间），不重复建行。

不做 MCP。单用户固定 token + 自有库 + 定制 tool 语义，原生 pi 扩展更轻。

## Tool 一览

| tool | 用途 |
|---|---|
| `pition_boot` | **元工具**：5 阶段渐进式配置（token → 选库 → 补字段说明 → 助理模式开关 → done），可被 agent 或 web 面板驱动 |
| `pition_stores` | 列出绑定的存储与字段说明（agent 写之前的”字典”） |
| `pition_query` | 查询记录，默认按最后编辑时间倒序，支持单字段过滤 |
| `pition_add_entry` | 新建记录（属性 + 可选正文段落） |
| `pition_update_latest` | **核心路径**：把属性修改/正文追加写到该库最新的记录 |

字段说明（description）来自配置，会原样出现在 `pition_stores` 的返回里——agent 靠它理解”每个字段该填什么”。

### `pition_boot` 5 阶段契约

```ts
// 阶段 1：登录落盘 token
{ stage: “token”, token: “ntn_...” }
// 阶段 2：列库
{ stage: “select_db” }
// 阶段 3：提交字段说明（一次性 array，agent 自动化友好）
{ stage: “describe_fields”, dbId: “<id>”,
  fieldDescriptions: [
    { name: “Name”, description: “记录标题，一般是当天日期” },
    { name: “基础”, description: “当日核心事项摘要” },
  ],
  bindingDescription: “个人日常记录总表”,
  bindingTitle: “pition” }
// 阶段 4：切换助理模式（落盘，重启 pi 保留；等价 /pition-mode）
{ stage: “set_mode” }                       // toggle
{ stage: “set_mode”, enabled: true }        // 强制开
{ stage: “set_mode”, enabled: false }       // 强制关
// 阶段 5：查询当前绑定状态（详情含 assistantMode）
{ stage: “done” }                           // 整体
{ stage: “done”, dbId: “<id>” }             // 单库覆盖率
```

任意阶段可中断；用户只改某一阶段时直接调对应 stage，不必从 `token` 重走。

**助理模式默认关闭**（`_assistantMode` 缺省 = `false`）。要在 pi 启动时把整个 agent 注入成「pition 个人管理助手」定位，调 `stage=set_mode enabled=true` 即可，等价于 `/pition-mode` 命令（两者共享同一份 cfg）。

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

## 安装

```bash
# 1. 复制 example 配置成 pition.config.json，填入 token
cp pition.config.example.json pition.config.json
# 编辑 pition.config.json：
#   - 把 token 字段填成你的 Notion integration token（ntn_...）
#   - bindings / currentBindingId 由 /pition 向导或 pition_boot 自动写入

# 2. 安装（只装用户主 pi；用 --with-nx-as 加装 nx-as 沙箱）
node install.mjs                                # 默认装 ~/.pi/agent
node install-all.mjs --with-nx-as              # 装 ~/.pi/agent + ~/.nx-as/pi-agent
```

> 如果你的 pi 已通过 `~/.pi/agent/settings.json` 的 `packages` 字段直接指向本仓库源码目录，**可以完全跳过安装步骤** —— pi jiti 直接加载 `extensions/pition.ts`。

## 配置格式

```jsonc
{
  "token": "ntn_...",                    // Notion integration token
  "bindings": {                          // object（按 dbId 索引）
    "3e96f99d-06fa-8086-bea0-fad4c505f7d8": {
      "dbId": "3e96f99d-06fa-8086-bea0-fad4c505f7d8",
      "title": "pition",                 // agent 看到的存储名
      "description": "个人日常记录总表",   // 库用途说明
      "fields": {
        "Name":  { "type": "title", "description": "记录标题" },
        "基础":  { "type": "rich_text", "description": "当日核心事项摘要" },
        "复杂":  { "type": "select", "description": "记录类别标签" }
      }
    }
  },
  "currentBindingId": "3e96f99d-06fa-8086-bea0-fad4c505f7d8",  // 当前激活库
  "_assistantMode": false                // 助理模式开关（落盘等价 /pition-mode）
}
```

## 配置流程（对应产品想法）

有两条路，**推荐用交互式向导**。

### 方式 A：`/pition` 交互式向导（推荐）

在 pi TUI 里输入：

```
/pition
```

向导按四步走（全部在终端里交互，不用手编 JSON）：

1. **登录**：填 Notion integration token（已存过则显示脱敏值，回车沿用）→ 实时校验并显示工作区名
2. **选库**：列出该 token 可访问的所有库（标题 + 字段数，已绑定的标注 `[已绑定]`）供选择
3. **看结构**：弹出该库所有**可写字段**及其类型（formula/relation/rollup 等计算字段自动过滤）
4. **补说明**：逐字段填写用途说明（已配过的字段显示原说明，回车沿用）

保存后**自动热重载**（`ctx.reload()`），无需重启 pi，4 个 tool 立即生效。

> 向导每次配置一个库；要加第二个库，再跑一次 `/pition`。

### 方式 B：手编配置文件（批量/迁移场景）

1. **登录平台**：Notion 集成页创建 integration，拿 `ntn_` token 填进 `token` 字段
2. **选择 db**：在 Notion 里把目标库「连接」到该 integration，库 id 写进 `bindings[].dbId`
3. **字段描述**：对每个字段补 `description`——这段文字决定 agent 对字段的理解
4. **生效**：`node install.mjs` + 重启，4 个 tool 即注册进 pi

## token 安全

- `pition.config.json` 含明文 token，**不要提交进 git**（本仓库用 `.gitignore` 屏蔽，仅 `pition.config.example.json` 是空 token 模板）
- token 只在被安装的 extensions 目录里被 pi 进程读取
- 向导只写本地配置文件，不向任何第三方上传
- 想换库/换 token / 看当前状态 → 调 `pition_boot stage=done`
