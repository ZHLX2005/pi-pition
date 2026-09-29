# pition — Notion 个人记录助手（pi 扩展）

把 Notion 数据库变成 pi agent 的持久化存储。agent 通过 6 个 tool 识别对话中的记录内容，自动理解后写入你绑定的 Notion 库——**日常记录默认写到当前 page**（`pition_write` 自动追加/合并属性，按 `appendContent` 写正文），不重复建行。

不做 MCP。单用户固定 token + 自有库 + 定制 tool 语义，原生 pi 扩展更轻。

## 安装

```bash
pi install npm:@flowot/pi-pition
```

装完在 pi TUI 里跑 `/pition` 走配置向导（或让 agent 调 `pition_boot`），配完立即可用。

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
| `pition_span` | **区间事件**：开始/心跳/结束（跑步、开会、午休）；结束才落 Notion，进行中持续注入全局提示词 |

所有运行态 tool **无条件注册**——没绑定库时调用会得到清晰错误，指引 agent 去走 `pition_boot`。

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
// → cfg 落盘 _activeSpan；此后每次模型请求前全局提示词自动注入：
//   「📍 进行中：跑步（公园 5 公里），已 28 分钟——若完成调 end，仍在继续调 heartbeat」
pition_span({ action: "end", summary: "感觉很好" })
// → 当前 page 追加一段：[14:32-15:00 持续 28 分钟] 跑步（公园 5 公里）— 感觉很好
```

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

## nx-as 物化形态（可选）

`node install.mjs` 把 `extensions/pition.ts` + 配置复制到 `~/.nx-as/pi-agent/extensions/`（pi-agent 隔离环境用）；一般用户不需要。

## 开发

```bash
npm run check        # lint + typecheck + smoke（prepublishOnly 同款三门）
node scripts/dev/diag-session.mjs   # SDK 会话装配诊断（需本机 pi 源码路径）
```

发布：bump `package.json` version → 写 `CHANGELOG.md` → `git tag vX.Y.Z && git push origin vX.Y.Z`，GitHub Actions 自动 smoke → npm publish（provenance）→ GitHub Release。

## License

MIT
