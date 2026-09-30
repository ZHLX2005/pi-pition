# pition 开发规范（给 AI 协作者）

## 项目一句话

pition 是一个 pi coding agent 扩展：把 Notion 数据库变成 agent 的持久化存储。
单库心智（currentBindingId 选定后所有 tool 都操作它）、page 列表对 agent 透明、
属性默认 append 合并、区间事件（span）由全局提示词持续注入。

## Code Quality

- 改代码前完整读目标文件，不要靠搜索片段做宽改动。
- 无构建步骤是刻意的：pi 用 jiti 直接加载 TS 源码。不要引入 dist/esbuild。
- **`extensions/pition.ts` 是纯注册层**（tool schema + 委托 `src/tools/`）；业务逻辑一律写进 `src/`。
- tool 参数 schema 一律 `Type.Array(Type.Object({name, value}))` 数组对，禁 `Type.Record`（MiniMax 嵌套解析会坏）。
- tool execute 第一行必须 `currentBinding()` 或 `loadConfig()` 重读——禁止闭包持有工厂期的 cfg（切库后 handler 会查旧库）。
- tool 的 `description` 不写 cfg 衍生字符串（库标题/字段说明）；指引 agent 调 `pition_boot stage=done`。
- system prompt 注入只用 `promptGuidelines.push` 和 `sections[name]`；禁 `forceSystemPrompt`（整段替换 = cache miss）。
- match 周围代码风格；单行 helper 只有一处调用就内联。

## Commands

```bash
npm run check       # 四门：lint → typecheck → test → smoke（提交前必跑）
npm run lint:fix    # biome 自动修复
npm test            # vitest（单元 + 集成）
node scripts/dev/diag-session.mjs   # SDK 会话装配诊断（需先 npm install）
```

改代码后必须跑 `npm run check` 并修到全绿。

## 发布流程（tag 驱动，GitHub Actions 自动 npm publish）

1. bump `package.json` version
2. `CHANGELOG.md` 的 `## [Unreleased]` 挪到新版本节
3. commit + push main
4. `git tag v0.x.y && git push origin v0.x.y` → release workflow: smoke → 校验 tag=version → npm publish --provenance → GitHub Release
5. 本地 `npm view @flowot/pi-pition versions` 验证收录（本地 publish 返回 `+` 不代表服务端收录）

## Git

- agent 永不 commit/push——除非用户明确要求。
- 禁 `git reset --hard` / `git clean -fd` / force push。
- 工作树保持用户留下的样子。

## 已知坑（全部实证踩过）

| 坑 | 预防 |
| --- | --- |
| 工厂期用 cfg 做注册门禁 → 会话中现配的库看不到运行态 tool | 6 个 tool 无条件注册；execute 内 `currentBinding()` 抛错指引 |
| npm publish 本地返回 `+` 但服务端 404（CDN 延迟/静默拒收） | 必须 `npm view` 验证；同版本重发报 403 就 bump |
| `NODE_AUTH_TOKEN` 新版 npm 不认 | release.yml 里写 `~/.npmrc` |
| smoke-load 依赖本机绝对路径 | 已改为 node_modules 相对解析 + 临时 cfg + PITION_CONFIG 隔离 |
| 中文注释在编辑器转码出现 mojibake | 发现即修；ASCII 安全的标识符优先 |
