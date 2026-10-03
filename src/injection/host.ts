// 宿主能力探测 —— 新扩展最容易踩的**静默故障**就在这里。
//
// pi 的 `sections`（自定义层）与 `toolGuidelines`（按 tool 贡献准则）是 **0.86.0 才有的**：
// 0.85 及以下的 `systemPromptOptions` 没有这两个字段，直接 `opts.sections[name] = ...` 会抛
// TypeError，而 pi 的事件错误边界会把异常吃掉 —— 表现出来的是「每轮静默零注入」：
// 不报错、功能全无、排障时只会误判成「模型不听话」。
//
// 纪律：
//   1. **只做宿主真正支持的注入**。不支持就整体跳过（+ 提示一次），不要「猜测性创建字段」
//      —— 在旧宿主上凭空造出来的 sections 不会被渲染，只会让排障更难。
//   2. 每轮探测一次、所有写入走同一个出口，不要在 handler 里到处 `if (opts.sections)`。
import { MIN_PI_FOR_STRUCTURED } from "./version.ts";

/** pi 的 systemPromptOptions 里与本内核相关的那几个字段（形状容错：都可能不存在） */
export interface SystemPromptOptionsLike {
  promptGuidelines?: unknown;
  sections?: unknown;
  toolGuidelines?: unknown;
}

/**
 * 宿主是否支持结构化注入（sections + toolGuidelines）。
 *
 * 判定依据是**字段存在性**而不是版本号：扩展拿不到可靠的宿主版本，
 * 但拿得到 pi 归一化后的 options 对象——它有什么就用什么。
 */
export function supportsStructuredInjection(opts: SystemPromptOptionsLike | undefined | null): boolean {
  if (!opts) return false;
  return typeof opts.sections === "object" && opts.sections !== null && Array.isArray(opts.promptGuidelines);
}

/** 自定义层 sections；宿主不支持时返回 null（调用方据此整体跳过结构化注入） */
export function structuredSections(opts: SystemPromptOptionsLike | undefined | null): Record<string, string> | null {
  if (!opts || !supportsStructuredInjection(opts)) return null;
  return opts.sections as Record<string, string>;
}

/** rules 层 guideline 数组（追加用）；缺失时返回 null */
export function structuredGuidelines(opts: SystemPromptOptionsLike | undefined | null): string[] | null {
  if (!opts) return null;
  return Array.isArray(opts.promptGuidelines) ? (opts.promptGuidelines as string[]) : null;
}

/** tool 足迹裁剪用；宿主没有这个字段就返回 null（不去创建它） */
export function structuredToolGuidelines(
  opts: SystemPromptOptionsLike | undefined | null,
): Record<string, string[]> | null {
  if (!opts || !supportsStructuredInjection(opts)) return null;
  const tg = opts.toolGuidelines;
  return typeof tg === "object" && tg !== null ? (tg as Record<string, string[]>) : null;
}

/** pi ExtensionAPI 的最小结构契约（本内核只用到 `on`） */
export interface InjectionHost {
  on(event: string, handler: (event: any, ctx?: any) => void | Promise<void>): void;
}

/** 宿主缺 sections 时的默认提示（扩展可用 `unsupportedNotice` 覆盖） */
export function unsupportedInjectionNotice(name: string, minVersion: string = MIN_PI_FOR_STRUCTURED): string {
  return (
    `${name} 需要 pi ≥ ${minVersion} 才支持分层注入（当前宿主的 systemPromptOptions 缺 sections）——` +
    `升级 pi 后分层注入才会生效；工具调用本身仍然可用。`
  );
}
