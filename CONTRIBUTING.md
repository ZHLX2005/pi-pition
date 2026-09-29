# Contributing to pition

感谢参与。本文件说明**怎么改、怎么验、怎么发**。

## 环境准备

```bash
git clone https://github.com/ZHLX2005/pi-pition.git
cd pi-pition
npm install          # 装 devDependencies（含 pi 包、typebox、jiti、vitest、biome）
```

无需构建步骤——pi 用 jiti 直接加载 TypeScript 源码。

## 目录结构

```
src/                 按职责分层的实现（无 pi 运行时依赖，纯函数优先）
  types.ts           领域类型 + WRITABLE_TYPES
  config.ts          配置读写、历史格式归一、currentBinding/currentSpans 解析器
  notion.ts          Notion HTTP 客户端（抗抖动重试 + 超时）
  properties.ts      Notion property 编解码与 append 合并语义
  time.ts            时间戳 / [HH:MM] 前缀 / 区间格式化
  span.ts            区间事件状态机
  role.ts            助理模式的提示词注入内容
  databases.ts       Notion 库发现与 schema 读取
  wizard.ts          /pition 交互式配置向导
extensions/
  pition.ts          薄组装层：注册 6 个 tool + 2 个命令 + 2 个事件订阅
test/                vitest 单元 + 集成测试
scripts/dev/         本机开发/诊断脚本（不进 npm 包）
```

**分层原则**：`src/` 里的模块**不 import pi 运行时**（除了 `wizard.ts` 的结构化 ctx 契约）。
所有 pi API 调用集中在 `extensions/pition.ts`。这样 `src/` 可以在普通 Node 进程里直接测。

## 开发命令

```bash
npm run check        # 四门：lint → typecheck → test → smoke（提交前必跑）
npm run lint:fix     # biome 自动修复
npm test             # vitest（69 个用例）
npm run test:watch   # 监听模式
node scripts/dev/diag-session.mjs   # 本机 pi 会话装配诊断（需先 npm install）
```

## 改代码时的硬约束

1. **tool 一律无条件注册**。不要在工厂里用 `if (!cfg) return` 挡住 `registerTool`——
   配置是在会话中现配的，注册期做门禁会导致工具缺失（详见 `.claude/skills/pition-dev/references/B01-注入点清单.md` §6.4）。
   校验下沉到 `execute` 首行的 `currentBinding()`。

2. **不要闭包捕获工厂期的 cfg**。每个 `execute` 都重新 `loadConfig()`——
   否则切库后仍查旧库。用 `src/config.ts` 的 `currentBinding()` / `currentSpans()`。

3. **tool 参数用 `Type.Array(Type.Object({name, value}))`，不用 `Type.Record`**——
   实测 MiniMax 对 Record 形态的嵌套参数解析会坏（字段名变 `$text`）。

4. **`details` 一律经 `detail({...})` helper 包一层**——pi 的 `registerTool` 会从返回推导
   `AgentToolResult<TDetails>`，多分支不同形状会推成 union 而炸类型。

5. **提示词注入只用 `promptGuidelines.push` 与 `sections[name]`**，
   禁用 `forceSystemPrompt`（整段替换 = prompt cache miss）。

6. **`noExplicitAny` 在 biome 里是关闭的，这是有意的**：Notion API 的响应结构
   （`page.properties` / `blocks.children`）形状随用户数据库 schema 变化，在接入官方 SDK 前
   无法静态描述；强行标注会引入大量错误的类型断言。规避手段是**把 `any` 限制在 IO 边界**
   （`src/notion.ts` / `src/properties.ts` 的解析函数），业务层用收窄后的类型。

## 加新 tool 的流程

1. 在 `src/` 写纯逻辑（可测），`extensions/pition.ts` 里只做注册 + 组装
2. 在 `test/extension.test.ts` 的 `EXPECTED_TOOLS` 加上新 tool 名
3. 给核心行为写单元测试（断言行为，不要写空壳）
4. 跑 `npm run check`

## 提交与发布

- 提交信息用祈使句、说清"为什么"而不只是"做了什么"
- 发布走 tag 驱动（CI 自动 npm publish）：
  ```bash
  # 1. 改 package.json version + 更新 CHANGELOG.md
  # 2. commit + push
  git tag v0.x.y && git push origin v0.x.y
  # → GitHub Actions: smoke → 校验 tag==version → npm publish --provenance → GitHub Release
  ```
- 发布后用 `npm view @flowot/pi-pition versions` 确认服务端已收录
  （本地 `npm publish` 返回 `+` 不代表服务端收录）

## License

MIT
