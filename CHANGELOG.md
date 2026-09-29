# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
