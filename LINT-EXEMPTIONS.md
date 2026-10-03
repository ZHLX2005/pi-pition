# Lint 豁免说明

本文件解释 `biome.json` 里**每一个被关闭或放宽的规则**及其理由。
biome 配置是严格 JSON（不支持注释），故豁免理由集中记在这里 —— 改配置时请同步本文。

## `suspicious.noExplicitAny: "off"`

**为什么关**：Notion API 的响应结构（`page.properties`、`blocks.children`）形状
**随用户自己的数据库 schema 变化**，在接入官方 SDK 之前无法静态描述。强行标注会引入
大量错误的类型断言（断言本身也是运行时风险），反而降低安全性。

**约束在哪**：`any` 只允许出现在 **IO 边界**——即所有直接接触 Notion API 响应、
pi API 签名、或用户配置 JSON 的文件：

- Notion 响应解析：`src/notion.ts`、`src/properties.ts`、`src/databases.ts`
- 用户配置 JSON：`src/config.ts`（`normalizeConfig` 的历史格式归一）
- pi API / 对话上下文：`src/wizard.ts`、`src/role-mode.ts`、`extensions/pition.ts`
- tool 层：`src/tools/*.ts`（对响应字段取值）

**业务层零 `any`**（当前为 `src/types.ts` / `src/span.ts` / `src/time.ts` / `src/goal.ts` /
`src/role.ts` / `src/scene.ts` / `src/sop.ts` / `src/fields.ts` / `src/context-budget.ts` / `src/boot-ctx.ts`，
全部走 `src/types.ts` 里收窄后的领域类型）。**新增文件时保持这个边界**：
新文件若需触碰外部数据，先想想是否属于上述某一层；不属于就别用 `any`。

## `noNonNullAssertion: "off"`（仅 `test/**`）

测试里 `expect(x).toBeTruthy()` 之后，TypeScript 仍不收窄类型，`!` 是标准做法且不会漏到生产代码。
覆盖范围严格限定在 `test/`（见 `biome.json` 的 `overrides`）。

## 修改豁免时的检查清单

- [ ] 理由仍成立（例如上游 Notion SDK 已接入 → 应改回 `error` 并逐处收窄）
- [ ] 豁免范围是**最小**的（能按目录/文件限定就不要全局关）
- [ ] 本文与 `biome.json` 一致
