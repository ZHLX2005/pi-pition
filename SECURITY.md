# Security Policy

## 威胁模型

pition 是一个**单用户、本机运行**的 pi 扩展。它在 pi 进程内执行，拥有与 pi 相同的权限。

### 敏感数据

| 数据 | 位置 | 保护 |
| --- | --- | --- |
| Notion integration token | `<pi-agent-dir>/extensions/pition.config.json`（默认 `~/.pi/agent/extensions/`，`PI_CODING_AGENT_DIR` 可覆盖） | **明文落盘**，靠 `.gitignore` 防提交；文件权限由 OS 决定 |
| 用户记录内容 | 用户自己的 Notion 数据库 | 由 Notion 侧权限控制 |
| 库用途说明 + **字段说明** | 同上（`bindings[dbId].description` / `fields[].description`） | 无特殊保护——**注意：这些文字会被注入模型上下文**（助理模式下的 `pition_fields` 段），等同于把库结构告诉模型服务商 |
| 今日目标 / 进行中的事件 | 同上（`_activeGoals` / `_activeSpans`） | 同注入上下文；仅本机存储 |

**token 明文是刻意的取舍**：单用户本机工具，加密只会把密钥放到同一台机器上，
增加复杂度而不增加实际安全性。代价是——**不要把 `pition.config.json` 提交到任何仓库**。

**注入面同理**：pition 会把「当前库的字段名 + 你填的字段说明 + 今日目标进度」放进系统提示词，
这些内容会随请求发给模型服务商。这是功能本身（否则 agent 无法正确写属性），但请注意：
**不要在字段说明里写敏感信息**（如身份证号、密码提示、密钥）。

### 包安装时的注意

pi 包会以完整系统权限执行代码。安装第三方包前请审阅源码。本项目的源码在
`src/` + `extensions/`，无构建步骤（pi 用 jiti 直接加载 TS）。

## 报告漏洞

请通过 GitHub Security Advisory 私密报告（仓库页 → Security → Report a vulnerability），
不要在公开 issue 里披露细节。

报告时请包含：影响范围、复现步骤、受影响的版本。

## 依赖策略

- 运行时依赖仅 `@earendil-works/pi-coding-agent` 与 `typebox`（均为 `peerDependencies`，由 pi 提供）
- 开发依赖（vitest / biome / typescript）不进入发布产物
- 发布走 `npm publish --provenance`（OIDC 签名，可追溯构建来源）
