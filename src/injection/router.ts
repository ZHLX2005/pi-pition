// 场景路由：把「用户这一句话」判成一个场景 id，决定这轮注入哪套剧本。
//
// 两条设计原则（缺一条都会退化成静态注入）：
//   1. **优先级固定**：`signals` 的数组顺序即优先级，同句多命中时取更靠前的
//      （「今天完成了 3 组俯卧撑」同时命中记录与锻炼 → 取锻炼）
//   2. **粘性**：低信息量消息（「好」「继续」「嗯」）继承上一场景 —— 一轮对话里用户
//      不会每句都重复关键词，粘性让场景跟着**话题**走而不是跟着**关键词**走
//
// 纪律：路由**不读配置**。配置状态属于事实层（恒定层），不该反过来影响路由
// ——否则「未绑定库」时连锻炼目标也会被判成配置场景。

export interface SceneSignal<Id> {
  id: Id;
  /** 命中即路由到该场景 */
  re: RegExp;
}

export interface RouterOptions<Id> {
  /** 按优先级排列的信号 */
  signals: SceneSignal<Id>[];
  /** 无命中时的兜底场景 */
  fallback: Id;
  /**
   * 低信息量判定（命中则沿用上一场景）。
   * 缺省：空串或 ≤3 字符（不含换行）。中文扩展请传一个语气词正则。
   */
  lowInfo?: (prompt: string) => boolean;
}

/**
 * 低信息量：空白、可选正则命中、或 ≤3 字符。
 * @param extraRe 扩展自己的语气词表（「好」「嗯」「继续」……）
 */
export function isLowInfo(prompt: string, extraRe?: RegExp): boolean {
  const t = prompt.trim();
  if (!t) return true;
  if (extraRe?.test(t)) return true;
  return t.length <= 3;
}

/** 造一个路由函数（纯函数：同输入必得同输出，可单测、可进预算台账） */
export function createRouter<Id>(opts: RouterOptions<Id>): (prompt: string, prev?: Id) => Id {
  const lowInfo = opts.lowInfo ?? ((p: string) => isLowInfo(p));
  return (prompt: string, prev?: Id): Id => {
    const text = String(prompt ?? "");
    for (const signal of opts.signals) {
      if (signal.re.test(text)) return signal.id;
    }
    if (lowInfo(text)) return prev ?? opts.fallback;
    return opts.fallback;
  };
}
