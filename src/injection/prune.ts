// tool 足迹裁剪：按场景把不相关 tool 的 `promptGuidelines` 置空。
//
// **只裁文本，不动可调用工具集。** 为什么不能用 `setActiveTools` 做场景门禁：
// 注册期/激活期门禁会把「会话中现配的能力」挡在门外（pition 踩过的最严重的一类 bug）——
// 用户在对话里刚配好库，却因为工厂期判断「没配置」而让 tool 永远不出现。
// 这些 tool 必须始终可调用，但它们的 guideline 文本不必常驻：
// pi 只把 `selectedTools` 里每个 tool 的 guidelines 拼进 rules 层，置空就等于
// 把它从常驻上下文里摘掉，而 tool 的 description 仍在 schema 里随时可查。
export function pruneToolGuidelines(toolGuidelines: Record<string, string[]>, keptTools: string[] | undefined): void {
  if (!keptTools) return;
  for (const name of Object.keys(toolGuidelines)) {
    if (!keptTools.includes(name)) toolGuidelines[name] = [];
  }
}
