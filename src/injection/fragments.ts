// 状态驱动的片段 —— 「动态提示词」的落点。
//
// 反面教材：**剧本写成常量长文**。那样必然一半内容是当下不成立的
// （对已经建好的目标还在教怎么 set），也没法带出「下一项该做什么」这种派生事实。
// 注入内容必须是 `f(本轮状态)`：剧本退化成**带条件的片段**，不成立的分支根本不出现。
//
// 三条纪律：
//   1. `when` 只从状态快照取值（状态是纯函数产物，可测、可复现）
//   2. `text` 写成函数以便插入真实数字/名称 —— 模型看到「2/4 轮」比看到「按进度推进」有用得多
//   3. 片段提到的 tool 必须在该场景的 `tools` 白名单里（否则模型按片段调一个
//      guideline 已被裁掉的 tool）——一致性校验要写进测试

/** 一个条件片段 */
export interface Fragment<S> {
  /** 片段 id（测试、预算台账、排障时用来定位「这段为什么出现了」） */
  id: string;
  /** 出现条件；缺省 = 场景命中就出现 */
  when?: (s: S) => boolean;
  /** 文案；写成函数以插入真实数字 */
  text: string | ((s: S) => string);
}

/** 一个场景：开场行 + 条件片段 + 该场景保留 guideline 的 tool */
export interface Scene<S> {
  id: string;
  /** 人类可读标题（排障/台账用） */
  title?: string;
  /** 开场行：场景命中即注入，一句话点明本轮姿态 */
  opening?: string;
  fragments: Fragment<S>[];
  /** 保留 promptGuidelines 的 tool 名；undefined = 不裁剪（全保留） */
  tools?: string[];
}

/** 本轮真正会出现的片段 id（排障/台账用：一眼看出「为什么注入了这段」） */
export function activeFragmentIds<S>(scene: Scene<S>, state: S): string[] {
  return scene.fragments.filter((f) => !f.when || f.when(state)).map((f) => f.id);
}

/** 解析一个片段的文案（text 是函数时**只在 when 成立的状态下**调用） */
export function renderFragment<S>(fragment: Fragment<S>, state: S): string {
  return typeof fragment.text === "function" ? fragment.text(state) : fragment.text;
}

/**
 * 渲染场景正文：开场行 + 命中片段（默认 `- ` 子弹）。
 * 没有任何内容时返回空串（调用方以空判跳过注入）。
 */
export function renderSceneBody<S>(scene: Scene<S>, state: S, opts: { bullet?: string } = {}): string {
  const bullet = opts.bullet ?? "- ";
  const lines = scene.fragments
    .filter((f) => !f.when || f.when(state))
    .map((f) => `${bullet}${renderFragment(f, state)}`);
  if (!scene.opening && !lines.length) return "";
  return [scene.opening ?? "", ...lines].filter(Boolean).join("\n");
}
