# Security Policy

## 威胁模型

pition 是一个**单用户、本机运行**的 pi 扩展。它在 pi 进程内执行，拥有与 pi 相同的权限。

### 敏感数据

| 数据 | 位置 | 保护 |
| --- | --- | --- |
| Notion integration token | `pition.config.json` | **明文落盘**，靠 `.gitignore` 防提交；文件权限由 OS 决定 |
| 用户记录内容 | 用户自己的 Notion 数据库 | 由 Notion 侧权限控制 |

**token 明文是刻意的取舍**：单用户本机工具，加密只会把密钥放到同一台机器上，
增加复杂度而不增加实际安全性。代价是——**不要把 `pition.config.json` 提交到任何仓库**。

### 包安装时的注意

pi 包会以完整系统权限执行代码。安装第三方包前请审阅源码。本项目的源码在
`src/` + `extensions/`，共约 2000 行，无构建步骤（pi 用 jiti 直接加载 TS）。

## 报告漏洞

请通过 GitHub Security Advisory 私密报告（仓库页 → Security → Report a vulnerability），
不要在公开 issue 里披露细节。

报告时请包含：影响范围、复现步骤、受影响的版本。

## 依赖策略

- 运行时依赖仅 `@earendil-works/pi-coding-agent` 与 `typebox`（均为 `peerDependencies`，由 pi 提供）
- 开发依赖（vitest / biome / typescript）不进入发布产物
- 发布走 `npm publish --provenance`（OIDC 签名，可追溯构建来源）
