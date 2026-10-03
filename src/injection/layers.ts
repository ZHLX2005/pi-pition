// 分层装配 —— 把「这一轮要注入的 section」按**变化频率**分层。
//
// 为什么要分层：pi 每轮对自定义层做 diff，同一 section 内容变了就要重刷 prompt cache。
// 把「恒定」和「每轮都变」的东西挤在一个 section 里，等于让稳定的内容也每轮失效。
// 分段的代价只是一个 section 名。
//
// 典型四层（名字随扩展，频率才是本质）：
//   core    恒定：身份 + 工具索引 + 硬边界                    → 全场景 cache hit
//   scene   场景：按本轮状态装配的剧本片段（见 fragments.ts）  → 切场景才变
//   fields  事实：领域字典（字段名/语义）                      → 切库才变
//   runtime 易变：此刻几点 + 本会话已发生的事 + 上一轮报错      → 每轮变（**必须单独成段**）
//
// 纪律：易变层**只放事实不放建议**（建议归场景片段，两边都写就是重复注入）。
export interface Layer<S> {
  /** section 名（会直接写进 `sections[name]`） */
  name: string;
  /** 出现条件；缺省 = 总是出现 */
  when?: (s: S) => boolean;
  /** 渲染正文；返回空串时调用方应跳过（本函数也会跳过） */
  render: (s: S) => string;
}

/**
 * 按状态装配各层。空正文的层不会出现在结果里 —— 缺失的 section 由 pi 的 diff
 * 自动从上一轮移除，所以「不注入」比「注入空串」正确。
 */
export function assembleLayers<S>(layers: Layer<S>[], state: S): Record<string, string> {
  const out: Record<string, string> = {};
  for (const layer of layers) {
    if (layer.when && !layer.when(state)) continue;
    const text = layer.render(state);
    if (text) out[layer.name] = text;
  }
  return out;
}
