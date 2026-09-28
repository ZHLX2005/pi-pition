// pition — Notion 个人记录助手扩展（nx-as 物化到 pi-agent/extensions/ 的自包含单文件）
//
// nx-as 侧流程：web 面板配置 token → 选库 → 补字段描述 → 写入 pition.config.json
// 本扩展启动时读同目录 pition.config.json，为绑定的 Notion 数据库注册 agent tool：
//   pition_boot        — 元配置：5 阶段渐进式配置（token → 选库 → 补字段说明 → 助理模式开关 → done）
//   pition_write       — 写当前 page 属性 + 追加正文（日常主路径）
//   pition_read        — 读当前 page 完整内容（属性 + 所有正文 block）
//   pition_history     — 显式查 page 列表（翻旧账时用，不是默认心智）
//   pition_create_today— 逃生口：定时任务挂了手动建 page（默认不调）
//   pition_query       — 通用单字段过滤查询（备用）
// 字段说明从 pition_stores 改为：启动时静态渲染进所有运行态 tool 的 description。
// （单一库产品形态：cfg.bindings[0] 是默认；store 参数兼容多库。）
//
// 简单值约定（LLM 只填简单值，本文件负责转 Notion API 格式）：
//   title/rich_text → 字符串；number → 数字；select/multi_select → 选项名字符串（逗号分隔则多选）；
//   checkbox → 布尔；date → "YYYY-MM-DD" 或 ISO；url/email → 字符串
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const NOTION_BASE = "https://api.notion.com";
const NOTION_VERSION = "2022-06-28";

// 可写的 Notion 字段类型（formula/relation/rollup 等计算字段不可写）
const WRITABLE_TYPES = [
  "title", "rich_text", "number", "select", "multi_select",
  "status", "checkbox", "date", "url", "email", "phone_number",
] as const;

interface FieldMeta { type: string; description?: string }
interface Binding {
  dbId: string;
  title: string;
  description?: string;
  fields: Record<string, FieldMeta>;
}
interface PitionConfig {
  token: string;
  // 所有已描述过的库都保留（key = dbId）；切空间/重选时不丢字段 desc
  bindings: Record<string, Binding>;
  // 当前默认操作的库 id（agent 日常 tool 都用这个）；切空间 = 改这个值
  currentBindingId: string | null;
  // 运行时模式（助理模式）开关 — 持久化配置，可被 pition_boot stage=set_mode 或 /pition-mode 切换
  // 缺省 = false（首次装完不会被自动注入；agent 主动开启后才注入）
  _assistantMode?: boolean;
  // 当前进行中的 span（单数）。start 时落盘，end 后置 null。
  // 跨重启保留——agent reload 也能记得「我还在跑步」。
  _activeSpan?: ActiveSpan | null;
}

interface ActiveSpan {
  spanId: string;            // ulid-ish，唯一 id
  eventName: string;         // "开会"、"跑步"、"午休"
  note?: string;             // 备注（如 "和 x 团队对齐排期"）
  startedAt: string;         // ISO 字符串
  lastHeartbeatAt: string;   // ISO 字符串，end 时检查时长用
}

// 配置定位：扩展文件所在目录 → 其父目录（包形式安装时配置在包根）
function configPath(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [dir, dirname(dir)]) {
    try {
      readFileSync(join(candidate, "pition.config.json"), "utf8");
      return join(candidate, "pition.config.json");
    } catch {
      // 试下一个
    }
  }
  return join(dirname(dir), "pition.config.json"); // 都不存在 → 默认写包根
}

function loadConfig(): PitionConfig | null {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8")) as any;
    if (!raw.token || typeof raw.token !== "string") return null;
    // 兼容老格式：bindings: [b, c, ...] → bindings: { [b.dbId]: b, ... }
    let bindings: Record<string, Binding> = {};
    if (raw.bindings && typeof raw.bindings === "object" && !Array.isArray(raw.bindings)) {
      bindings = raw.bindings;
    } else if (Array.isArray(raw.bindings)) {
      for (const b of raw.bindings) if (b?.dbId) bindings[b.dbId] = b;
    }
    // 兼容老格式：binding: {...} → bindings: { [id]: b }; currentBindingId 同步
    if (raw.binding && typeof raw.binding === "object" && raw.binding.dbId && !bindings[raw.binding.dbId]) {
      bindings[raw.binding.dbId] = raw.binding;
    }
    // currentBindingId 兼容：缺省取 bindings 里第一个
    let currentBindingId: string | null = raw.currentBindingId ?? null;
    if (!currentBindingId || !bindings[currentBindingId]) {
      currentBindingId = Object.keys(bindings)[0] ?? null;
    }
    return { token: raw.token, bindings, currentBindingId, _assistantMode: raw._assistantMode };
  } catch {
    // 无配置或非法 JSON
  }
  return null;
}

function saveConfig(cfg: PitionConfig): void {
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

// Notion HTTP 调用：网络层抗抖动（指数退避），HTTP 层不重试（4xx/5xx 让 Notion 自己说）
// 解决"国内到 api.notion.com 链路抖动 ~25% 丢包 → pi 进程内 keep-alive 连接被 RST 后 fetch 直接抛 'fetch failed'"
const NETWORK_ERR_PATTERNS = [
  "fetch failed",        // Node 18+ undici 网络层
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ECONNREFUSED",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
];
const RETRY_DELAYS_MS = [500, 1500, 4500]; // 3 次尝试：首次 + 2 次退避重试

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true; // 超时也按网络错误处理
  return NETWORK_ERR_PATTERNS.some((p) => err.message.includes(p));
}

async function fetchNotion(method: string, path: string, body: unknown, headers: Record<string, string>): Promise<Response> {
  const url = NOTION_BASE + path;
  const payload = body ? JSON.stringify(body) : undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    // 每次重试都强制新连接（5s 超时，避免 Node 复用死掉的 keep-alive socket）
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    try {
      return await fetch(url, { method, headers: body ? headers : { ...headers, "Connection": "close" }, body: payload, signal: ac.signal });
    } catch (e) {
      lastErr = e;
      if (!isNetworkError(e)) throw e; // 非网络错（如 AbortError 非超时）直接抛
      if (attempt === RETRY_DELAYS_MS.length) break; // 3 次都网络错 → 退出循环抛错
      const wait = RETRY_DELAYS_MS[attempt];
      console.warn(`[pition] ${method} ${path} 网络层失败 (第 ${attempt + 1} 次)：${(e as Error).message}；${wait}ms 后重试`);
      await new Promise((r) => setTimeout(r, wait));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// 用给定 token 调 Notion（与 tools 用的 notion() 分开：向导要用未保存的 token 试连）
async function notionWith(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetchNotion(method, path, body, {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json as { code?: string; message?: string };
    throw new Error(`Notion ${method} ${path} → ${res.status} ${err.code || ""}: ${err.message || "未知错误"}`);
  }
  return json;
}

async function notion(cfg: PitionConfig | null, method: string, path: string, body?: unknown): Promise<any> {
  // 兜底：cfg 缺失时再 loadConfig 一次（防御性，应已由 currentBinding() 之前保证）
  const real = cfg ?? loadConfig();
  if (!real) throw new Error("pition 未配置（没有 pition.config.json）");
  const res = await fetchNotion(method, path, body, {
    Authorization: `Bearer ${real.token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json as { code?: string; message?: string };
    throw new Error(`Notion ${method} ${path} → ${res.status} ${err.code || ""}: ${err.message || "未知错误"}`);
  }
  return json;
}

// ---- 简单值 → Notion property 格式 ----

function toNotionProperty(type: string, value: any): any {
  switch (type) {
    case "title":
      return { title: [{ text: { content: String(value) } }] };
    case "rich_text":
      return { rich_text: [{ text: { content: String(value) } }] };
    case "number":
      return { number: Number(value) };
    case "select":
      return { select: { name: String(value) } };
    case "multi_select": {
      const names = Array.isArray(value) ? value : String(value).split(/[,，]/).map((s: string) => s.trim()).filter(Boolean);
      return { multi_select: names.map((name: string) => ({ name })) };
    }
    case "status":
      return { status: { name: String(value) } };
    case "checkbox":
      return { checkbox: Boolean(value) };
    case "date":
      return { date: { start: String(value) } };
    case "url":
      return { url: String(value) };
    case "email":
      return { email: String(value) };
    case "phone_number":
      return { phone_number: String(value) };
    default:
      throw new Error(`暂不支持的字段类型: ${type}（请用面板调整该字段的用途或移除）`);
  }
}

function buildProperties(binding: Binding, entries: Array<{ name: string; value: unknown }>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const { name, value } of entries) {
    const meta = binding.fields[name];
    const type = meta?.type;
    if (!type) throw new Error(`存储「${binding.title}」没有字段「${name}」。可用字段: ${Object.keys(binding.fields).join("、")}`);
    out[name] = toNotionProperty(type, value);
  }
  return out;
}

// 把 page 上现有 properties 渲染成"按字段名 → 标量"的快照，给 merge 用。
// 写入前 read 一次 page（多 1 次 HTTP），避免每次合并都重复结构解析。
function readPageProperties(binding: Binding, pageProps: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(pageProps || {})) {
    const anyProp = prop as any;
    if (anyProp.title) out[name] = anyProp.title.map((t: any) => t.plain_text).join("");
    else if (anyProp.rich_text) out[name] = anyProp.rich_text.map((t: any) => t.plain_text).join("");
    else if (anyProp.select) out[name] = anyProp.select?.name ?? null;
    else if (anyProp.multi_select) out[name] = anyProp.multi_select.map((o: any) => o.name);
    else if (anyProp.checkbox !== undefined) out[name] = anyProp.checkbox;
    else if (anyProp.number !== undefined) out[name] = anyProp.number;
    else if (anyProp.date) out[name] = anyProp.date?.start ?? null;
    else if (anyProp.status) out[name] = anyProp.status?.name ?? null;
  }
  return out;
}

// 把 value 按字段类型合并到 current 上：返回新值（或重算）。
// overwrite=true：直接用新值（不读 current）。
// overwrite=false/缺省：按类型 append 合并。
// title / url / email / phone_number / select / status：单值字段，覆盖语义（append 没意义）。
// multi_select / rich_text / number / date / checkbox：append 语义。
function mergePropertyValue(type: string, current: unknown, next: unknown, overwrite: boolean): unknown {
  if (overwrite) return next;
  if (current === undefined || current === null || current === "") return next; // 没旧值就当首次写
  switch (type) {
    case "multi_select": {
      const cur = Array.isArray(current) ? current as string[] : [];
      const nxt = Array.isArray(next) ? next as string[] : [String(next)];
      return Array.from(new Set([...cur, ...nxt])); // union
    }
    case "rich_text": {
      return `${current} / ${String(next)}`;
    }
    case "number": {
      const a = Number(current) || 0;
      const b = Number(next) || 0;
      return a + b;
    }
    case "date": {
      // date 取更早
      const a = String(current);
      const b = String(next);
      return a < b ? a : b;
    }
    case "checkbox": {
      return Boolean(current) || Boolean(next);
    }
    // 单值字段 append 语义无意义，直接覆盖
    default:
      return next;
  }
}

// 在现有 properties 上做 entries 列表的合并，返回 Notion API 形态。
// 必须传入已读出的 currentSnapshot（来自 readPageProperties(pageProps)）
function mergeProperties(
  binding: Binding,
  currentSnapshot: Record<string, unknown>,
  entries: Array<{ name: string; value: unknown; overwrite?: boolean }>,
): Record<string, any> {
  const out: Record<string, any> = {};
  for (const { name, value, overwrite } of entries) {
    const meta = binding.fields[name];
    const type = meta?.type;
    if (!type) throw new Error(`存储「${binding.title}」没有字段「${name}」。可用字段: ${Object.keys(binding.fields).join("、")}`);
    const merged = mergePropertyValue(type, currentSnapshot[name], value, !!overwrite);
    out[name] = toNotionProperty(type, merged);
  }
  return out;
}

// ---- 时间戳工具 ----
// 模型看不到事件发生瞬间；程序可以从 new Date() 拿到当前时间。
// 粒度：[HH:MM] 本地时间（用户选定时分粒度）；跨日由 Notion 自带 last_edited_time 区分。

/** 接受 ISO 字符串 / Date / 数字 / undefined，产出 Date 对象（无效输入抛错） */
function toDate(input: string | number | Date | undefined, fieldName = "timestamp"): Date {
  if (input === undefined) return new Date();
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) throw new Error(`${fieldName} 不是合法时间：${String(input)}`);
  return d;
}

/** Date → "[HH:MM]"（本地时区；补零） */
function clockPrefix(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `[${hh}:${mm}]`;
}

/** 给正文每段加 [HH:MM] 前缀；空段不变；保留 \n\n 段分隔语义 */
function prefixClockToContent(content: string, when: Date): string {
  const prefix = clockPrefix(when);
  return content
    .split(/\n{2,}/)
    .map((para) => (para.trim() ? `${prefix} ${para}` : content))
    .join("\n\n");
}

/** 把 YYYY-MM-DD 写到 properties 里 type=date 的字段——agent 没传 date 时回退到 timestamp */
function autoFillDateProperty(
  binding: Binding,
  entries: Array<{ name: string; value: unknown }>,
  when: Date,
): Array<{ name: string; value: unknown }> {
  const ymd = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`;
  const dateFields = Object.entries(binding.fields)
    .filter(([, m]) => m.type === "date")
    .map(([n]) => n);
  if (!dateFields.length) return entries;
  const supplied = new Set(entries.map((e) => e.name));
  const filled = [...entries];
  for (const n of dateFields) {
    if (!supplied.has(n)) filled.push({ name: n, value: ymd });
  }
  return filled;
}

// properties 参数 schema：用 [{name, value, overwrite}] 数组对而不是 Record——
// 部分 provider（实测 MiniMax）对 Record 形态的嵌套对象参数解析不稳，
// 数组对是最朴素的结构，所有模型都能正确构造
// overwrite 默认 false=append 合并（按字段类型）；true=整段覆盖。
const PROPERTY_ENTRY = Type.Object({
  name: Type.String({ description: `字段名（必须与下列字段之一完全一致）` }),
  value: Type.Union([Type.String(), Type.Number(), Type.Boolean()], {
    description: "字段值：文本/数字/布尔（类型见 tool description 里的字段说明）",
  }),
  overwrite: Type.Optional(Type.Boolean({ description: "默认 false=append 合并：multi_select union 选项、rich_text 拼接「原值 / 新值」、number 累加、date 取更早、checkbox 取 OR；true=整段覆盖。title/select/status/url/email/phone_number 单值字段此参数被忽略，永远是新值。" })),
}, { description: "一个字段" });

// ---- 字段说明文本（LLM 看的）----

function fieldsDoc(binding: Binding): string {
  return Object.entries(binding.fields)
    .map(([name, meta]) => {
      const desc = meta.description ? ` — ${meta.description}` : "";
      return `  - ${name} (${meta.type})${desc}`;
    })
    .join("\n");
}

const QUERY_FILTER_SCHEMA = Type.Object({
  field: Type.String({ description: "字段名（必须是该存储已有字段）" }),
  op: Type.Union([Type.Literal("equals"), Type.Literal("contains")], { description: "equals=精确匹配，contains=文本包含" }),
  value: Type.Union([Type.String(), Type.Boolean(), Type.Number()], { description: "比较值（checkbox 用布尔，其余用字符串）" }),
}, { description: "可选过滤条件（单条件）" });

// ============================================================================
// 启动模式：把整个 pi agent 变成 pition 个人管理助手
// 在 before_agent_start 阶段向 systemPromptOptions 注入：
//   - promptGuidelines：行为准则（append 到默认 guideline 后，保留 cache prefix）
//   - sections.pition_role：自定义区段，模型按结构化区段识别
// 不使用 forceSystemPrompt —— 会导致整段替换、prompt cache miss。
// ============================================================================

interface RoleState {
  enabled: boolean;
  cfg: PitionConfig | null;
}

function buildRoleInjections(cfg: PitionConfig): { guidelines: string[]; sections: Record<string, string> } {
  const binding = cfg.currentBindingId ? cfg.bindings[cfg.currentBindingId] : null;
  const storeLabel = binding ? `【${binding.title}】${binding.description ? ` — ${binding.description}` : ""}` : "（未绑定）";
  const guidelines: string[] = [
    // ——边界判断（先看）——
    "你是 pition 个人管理助手，但 **不要无脑自动调 pition_write**。每次用户发言，先判断这一类才落库：「明确的时间锚定（今天/刚才/3 点）+ 具体内容（做了什么/吃了什么/见了谁/花了多少/心情如何/感悟什么）」。",
    "**情绪/心情/思想感悟/感受/反思是事实事件，要记**——比如「今天心情不错」「刚才焦虑了一下」「突然悟到一个道理」「觉得这个项目太烂」。这类用户是在主动交付内容，不要因为「不是事实陈述」就漏掉。",
    "**真正不该调**的：闲聊/纯问答/调试代码/解释概念/与记录无关的纯讨论——只有这几类。",
    "用户明确说「记一下/记下来/记到 pition」**才**强制落库；用户没明确表态时，agent 自作主张落库要先在回复里点一句「我刚记到【库名】了」让用户能立刻否决。",
    "落库优先级：默认走 pition_write 写当前 page；pition_write 返回「当前库还没 page」时才调 pition_create_today 手动建一条（通常是定时任务挂了）。",
    // ——读取/查询决策——
    "用户问「今天写了什么/刚才记了什么」调 pition_read；用户翻旧账（「上个月/上周/去年」）才调 pition_history；日常不要主动列 page 列表。",
    "字段名/取值不清楚看 tool description（启动时已从配置渲染进各 tool 描述）；不要凭空猜。",
    // ——交互收尾——
    "写入完成后简短复述：「记到【库名】了」+ 页面 URL。",
  ];
  const sections: Record<string, string> = {
    pition_role:
      `你是 pition 个人管理助手。用户的对话是你的「输入来源」，绑定的 Notion 库是你的「持久化存储」。\n\n` +
      `当前库：${storeLabel}。\n\n` +
      `可用工具（按使用频率排序）：\n` +
      `- pition_write（主路径）：改当前 page 属性 + 追加正文\n` +
      `- pition_read：读当前 page 完整内容（属性 + 所有正文 block）\n` +
      `- pition_create_today（逃生口）：定时任务挂了自己手动建 page，默认不调\n` +
      `- pition_history（翻旧账）：列 page 列表，仅在显式翻历史时调\n` +
      `- pition_query（备用）：通用单字段过滤查询\n\n` +
      `字段说明已启动时注入到各 tool description 里——无需额外查询。\n\n` +
      `核心行为准则：\n` +
      `- **触发判断**：明确的时间锚定 + 具体内容（做了什么/吃了什么/心情如何/感悟什么）就落库\n` +
      `- **情绪/心情/思想感悟/感受/反思都是事实事件，要记**——用户是在主动交付内容\n` +
      `- **真正不该调**的：闲聊/纯问答/调试代码/解释概念/与记录无关的纯讨论\n` +
      `- **触发确认**：用户没明确说「记一下」时，落完要点一句「我刚记到【库名】了」让用户能立刻否决\n` +
      `- **默认走 pition_write**（追加当日条目）；写失败才考虑 pition_create_today\n` +
      `- 字段名/取值不清楚就直接看各 tool 的 description（已注入字段说明）\n` +
      `- 不要主动列 page 列表——page 心智对日常记录透明\n\n` +
      `反例（不该调 write 的）：\n` +
      `- 「今天心情不错」→ **要记**（情绪是事实事件）\n` +
      `- 「刚才焦虑了一下」→ **要记**\n` +
      `- 「突然悟到一个道理」→ **要记**（思想感悟）\n` +
      `- 「这个项目太烂」→ **要记**（感受）\n\n` +
      `正例（不该调 write 的）：\n` +
      `- 「你觉得 x 怎么样」→ 不记，纯问答\n` +
      `- 「这段代码报错」→ 不记，调试代码\n` +
      `- 「解释一下什么是 x」→ 不记，概念解释\n` +
      `- 「今天去超市了吗」→ 不记，是询问而非陈述`,
  };
  return { guidelines, sections };
}

// 运行态 span 解析器：每次 before_agent_start 都重新 loadConfig 拿 _activeSpan。
// 必须放在 registerRoleMode 之前 —— jiti 转 ESM 后闭包内对模块顶层函数的引用在
// async handler emit 阶段才真正求值，hoist 在异步链下不可靠（踩过 ReferenceError）。
function currentSpan(): ActiveSpan | null {
  const cfg = loadConfig();
  return cfg?._activeSpan ?? null;
}

// 把 span 渲染成 1-3 行"全局上下文"文案，注入到 before_agent_start。
// 例：📍 进行中：跑步（公园跑步 5 公里），已 28 分钟（最近心跳 23 分钟前）
function renderSpanStatus(span: ActiveSpan, now: Date): string {
  const started = new Date(span.startedAt).getTime();
  const lastBeat = new Date(span.lastHeartbeatAt).getTime();
  const elapsedMin = Math.max(0, Math.round((now.getTime() - started) / 60000));
  const sinceLastBeatMin = Math.max(0, Math.round((now.getTime() - lastBeat) / 60000));
  const noteSuffix = span.note ? `（${span.note}）` : "";
  return `📍 进行中：${span.eventName}${noteSuffix}，已 ${elapsedMin} 分钟（最近心跳 ${sinceLastBeatMin} 分钟前）。\n   若完成：调 pition_span action=end；若仍在继续：action=heartbeat（建议每 10-15 分钟一次）。`;
}

function registerRoleMode(pi: ExtensionAPI, state: RoleState): void {
  // 每次模型请求前注入（条件：开关 + 有配置）
  pi.on("before_agent_start", async (event) => {
    // 1) 助理模式注入（角色定位 + 行为准则）—— 条件：开关 + 有当前库
    if (state.enabled && state.cfg && state.cfg.currentBindingId && state.cfg.bindings[state.cfg.currentBindingId]) {
      const { guidelines, sections } = buildRoleInjections(state.cfg);
      for (const g of guidelines) event.systemPromptOptions.promptGuidelines.push(g);
      for (const [name, content] of Object.entries(sections)) {
        event.systemPromptOptions.sections[name] = content;
      }
    }
    // 2) 进行中 span 上下文注入 —— 独立于助理模式（即使助理模式关，span 状态也要可见）
    const span = currentSpan();
    if (span) {
      event.systemPromptOptions.sections["pition_span"] = renderSpanStatus(span, new Date());
    }
  });

  // 切换开关（落盘化：等价于 pition_boot stage=set_mode 不带 enabled 参数的 toggle 行为）
  pi.registerCommand("pition-mode", {
    description: "切换 pition 启动助手模式（开：每次请求把整个 agent 当个人管理助手；关：恢复默认 pi 行为）",
    handler: async (_args, ctx) => {
      const cur = loadConfig();
      const next = !(cur?._assistantMode ?? false);
      const updated: PitionConfig = { token: cur?.token ?? "", bindings: cur?.bindings ?? [], _assistantMode: next };
      try {
        saveConfig(updated);
      } catch (e) {
        ctx.ui.notify(`写入配置失败: ${(e as Error).message}`, "error");
        return;
      }
      state.enabled = next;
      state.cfg = updated;
      ctx.ui.notify(
        `pition 启动助手模式：${next ? "已开启（每次模型请求会注入个人管理助手定位）" : "已关闭（恢复默认 pi 行为）"}（已落盘，重启 pi 保留）`,
        "info",
      );
    },
  });
}

export default function pitionExtension(pi: ExtensionAPI) {
  // 设置命令始终注册——没有配置时这是进入向导的唯一入口
  registerSetupCommand(pi);

  // 启动助手模式：每次模型请求前注入「pition 个人管理助手」定位与行为准则。
  // 默认关闭（首次装完不会被自动注入）；agent 通过 pition_boot stage=set_mode 或 /pition-mode 开启；
  // 配置 _assistantMode=true 后启动即生效；session_start 重读保证 reload 后即时生效。
  const initialCfg = loadConfig();
  const roleState: RoleState = { enabled: !!(initialCfg?._assistantMode ?? false), cfg: initialCfg };
  registerRoleMode(pi, roleState);

  // session_start / reload 时重读配置（向导保存后无需重启；同时刷新 enabled）
  pi.on("session_start", async () => {
    const fresh = loadConfig();
    roleState.cfg = fresh;
    roleState.enabled = !!(fresh?._assistantMode ?? false);
  });

  // boot tool 需要即时改 enabled（无需重启）；暴露 setter 给它
  const setRoleMode = (next: boolean) => {
    roleState.enabled = next;
    roleState.cfg = loadConfig();
  };

  // 启动时拼装 boot_ctx 描述：注入当前 token / 绑定库 / 助理模式状态——
  // agent 第一次看到 boot 工具描述就知道现状，不必先 ping stage=done
  const initialForBoot = roleState.cfg;
  const initBinding = initialForBoot?.currentBindingId ? initialForBoot.bindings[initialForBoot.currentBindingId] : null;
  const initCoverage = initBinding ? `${Object.values(initBinding.fields).filter((f) => f.description).length}/${Object.keys(initBinding.fields).length}` : null;
  const bootCtx =
    `\n\n当前状态：\n` +
    `- token: ${initialForBoot?.token ? `已落盘（${initialForBoot.token.slice(0, 8)}...${initialForBoot.token.slice(-4)}）` : "未设置"}` +
    `\n- 库：${initBinding ? `已绑定「${initBinding.title}」${initBinding.description ? `（${initBinding.description}）` : ""}，字段覆盖率 ${initCoverage}` : "未绑定"}` +
    `\n- 助理模式：${initialForBoot?._assistantMode ? "开" : "关"}`;

  // ---------- pition_boot（无条件注册：未配置也能跑 stage=token）----------
  // 引导态的统一入口。设计契约见 references/A01-设计理念.md
  // 阶段：token → 选库 → 加载字段（自动）→ 补字段说明 → 助理模式开关
  // 任意阶段可中断；已落盘的状态在下一次调用时由 stage 参数定位断点
  pi.registerTool({
    name: "pition_boot",
    label: "Pition 元配置（boot）",
    description: `pition 的引导态统一入口：分阶段配置 Notion 集成。5 个阶段 — stage=token 校验并落盘 token；stage=select_db 列库让用户选一个（切空间会保留所有已描述库的字段 desc）；stage=describe_fields 列字段让用户填 description；stage=set_mode 切换助理模式；stage=done 返回当前已绑定库 + 助理模式。${bootCtx}`,
    promptGuidelines: [
      "不确定当前 pition 配置状态时，**直接看本 tool 的 description 里的「当前状态」段**——已含 token / 库 / 助理模式三件概况，不必先 ping stage=done。",
      "用户首次使用 pition 时，按 done → token（已有 token 则跳过）→ select_db → describe_fields → set_mode → done 顺序推进。",
      "用户只改某一阶段的产物时，直接调对应 stage（不必从 token 重走）。",
      "切空间（换库）调 stage=select_db 重新选，**之前库的字段 desc 不会丢**，会在 settings 里自动按 dbId 保留。",
      "boot 完成后，用户的实际写入意图应走 pition_write/pition_read/pition_history/pition_query，不要再用 pition_boot。",
    ],
    parameters: Type.Object({
      stage: Type.Union([
        Type.Literal("token"),
        Type.Literal("select_db"),
        Type.Literal("describe_fields"),
        Type.Literal("set_mode"),
        Type.Literal("done"),
      ], { description: "当前推进到的阶段：token=登录校验；select_db=选库（切空间）；describe_fields=补当前库的字段 description；set_mode=切换助理模式；done=查询当前状态" }),
      token: Type.Optional(Type.String({ description: "stage=token 时传入 ntn_...；其它阶段忽略" })),
      dbId: Type.Optional(Type.String({ description: "stage=select_db 时选定的库 id；stage=describe_fields 必传（要编辑的库 id）；stage=done 可选传 dbId 查指定库覆盖率" })),
      fieldDescriptions: Type.Optional(Type.Array(Type.Object({
        name: Type.String({ description: "字段名（与库 schema 一致）" }),
        description: Type.String({ description: "该字段的用途说明（给 agent 看）" }),
      }), { description: "stage=describe_fields 时一次性提交所有字段的 description" })),
      bindingDescription: Type.Optional(Type.String({ description: "stage=describe_fields 时设置当前库的用途说明" })),
      bindingTitle: Type.Optional(Type.String({ description: "可选：覆盖库在 agent 眼中的存储名（默认用 Notion 原标题）" })),
      enabled: Type.Optional(Type.Boolean({ description: "stage=set_mode 时强制设置助理模式开关；缺省或 stage=done 时忽略" })),
    }),
    async execute(_id, params) {
      const cfgNow = loadConfig() ?? { token: "", bindings: {}, currentBindingId: null };

      if (params.stage === "token") {
        const existingToken = cfgNow.token || "";
        if (params.token) {
          const t = params.token.trim();
          if (!t) throw new Error("token 不能为空");
          try {
            await notionWith(t, "GET", "/v1/users/me");
          } catch (e) {
            throw new Error(`token 无效: ${(e as Error).message}`);
          }
          saveConfig({ ...cfgNow, token: t });
          const bindingsCount = Object.keys(cfgNow.bindings).length;
          return {
            content: [{ type: "text", text: `token 已替换并落盘（已绑定 ${bindingsCount} 个库）。下一步：stage=select_db 列库选择。` }],
            details: { stage: "token", action: "replaced", bindings: bindingsCount },
          };
        }
        if (existingToken) {
          const masked = `${existingToken.slice(0, 8)}...${existingToken.slice(-4)}`;
          let dbCount = 0;
          try { dbCount = (await listDatabases(existingToken)).length; } catch { /* token 失效不致命 */ }
          const bindingsCount = Object.keys(cfgNow.bindings).length;
          return {
            content: [{ type: "text", text: `pition.config.json 已落盘 token（${masked}），无需重传。可访问库数：${dbCount}（0=token 失效或没把库「连接」到这个 integration）。\n\n下一步：\n- 当前库: ${cfgNow.currentBindingId ? cfgNow.bindings[cfgNow.currentBindingId].title : "（未选）"} → 调 stage=describe_fields 或 stage=done 查看/补字段说明\n- 切空间/换库 → stage=select_db（之前所有库的字段 desc 按 dbId 保留，不丢）\n- 换 token → 再调 stage=token 时显式传新 token 参数\n- 助理模式开关 → stage=set_mode` }],
            details: { stage: "token", action: "already_set", tokenSet: true, tokenMasked: masked, accessibleDbs: dbCount, bindings: bindingsCount },
          };
        }
        throw new Error("stage=token 必须传 token（pition.config.json 没有现存 token）。请用户提供 ntn_... 格式的 Notion integration token。");
      }

      if (params.stage === "select_db") {
        const token = cfgNow.token;
        if (!token) throw new Error("尚未落盘 token，请先 stage=token");
        const dbs = await listDatabases(token);
        if (!dbs.length) throw new Error("该 token 看不到任何库——请在 Notion 里把目标库「连接」到这个 integration 后重试");
        // 一次性绑定/切换：用户/agent 选定后下一次调用 stage=describe_fields 时带 dbId
        if (!params.dbId) {
          const list = dbs.map((d) => ({
            id: d.id, title: d.title, fieldCount: d.fieldCount,
            known: !!cfgNow.bindings[d.id],
            currentDescription: cfgNow.bindings[d.id] ? `${Object.values(cfgNow.bindings[d.id].fields).filter((f) => f.description).length}/${Object.keys(cfgNow.bindings[d.id].fields).length}` : null,
          }));
          return {
            content: [{ type: "text", text: `可选库 ${list.length} 个:\n` + list.map((d) => `  - ${d.title} (id=${d.id}, ${d.fieldCount} 字段)${d.known ? ` [已描述过：字段覆盖率 ${d.currentDescription}]` : " [未描述]"}`).join("\n") + `\n\n下一步：选定库后调 pition_boot stage=describe_fields dbId=<id> fieldDescriptions=[{name,description},...]\n或直接 pition_boot stage=describe_fields dbId=<id>（会接管现有 desc）。` }],
            details: { stage: "select_db", databases: list },
          };
        }
        // 显式传 dbId：直接接管（保留已有 desc）+ 切换 currentBindingId
        const dbMeta = await notionWith(token, "GET", `/v1/databases/${params.dbId}`);
        const dbTitle = (dbMeta.title ?? []).map((t: any) => t.plain_text).join("") || "(无标题)";
        const knownFields = cfgNow.bindings[params.dbId]?.fields ?? {};
        const merged: Record<string, FieldMeta> = {};
        for (const [n, p] of Object.entries(dbMeta.properties ?? {})) {
          const type = (p as any).type as string;
          if ((WRITABLE_TYPES as readonly string[]).includes(type)) merged[n] = knownFields[n] ?? { type, description: "" };
        }
        const newBinding: Binding = {
          dbId: params.dbId,
          title: dbTitle,
          description: cfgNow.bindings[params.dbId]?.description ?? "",
          fields: merged,
        };
        const bindings = { ...cfgNow.bindings, [params.dbId]: newBinding };
        saveConfig({ ...cfgNow, bindings, currentBindingId: params.dbId });
        return {
          content: [{ type: "text", text: `已切换当前库为「${newBinding.title}」（id=${params.dbId}），字段类型已自动加载（${Object.keys(merged).length} 个），description 沿用之前的（无 desc 则空）。下一步：stage=describe_fields 补 description。` }],
          details: { stage: "select_db", bound: true, dbId: params.dbId, title: newBinding.title },
        };
      }

      if (params.stage === "describe_fields") {
        const token = cfgNow.token;
        if (!token) throw new Error("尚未落盘 token，请先 stage=token");
        // 不传 dbId 时默认改当前库
        const targetId = params.dbId ?? cfgNow.currentBindingId;
        if (!targetId) throw new Error("stage=describe_fields 必须传 dbId 或先 stage=select_db 选定当前库");
        const prev = cfgNow.bindings[targetId];
        if (!prev) throw new Error(`库「${targetId}」未在 cfg.bindings 里；先 stage=select_db 选定`);

        if (!params.fieldDescriptions || !params.fieldDescriptions.length) {
          // 不传 fieldDescriptions → 仅显示当前库覆盖率
          const covered = Object.values(prev.fields).filter((f) => f.description).length;
          const total = Object.keys(prev.fields).length;
          return {
            content: [{ type: "text", text: `库「${prev.title}」当前覆盖率 ${covered}/${total}\n  已覆盖: ${Object.entries(prev.fields).filter(([, m]) => m.description).map(([n, m]) => `${n}(${m.type})`).join(", ") || "无"}\n  待补: ${Object.entries(prev.fields).filter(([, m]) => !m.description).map(([n, m]) => `${n}(${m.type})`).join(", ") || "无"}` }],
            details: { stage: "describe_fields", action: "report", dbId: targetId, title: prev.title, coverage: `${covered}/${total}` },
          };
        }

        const validNames = new Set(Object.keys(prev.fields));
        const merged: Record<string, FieldMeta> = { ...prev.fields };
        const skipped: string[] = [];
        for (const fd of params.fieldDescriptions) {
          if (!validNames.has(fd.name)) { skipped.push(fd.name); continue; }
          merged[fd.name] = { ...prev.fields[fd.name], description: fd.description };
        }
        if (skipped.length === params.fieldDescriptions.length) throw new Error(`fieldDescriptions 全部不在库 schema 里：${skipped.join(", ")}`);

        const newBinding: Binding = {
          ...prev,
          description: params.bindingDescription?.trim() || prev.description || "",
          title: params.bindingTitle?.trim() || prev.title,
          fields: merged,
        };
        const bindings = { ...cfgNow.bindings, [targetId]: newBinding };
        saveConfig({ ...cfgNow, bindings, currentBindingId: cfgNow.currentBindingId ?? targetId });
        const covered = Object.values(newBinding.fields).filter((f) => f.description).length;
        const total = Object.keys(newBinding.fields).length;
        const tail = skipped.length ? `；跳过不在 schema 里的字段：${skipped.join(", ")}` : "";
        return {
          content: [{ type: "text", text: `已更新库「${newBinding.title}」字段说明（覆盖率 ${covered}/${total}）${tail}。后续 pition_write/pition_read 等 tool 的字段描述已包含本次更新（下次启动或 reload 生效）。` }],
          details: { stage: "describe_fields", action: "updated", dbId: targetId, title: newBinding.title, coverage: `${covered}/${total}`, skipped },
        };
      }

      if (params.stage === "set_mode") {
        const next = typeof params.enabled === "boolean" ? params.enabled : !(cfgNow._assistantMode ?? false);
        saveConfig({ ...cfgNow, _assistantMode: next });
        setRoleMode(next);
        return {
          content: [{ type: "text", text: `pition 助理模式：${next ? "已开启（每次模型请求会注入个人管理助手定位）" : "已关闭（恢复默认 pi 行为）"}（已落盘，重启 pi 保留）。可用 stage=done 再次查询。` }],
          details: { stage: "set_mode", assistantMode: next },
        };
      }

      // stage === "done"
      const currentBinding = cfgNow.currentBindingId ? cfgNow.bindings[cfgNow.currentBindingId] : null;
      const covered = currentBinding ? Object.values(currentBinding.fields).filter((f) => f.description).length : 0;
      const total = currentBinding ? Object.keys(currentBinding.fields).length : 0;
      const knownIds = Object.keys(cfgNow.bindings);
      return {
        content: [{ type: "text", text: `pition 当前状态：\n- token: ${cfgNow.token ? `已落盘（${cfgNow.token.slice(0, 8)}...${cfgNow.token.slice(-4)}）` : "未设置"}\n- 当前库: ${currentBinding ? `「${currentBinding.title}」${currentBinding.description ? `（${currentBinding.description}）` : ""}，字段覆盖率 ${covered}/${total}` : "（未选）"}\n- 助理模式: ${cfgNow._assistantMode ? "开" : "关"}\n- 已描述过的库（dbId 维度）: ${knownIds.length} 个` }],
        details: { stage: "done", tokenSet: !!cfgNow.token, currentBindingId: cfgNow.currentBindingId, currentBinding: currentBinding ?? undefined, knownBindings: knownIds, assistantMode: !!(cfgNow._assistantMode ?? false) },
      };
    },
  });

  // 运行态 tool 注册前置条件：cfg 存在 + 选了 binding。
  // 注：cfg 在 execute 时由 currentBinding() 重读，不依赖启动时闭包——避免切库后所有 tool 仍查旧库。
  const snapshotCfg = roleState.cfg;
  if (!snapshotCfg || snapshotCfg.currentBindingId === undefined || !snapshotCfg.bindings[snapshotCfg.currentBindingId]) return;

  // ---------- pition_boot 已挪到 factory 主函数顶部（无条件注册）----------

// 运行态 binding 解析器：每次 tool execute 调用都重新 loadConfig 拿 currentBindingId，
// 不依赖启动时闭包（修复"切库后 pition_history / pition_query 仍查旧库"bug）。
// 单库心智下 cfg.currentBindingId 是数字 index，bindings 是对象数组。
function currentBinding(): Binding {
  const cfg = loadConfig();
  if (!cfg) throw new Error("pition 未配置（没有 pition.config.json）");
  const idx = cfg.currentBindingId;
  if (idx === undefined || idx === null || !cfg.bindings[idx]) {
    throw new Error("pition 没选当前库——调 pition_boot stage=select_db 选一个，或 stage=done 看状态");
  }
  return cfg.bindings[idx];
}

  // ---------- pition_create_today（逃生口：显式新建 page）----------
  // 默认不调用——page 由 Notion 定时任务每天 0 点自动建。
  // pition_write 找不到"最新 page"时会 warning，由 agent 自行决定是否调这个逃生口。
  pi.registerTool({
    name: "pition_create_today",
    label: "Pition 手动新建当前 page",
    description: `逃生口：在当前库新建一条 page。默认不调用——page 由 Notion 定时任务每天 0 点自动创建。仅当 pition_write 报「该库还没有任何 page」警告时由 agent 显式调用。properties 必须含 title 字段的值。当前库由 pition_boot stage=select_db 选定；要看当前库字段说明先调 pition_boot stage=done。`,
    promptGuidelines: [
      "仅当 pition_write 返回 warning「该库还没有任何 page」时调用本工具手动建条；agent 切勿主动建 page。",
    ],
    parameters: Type.Object({
      properties: Type.Array(PROPERTY_ENTRY, { description: "要写的字段列表（必须含 title 类型字段的值；其它字段会按 pition_write 一样的规则自动回填" }),
      content: Type.Optional(Type.String({ description: "正文内容（纯文本段落，可多段用 \\n\\n 分隔）" })),
      timestamp: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "事件时间（ISO 或 Unix ms），默认当前时间" })),
      prefixContent: Type.Optional(Type.Boolean({ description: "是否给正文段首加 [HH:MM]，默认 true" })),
    }),
    async execute(_id, params) {
      const binding = currentBinding();
      const when = toDate(params.timestamp);
      const props = autoFillDateProperty(binding, params.properties, when);
      const page = await notion(null, "POST", "/v1/pages", {
        parent: { database_id: binding.dbId },
        properties: buildProperties(binding, props),
      });
      if (params.content) {
        const bodyText = params.prefixContent === false
          ? params.content
          : prefixClockToContent(params.content, when);
        const blocks = bodyText.split(/\n{2,}/).filter(Boolean).map((text) => ({
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ text: { content: text } }] },
        }));
        await notion(null, "PATCH", `/v1/blocks/${page.id}/children`, { children: blocks });
      }
      return {
        content: [{ type: "text", text: `已新建当前 page 到「${binding.title}」: ${page.url}（注意：定时任务可能挂了，请检查 Notion automation）` }],
        details: { store: binding.title, pageId: page.id, url: page.url, timestamp: when.toISOString(), prefixContent: params.prefixContent !== false, escape: true },
      };
    },
  });

  // ---------- pition_read（读当前 page 完整内容）----------
  // 返回当前 page（按最后编辑时间倒序取 top1）的 properties + 所有正文 block。
  // 不返回 list——agent 不该有"page 列表"心智。
  pi.registerTool({
    name: "pition_read",
    label: "Pition 读当前 page",
    description: `读当前库的「当前 page」（按最后编辑时间倒序取 top1，通常就是今天那条由定时任务新建的 page）的完整内容：所有 properties + 所有正文 block。agent 不该关心有几个 page、不该遍历——用 pition_history 看历史 page。当前库由 pition_boot stage=select_db 选定；要看当前库字段说明先调 pition_boot stage=done。`,
    promptGuidelines: [
      "用户问「今天写了什么/我刚才记了什么」时调 pition_read。",
    ],
    parameters: Type.Object({
    }),
    async execute(_id, params) {
      const binding = currentBinding();
      const q = await notion(null, "POST", `/v1/databases/${binding.dbId}/query`, {
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
        page_size: 1,
      });
      const latest = (q.results as any[])[0];
      if (!latest) {
        return {
          content: [{ type: "text", text: `存储「${binding.title}」还没有任何 page（warning：定时任务今天可能没建，请确认 Notion automation）。agent 可调 pition_create_today 手动建一条。` }],
          details: { store: binding.title, found: false, warning: "no_page_in_db" },
        };
      }
      const blocks = await notion(null, "GET", `/v1/blocks/${latest.id}/children?page_size=100`);
      const props: Record<string, unknown> = {};
      for (const [name, p] of Object.entries(latest.properties || {})) {
        const anyProp = p as any;
        if (anyProp.title) props[name] = anyProp.title.map((t: any) => t.plain_text).join("");
        else if (anyProp.rich_text) props[name] = anyProp.rich_text.map((t: any) => t.plain_text).join("");
        else if (anyProp.select) props[name] = anyProp.select?.name ?? null;
        else if (anyProp.multi_select) props[name] = anyProp.multi_select.map((o: any) => o.name).join(", ");
        else if (anyProp.checkbox !== undefined) props[name] = anyProp.checkbox;
        else if (anyProp.number !== undefined) props[name] = anyProp.number;
        else if (anyProp.date) props[name] = anyProp.date?.start ?? null;
        else if (anyProp.status) props[name] = anyProp.status?.name ?? null;
      }
      const content = (blocks.results as any[]).map((b) => {
        if (b.type === "paragraph") return b.paragraph.rich_text.map((t: any) => t.plain_text).join("");
        return null;
      }).filter(Boolean);
      return {
        content: [{ type: "text", text: JSON.stringify({ properties: props, blocks: content }, null, 2) }],
        details: { store: binding.title, pageId: latest.id, url: latest.url, lastEdited: latest.last_edited_time },
      };
    },
  });

  // ---------- pition_write（主路径：改当前 page 的属性 + 追加正文）----------
  // 日常主路径——agent 记录任何事都走它。
  // 找不到"最新 page"时不抛错，只 warning，让 agent 决定是否调 pition_create_today。
  pi.registerTool({
    name: "pition_write",
    label: "Pition 写当前 page",
    description: `日常记录的主路径：把属性修改和/或正文内容写到当前库的「当前 page」（按最后编辑时间倒序取 top1，通常就是今天那条由定时任务新建的 page）。默认自动给 appendContent 每段首加 [HH:MM]（本地时间）。如果该库还没有任何 page，本工具返回 warning（不抛错），由 agent 决定是否调 pition_create_today 手动建条——page 列表是定时任务管的，agent 不该主动建。当前库由 pition_boot stage=select_db 选定；要看当前库字段说明先调 pition_boot stage=done。\n\n属性是看版主写入区：multi_select 加 tag 用默认（union）/ number 累加用默认（累加）/ checkbox 用默认（取 OR）——这些"看板维度"反复累加合理；title / select / status / url / email / phone_number 单值字段永远用新值；想要整段覆盖某字段显式传 overwrite:true。返回里附 todaySoFar 直接预览今天该 page 全部内容。`,
    promptGuidelines: [
      "用户在记录今天的内容（日记、打卡、备注、流水、流水消费）时，**优先用 pition_write 追加**，这是日常主路径。",
      "**属性 = 看版**：能写到属性的（multi_select / select / number / checkbox / status）尽量写到属性而不是堆在正文——便于 Notion 看板按维度统计。multi_select 加 tag、number 累加金额/时长、checkbox 打卡用默认 append；status / select 状态切换用 overwrite:true；同一事件的多维度（例：「运动 30 分钟 + 午餐花了 45 元」）一次性写在同一个 pition_write 调用的 properties 数组里。",
      "用户的对话里有「我刚/刚才」时，程序会自动加时间戳，agent 不必手动指定。",
      "如果 pition_write 返回 warning「该库还没有任何 page」，调 pition_create_today 手动建一条（逃生口）。",
      "返回里 todaySoFar 是今天该 page 全部已记内容——写完应在回复里整体预览给用户 + 主动追问更多细节（先记原始再问优化）。",
      "不要调 pition_history 看 page 列表——page 列表心智不属于日常记录。",
    ],
    parameters: Type.Object({
      properties: Type.Optional(Type.Array(PROPERTY_ENTRY, { description: "要修改的字段列表（只传需要改的）" })),
      appendContent: Type.Optional(Type.String({ description: "追加到正文末尾的内容（纯文本段落，可多段用 \\n\\n 分隔）" })),
      timestamp: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "事件时间（ISO 或 Unix ms），默认当前时间。代写历史事件时手动指定。" })),
      prefixTimestamp: Type.Optional(Type.Boolean({ description: "是否给 appendContent 每段首加 [HH:MM]，默认 true。追加静态文本/标题/不需要时间锚点的内容时设 false。" })),
    }),
    async execute(_id, params) {
      const binding = currentBinding();
      if (!params.properties && !params.appendContent) throw new Error("properties 和 appendContent 至少传一个");
      const when = toDate(params.timestamp);
      const q = await notion(null, "POST", `/v1/databases/${binding.dbId}/query`, {
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
        page_size: 1,
      });
      const latest = (q.results as any[])[0];
      if (!latest) {
        return {
          content: [{ type: "text", text: `WARNING: 存储「${binding.title}」还没有任何 page——可能是定时任务没建。Agent 可调 pition_create_today 手动建一条。` }],
          details: { store: binding.title, found: false, warning: "no_page_in_db" },
        };
      }
      if (params.properties) {
        // 需要先读 page 现有 properties 才能做 append 合并。
        // 全部 overwrite=true 才跳过读；任一 append 都得读。
        const needsMerge = params.properties.some((p) => !p.overwrite);
        const snapshot = needsMerge
          ? readPageProperties(binding, await notion(null, "GET", `/v1/pages/${latest.id}`).then((p: any) => p.properties ?? {}))
          : {};
        const merged = mergeProperties(binding, snapshot, params.properties);
        await notion(null, "PATCH", `/v1/pages/${latest.id}`, { properties: merged });
      }
      if (params.appendContent) {
        const bodyText = params.prefixTimestamp === false
          ? params.appendContent
          : prefixClockToContent(params.appendContent, when);
        const blocks = bodyText.split(/\n{2,}/).filter(Boolean).map((text) => ({
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ text: { content: text } }] },
        }));
        await notion(null, "PATCH", `/v1/blocks/${latest.id}/children`, { children: blocks });
      }
      // 写入后立刻读一次 page 全部内容——返回里附 todaySoFar 让模型直接预览 + 追问
const [pageAfter, blocks] = await Promise.all([
  notion(null, "GET", `/v1/pages/${latest.id}`),
  notion(null, "GET", `/v1/blocks/${latest.id}/children?page_size=100`),
]);
const propsSnapshot = readPageProperties(binding, pageAfter.properties ?? {});
// 属性按字段说明渲染：field.type/description 加当前值——看板场景下模型拿到能直接复述
const propsBlock = Object.entries(binding.fields)
  .map(([name, meta]) => {
    const v = propsSnapshot[name];
    if (v === undefined || v === null || v === "") return null;
    const vStr = Array.isArray(v) ? v.join(", ") : String(v);
    return `  - ${name} (${meta.type})${meta.description ? ` — ${meta.description}` : ""}: ${vStr}`;
  })
  .filter(Boolean)
  .join("\n") || "  （无）";
const contentBlock = (blocks.results as any[])
  .filter((b: any) => b.type === "paragraph")
  .map((b: any) => (b.paragraph?.rich_text ?? []).map((t: any) => t.plain_text).join(""))
  .filter(Boolean)
  .join("\n\n");
const todaySoFar = `属性:\n${propsBlock}\n\n正文:\n${contentBlock || "（空）"}`;
return {
  content: [{ type: "text", text: `已写入「${binding.title}」当前 page: ${latest.url}\n\n—— 今日该 page 已记 ——\n${todaySoFar}` }],
  details: {
    store: binding.title,
    pageId: latest.id,
    url: latest.url,
    timestamp: when.toISOString(),
    prefixTimestamp: params.prefixTimestamp !== false,
    todaySoFar,
    todayProperties: propsSnapshot,
    todayContent: contentBlock,
  },
};
},
});

  // ---------- pition_history（显式查 page 列表）----------
  // 默认场景：pition_write / pition_read 已足够。pition_history 留给"翻旧账"。
  pi.registerTool({
    name: "pition_history",
    label: "Pition 查历史 page 列表",
    description: `查当前库的 page 列表（默认按最后编辑时间倒序）。日常记录不需要用——只有用户翻旧账（「上个月写过什么/上周的日记」）时才调。注意：page 列表对 agent 是显式心智，**不是默认背景**。当前库由 pition_boot stage=select_db 选定；要看当前库字段说明先调 pition_boot stage=done。`,
    promptGuidelines: [
      "用户翻旧账（「上个月/上周/去年的 xxxx 天」）时调 pition_history；不要默认调它。",
    ],
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "返回条数，默认 10，最大 50" })),
      filter: Type.Optional(QUERY_FILTER_SCHEMA),
    }),
    async execute(_id, params) {
      const binding = currentBinding();
      const body: Record<string, unknown> = {
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
        page_size: Math.min(Math.max(params.limit ?? 10, 1), 50),
      };
      if (params.filter) {
        const { field, op, value } = params.filter;
        const meta = binding.fields[field];
        if (!meta) throw new Error(`存储「${binding.title}」没有字段「${field}」。可用: ${Object.keys(binding.fields).join("、")}`);
        body.filter = meta.type === "checkbox"
          ? { property: field, checkbox: { equals: Boolean(value) } }
          : meta.type === "number"
            ? { property: field, number: { equals: Number(value) } }
            : { property: field, [op === "contains" ? "rich_text" : meta.type]: { [op === "contains" ? "contains" : "equals"]: String(value) } };
      }
      const data = await notion(null, "POST", `/v1/databases/${binding.dbId}/query`, body);
      const rows = (data.results as any[]).map((page) => {
        const props: Record<string, unknown> = {};
        for (const [name, p] of Object.entries(page.properties || {})) {
          const anyProp = p as any;
          if (anyProp.title) props[name] = anyProp.title.map((t: any) => t.plain_text).join("");
          else if (anyProp.rich_text) props[name] = anyProp.rich_text.map((t: any) => t.plain_text).join("");
          else if (anyProp.select) props[name] = anyProp.select?.name ?? null;
          else if (anyProp.multi_select) props[name] = anyProp.multi_select.map((o: any) => o.name).join(", ");
          else if (anyProp.checkbox !== undefined) props[name] = anyProp.checkbox;
          else if (anyProp.number !== undefined) props[name] = anyProp.number;
          else if (anyProp.date) props[name] = anyProp.date?.start ?? null;
          else if (anyProp.status) props[name] = anyProp.status?.name ?? null;
        }
        return { id: page.id, last_edited: page.last_edited_time, ...props };
      });
      return {
        content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
        details: { store: binding.title, count: rows.length, page_list_kind: true },
      };
    },
  });

  // ---------- pition_span（区间事件：start / heartbeat / end）----------
  // 区间事件：start 时只记 cfg._activeSpan（不入 Notion），end 时整段拼成一条正文落到当前 page。
  // 全局提示词会持续提示 agent「你还在跑步（已 28 分钟）」—— agent 据此调 heartbeat / end。
  pi.registerTool({
    name: "pition_span",
    label: "Pition 区间事件",
    description: `区间事件管理（类似计时器）：记录「开始-持续-结束」的事件（开会 / 跑步 / 午休 / 写代码 / 等）。3 个 action：start=开始一段新事件（仅落 cfg，不入 Notion）；heartbeat=续约（仍在继续，agent 据此主动调）；end=收尾——把整段 [HH:MM-HH:MM 持续 N 分钟] 事件名 + 备注 拼成一条正文写入当前 page。start 时如果已有 active span，报错让 agent 先 end 旧的。`,
    promptGuidelines: [
      "用户开始/进入一个有时长的事件（「开始跑步」「开始午休」「开始开会」）→ 调 pition_span action=start（带事件名 + 可选备注）。",
      "如果用户话里含「还在 / 仍然 / 继续 / 一直」并提到当前进行中的事 → 调 pition_span action=heartbeat（agent 据全局提示词里『已 N 分钟』自己判断需要调）。",
      "用户说结束 / 完成 / 出来了 / 感受 → 调 pition_span action=end（事件名 / 备注 / 感受会被合并进正文写入当前 page）。",
      "**不要**用 pition_write 写『开始跑步』或『结束跑步』这类有开始+结束的事件——用 pition_span 记录整段。",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("start"),
        Type.Literal("heartbeat"),
        Type.Literal("end"),
      ], { description: "start=开新 span；heartbeat=续约；end=收尾并写入 Notion" }),
      eventName: Type.Optional(Type.String({ description: "事件名（action=start 必填；heartbeat/end 可选沿用 active span）" })),
      note: Type.Optional(Type.String({ description: "可选备注（action=start 时设定；end 时可补充感受/收尾说明）" })),
      summary: Type.Optional(Type.String({ description: "action=end 时可选：事后总结/感受/结果，合并进正文" })),
    }),
    async execute(_id, params) {
      const binding = currentBinding();
      const cfg = loadConfig();
      if (!cfg) throw new Error("pition 未配置");
      const now = new Date();
      const isoNow = now.toISOString();

      if (params.action === "start") {
        if (!params.eventName) throw new Error("action=start 必须传 eventName");
        if (cfg._activeSpan) {
          throw new Error(
            `已有进行中的 span「${cfg._activeSpan.eventName}」开始于 ${cfg._activeSpan.startedAt}——请先 pition_span action=end 收尾它，再开新的。`,
          );
        }
        const span: ActiveSpan = {
          spanId: `span_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          eventName: params.eventName,
          note: params.note,
          startedAt: isoNow,
          lastHeartbeatAt: isoNow,
        };
        saveConfig({ ...cfg, _activeSpan: span });
        return {
          content: [{ type: "text", text: `📍 已开始「${span.eventName}」${span.note ? `（${span.note}）` : ""}。\n全局提示词会持续注入「已 N 分钟」提醒你。结束请调 pition_span action=end。` }],
          details: { action: "start", span },
        };
      }

      if (params.action === "heartbeat") {
        if (!cfg._activeSpan) throw new Error("没有进行中的 span 可以 heartbeat——先 action=start");
        const updated: ActiveSpan = {
          ...cfg._activeSpan,
          note: params.note ?? cfg._activeSpan.note,
          lastHeartbeatAt: isoNow,
        };
        saveConfig({ ...cfg, _activeSpan: updated });
        const elapsed = Math.max(0, Math.round((now.getTime() - new Date(updated.startedAt).getTime()) / 60000));
        return {
          content: [{ type: "text", text: `💓 heartbeat 已记录——「${updated.eventName}」仍在进行（已 ${elapsed} 分钟）。` }],
          details: { action: "heartbeat", span: updated },
        };
      }

      // action === "end"
      if (!cfg._activeSpan) throw new Error("没有进行中的 span 可以 end——直接调 pition_write 即可");
      const span = cfg._activeSpan;
      const started = new Date(span.startedAt);
      const endedAt = now;
      const elapsedMs = endedAt.getTime() - started.getTime();
      const elapsedMin = Math.round(elapsedMs / 60000);
      // 格式化 [HH:MM-HH:MM] 事件名（备注 / 总结）
      const fmt = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      const head = `[${fmt(started)}-${fmt(endedAt)} 持续 ${elapsedMin} 分钟]`;
      const finalNote = params.note ?? span.note;
      const tailParts: string[] = [];
      if (finalNote) tailParts.push(`（${finalNote}）`);
      if (params.summary) tailParts.push(`— ${params.summary}`);
      const paragraphText = `${head} ${span.eventName}${tailParts.join(" ")}`;

      // 写入当前 page（不用 pition_write：时间戳由我们自己加，避免和 span head 冲突）
      const q = await notion(null, "POST", `/v1/databases/${binding.dbId}/query`, {
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
        page_size: 1,
      });
      const latest = (q.results as any[])[0];
      if (latest) {
        await notion(null, "PATCH", `/v1/blocks/${latest.id}/children`, {
          children: [{
            object: "block",
            type: "paragraph",
            paragraph: { rich_text: [{ text: { content: paragraphText } }] },
          }],
        });
      }
      // 清除 cfg._activeSpan（end 后不再注入 span 状态）
      const { _activeSpan, ...rest } = cfg;
      saveConfig({ ...rest, _activeSpan: null });
      return {
        content: [{ type: "text", text: `✅ 「${span.eventName}」已结束（持续 ${elapsedMin} 分钟），已写入「${binding.title}」当前 page。` }],
        details: { action: "end", span, pageId: latest?.id, paragraphText, elapsedMin },
      };
    },
  });
}

// ============================================================================
// /pition 设置向导：登录 token → 选库 → 看结构 → 补字段说明 → 保存热重载
// ============================================================================

interface DbOption { id: string; title: string; fieldCount: number }

// 列出 token 可访问的库（该 integration 在 Notion 里被"连接"过的库）
async function listDatabases(token: string): Promise<DbOption[]> {
  const out: DbOption[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const body: Record<string, unknown> = {
      filter: { property: "object", value: "database" },
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;
    const res = await notionWith(token, "POST", "/v1/search", body);
    for (const r of res.results ?? []) {
      out.push({
        id: r.id,
        title: (r.title ?? []).map((t: any) => t.plain_text).join("") || "(无标题)",
        fieldCount: Object.keys(r.properties ?? {}).length,
      });
    }
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return out;
}

// 取库 schema，挑出可写字段（计算类字段过滤掉）
async function fetchFields(token: string, dbId: string): Promise<Record<string, FieldMeta>> {
  const db = await notionWith(token, "GET", `/v1/databases/${dbId}`);
  const fields: Record<string, FieldMeta> = {};
  for (const [name, prop] of Object.entries(db.properties ?? {})) {
    const type = (prop as any).type as string;
    if ((WRITABLE_TYPES as readonly string[]).includes(type)) {
      fields[name] = { type, description: "" };
    }
  }
  return fields;
}

async function setupWizard(pi: ExtensionAPI, ctx: any): Promise<void> {
  const ui = ctx.ui;
  const cfg = loadConfig() ?? { token: "", bindings: [] };

  // ---- 1. 登录：token ----
  const existing = cfg.token ? `${cfg.token.slice(0, 8)}...${cfg.token.slice(-4)}` : "（未设置）";
  const tokenInput = await ui.input(
    `Notion integration token（当前: ${existing}，回车跳过）`,
    "ntn_...",
  );
  if (tokenInput === undefined) return; // 用户取消
  const token = tokenInput.trim() || cfg.token;
  if (!token) {
    ui.notify("没有 token，无法继续", "error");
    return;
  }

  // 连通性校验
  let whoami: any;
  try {
    whoami = await notionWith(token, "GET", "/v1/users/me");
  } catch (e) {
    ui.notify(`token 无效: ${(e as Error).message}`, "error");
    return;
  }
  ui.notify(`已连接工作区「${whoami.bot?.workspace_name ?? "未知"}」`, "info");

  // ---- 2. 选库 ----
  let dbs: DbOption[];
  try {
    dbs = await listDatabases(token);
  } catch (e) {
    ui.notify(`拉取库列表失败: ${(e as Error).message}`, "error");
    return;
  }
  if (!dbs.length) {
    ui.notify("该 token 看不到任何库——请在 Notion 里把目标库「连接」到这个 integration 后重试", "warning");
    return;
  }

  const bindings = [...cfg.bindings];
  // 已绑定的沉到底部标注，避免重复选
  const boundIds = new Set(bindings.map((b) => b.dbId));
  const options = dbs.map((d) => `${d.title}  (${d.fieldCount} 字段)${boundIds.has(d.id) ? " [已绑定]" : ""}`);
  const picked = await ui.select("选择一个要作为存储的库（回车确认）", options);
  if (picked === undefined) return;
  const db = dbs[options.indexOf(picked)];

  if (boundIds.has(db.id)) {
    const again = await ui.confirm("该库已绑定", `「${db.title}」已配置过，重新配置字段说明？`);
    if (!again) return;
  }

  // ---- 3. 看结构 + 4. 补字段说明 ----
  let fields: Record<string, FieldMeta>;
  try {
    fields = await fetchFields(token, db.id);
  } catch (e) {
    ui.notify(`读取库结构失败: ${(e as Error).message}`, "error");
    return;
  }
  const fieldNames = Object.keys(fields);
  if (!fieldNames.length) {
    ui.notify("该库没有可写字段（可能全是 formula/relation 等计算字段）", "warning");
    return;
  }

  // 沿用已绑定的字段说明作为默认值
  const prev = bindings.find((b) => b.dbId === db.id);
  const summary = fieldNames.map((n) => `  ${n} (${fields[n].type})`).join("\n");
  const proceed = await ui.confirm(
    `库「${db.title}」结构（共 ${fieldNames.length} 个可写字段）`,
    `${summary}\n\n接下来逐字段填写用途说明（回车用默认/留空）。是否继续？`,
  );
  if (!proceed) return;

  const boundDescInput = await ui.input(
    `库用途说明（当前: ${prev?.description ?? "无"}）`,
    "例：个人日常记录总表，每天的内容都存这里",
  );
  if (boundDescInput === undefined) return;
  const bindingDesc = boundDescInput.trim() || prev?.description || "";

  for (const name of fieldNames) {
    const prevDesc = prev?.fields?.[name]?.description ?? "";
    const ans = await ui.input(
      `字段「${name}」(${fields[name].type}) 的用途说明`,
      prevDesc || "例：记录标题，一般是当天日期",
    );
    if (ans === undefined) return; // 中途取消 → 整次不保存
    fields[name].description = ans.trim() || prevDesc;
  }

  // ---- 保存 + 热重载 ----
  const newBinding: Binding = {
    dbId: db.id,
    title: db.title,
    description: bindingDesc,
    fields,
  };
  const idx = bindings.findIndex((b) => b.dbId === db.id);
  if (idx >= 0) bindings[idx] = newBinding;
  else bindings.push(newBinding);

  const finalCfg: PitionConfig = { token, bindings };
  try {
    saveConfig(finalCfg);
  } catch (e) {
    ui.notify(`写入配置失败: ${(e as Error).message}`, "error");
    return;
  }

  const hasDesc = fieldNames.filter((n) => fields[n].description).length;
  ui.notify(`已保存「${db.title}」（${hasDesc}/${fieldNames.length} 个字段有说明），重载中…`, "info");
  try {
    await ctx.reload();
  } catch {
    ui.notify("自动重载失败，请手动重启 pi 使新配置生效", "warning");
  }
}

export function registerSetupCommand(pi: ExtensionAPI): void {
  pi.registerCommand("pition", {
    description: "配置 pition：登录 Notion → 选库 → 查看结构 → 补字段说明",
    async handler(_args: string, ctx: any) {
      if (!ctx.hasUI) {
        ctx.ui.notify("设置向导需要交互式终端，请在 pi TUI 里运行 /pition", "error");
        return;
      }
      await setupWizard(pi, ctx);
    },
  });
}
