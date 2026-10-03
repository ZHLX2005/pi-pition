---
name: pition-setup
description: >-
  pition 配置与绑定场景 SOP。用户第一次装 pition、说「配一下 pition」「怎么绑定 Notion 库」
  「换个库/切空间」「字段说明怎么填」「助理模式在哪开」「pition 没反应/工具不出现」——匹配到
  这些输入时先读本文件再行动。覆盖：5 阶段配置流程（token → select_db → describe_fields →
  set_mode → done）、字段说明怎么写、换库不丢说明、配置热生效、常见卡点排查。
---

# 配置与绑定（pition boot 场景 SOP）

本场景的目标：**把用户从「装了但没配」带到「能用」，并在中途不丢已填的字段说明**。
配置状态是每次调用 `pition_boot` 时现读的，**先看它的 description 里的「当前状态」段**定位卡点。

## 1. 5 阶段流程（渐进式，不必从头重走）

| 阶段 | 调用 | 完成标志 |
| --- | --- | --- |
| 0 看现状 | `pition_boot stage=done` | 知道 token / 当前库 / 字段覆盖率 / 助理模式 |
| 1 登录 | `stage=token` + `token: "ntn_..."` | token 校验通过并落盘（会在返回里显示可访问库数） |
| 2 选库 | `stage=select_db` → 列库；`stage=select_db, dbId` → 接管并切为当前库 | 当前库已绑定 |
| 3 补字段说明 | `stage=describe_fields, dbId, fieldDescriptions[]` | 字段说明落盘，覆盖率上升 |
| 4 开关助理模式 | `stage=set_mode, enabled: true`（或 `/pition-mode`） | 每次对话按场景注入助手定位与剧本 |

- 用户只改某一阶段产物时**直接调对应 stage**，不要从 `token` 重走。
- 顺序可跳：`pition_goal` 支持**冷设置**（未配 Notion 也能建目标、推进度）。

## 2. 字段说明怎么写（产品核心）

- 字段说明是**给 agent 看的语义**，不是给人看的备注。落盘后每轮对话注入（`pition_fields` 段），
  写得越具体 agent 写得越准——这是「看得板还是看正文」的判断依据。
- 引导用户按「**这个字段记什么**」回答，一次问清所有字段，然后 `describe_fields` 一次性提交；
  不要照抄字段名当说明（`"标签" → "标签"` 等于没写）。
- 好例子：`"金额" → "当日花销合计（元）；append 时累加"`、`"心情" → "当日整体心情，取值：很好/不错/一般/低落"`。
- 一次只填能确认的也行：`describe_fields` 允许部分提交，覆盖率会显示进度；没说明的字段
  在注入里只显示字段名+类型。

## 3. 换库 / 切空间

- `stage=select_db` 重新选（或直接带 `dbId` 接管）→ `currentBindingId` 改掉即生效。
- **已描述过的库按 dbId 永久保留**（`cfg.bindings[dbId]`），切回来不用重填。
- 换库后注入的字段字典、写入目标、`pition_read` 全部跟着切——**不要**让用户重启 pi。

## 4. 何时生效（热重载）

- 配置改完**立即生效**：`before_agent_start` 与 tool `execute` 每轮都 `loadConfig()` 重读。
- 唯一需要 reload 的场景：插件代码本身升级（`/reload` 或重启）。
- 不要用 `pition_write` 去写配置——配置是插件自己的 `pition.config.json`，不是用户的 Notion 库。

## 5. 常见卡点排查

| 现象 | 定位 | 处理 |
| --- | --- | --- |
| 看不到任何 pition tool | 扩展没加载（不是配置问题） | 查 pi 的 packages 声明 / 跑 `npm run check` + `node scripts/dev/diag-session.mjs` |
| 调 tool 报「pition 未配置」 | 没有 `pition.config.json` | 走阶段 1（`stage=token`） |
| 报「没选当前库」 | 有 token 但 `currentBindingId` 为空 | 走阶段 2（`stage=select_db`） |
| token 校验通过但可访问库数 0 | Notion 里没把目标库「连接」到这个 integration | 让用户在 Notion 库页面 → 连接 → 选该 integration |
| 字段覆盖率一直 0 / agent 老写错字段 | 没补字段说明 | 走阶段 3（`describe_fields`） |
| 助理模式开了没变化 | 只注入了 `pition_core`（场景未命中，属正常——场景 SOP 只在该场景出现） | 说一句该场景的话（如「我想练腹肌」）即可看到 `pition_scene` |

## 6. 不要做的事

- 不要在没有 token 时反复调 `select_db`（会直接报错，先补 token）。
- 不要把 token 贴进对话正文后随手丢掉——它只经 `stage=token` 落盘，不要写进任何文件。
- 不要因为「配好了」就主动罗列工具清单给用户；用户要的是能用，不是说明书。
