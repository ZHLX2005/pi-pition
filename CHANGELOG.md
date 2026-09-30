# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
