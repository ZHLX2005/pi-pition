// 配置读写：pition.config.json 的定位、加载（含老格式兼容）、保存。
// 定位策略：扩展文件所在目录 → 其父目录（包形式安装时配置在包根）。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActiveSpan, Binding, PitionConfig } from "./types.ts";

/** 配置文件名 */
const CONFIG_FILENAME = "pition.config.json";

/** 配置路径的环境变量覆盖（服务器/容器部署、smoke 测试用） */
export const CONFIG_PATH_ENV = "PITION_CONFIG";

/**
 * 配置定位，优先级：
 *   1. 环境变量 `PITION_CONFIG`（显式指定，最高优先）—— 服务器/容器可挂载配置，
 *      测试可指向临时文件而不动仓库里的真实配置
 *   2. 从扩展文件目录起逐级向上找 `pition.config.json`（扩展目录 → 包根）
 *   3. 都不存在 → 返回包根路径（供首次写入）
 *
 * @param fromUrl 通常是 `import.meta.url`；测试可注入自定义值。
 */
function configPath(fromUrl: string = import.meta.url): string {
  const override = process.env[CONFIG_PATH_ENV];
  if (override) return override;

  const dir = dirname(fileURLToPath(fromUrl));
  for (const candidate of [dir, dirname(dir)]) {
    try {
      readFileSync(join(candidate, CONFIG_FILENAME), "utf8");
      return join(candidate, CONFIG_FILENAME);
    } catch {
      // 试下一个
    }
  }
  return join(dirname(dir), CONFIG_FILENAME);
}

/** 把磁盘上的任意历史格式归一成当前 schema */
export function normalizeConfig(raw: unknown): PitionConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  if (!r.token || typeof r.token !== "string") return null;

  // 老格式 bindings: [b, c, ...] → { [b.dbId]: b }
  let bindings: Record<string, Binding> = {};
  if (r.bindings && typeof r.bindings === "object" && !Array.isArray(r.bindings)) {
    bindings = r.bindings;
  } else if (Array.isArray(r.bindings)) {
    for (const b of r.bindings) if (b?.dbId) bindings[b.dbId] = b;
  }
  // 更老格式 binding: { ... } → bindings
  if (r.binding && typeof r.binding === "object" && r.binding.dbId && !bindings[r.binding.dbId]) {
    bindings[r.binding.dbId] = r.binding;
  }
  // currentBindingId 缺省取第一个
  let currentBindingId: string | null = r.currentBindingId ?? null;
  if (!currentBindingId || !bindings[currentBindingId]) {
    currentBindingId = Object.keys(bindings)[0] ?? null;
  }
  // _activeSpan（单对象） → _activeSpans（数组）
  let activeSpans: ActiveSpan[] | undefined;
  if (Array.isArray(r._activeSpans)) {
    activeSpans = r._activeSpans;
  } else if (r._activeSpan && typeof r._activeSpan === "object") {
    activeSpans = [r._activeSpan];
  }

  return {
    token: r.token,
    bindings,
    currentBindingId,
    _assistantMode: r._assistantMode,
    _activeSpans: activeSpans,
  };
}

/** 读配置；无配置 / 非法 JSON / 缺 token 都返回 null */
export function loadConfig(fromUrl: string = import.meta.url): PitionConfig | null {
  try {
    return normalizeConfig(JSON.parse(readFileSync(configPath(fromUrl), "utf8")));
  } catch {
    return null;
  }
}

/** 写配置（JSON + 尾随换行） */
export function saveConfig(cfg: PitionConfig, fromUrl: string = import.meta.url): void {
  writeFileSync(configPath(fromUrl), `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

/**
 * 运行态 binding 解析：每次调用都重新 loadConfig 拿 currentBindingId，
 * **不依赖启动时闭包**（修复"切库后 tool 仍查旧库"）。
 */
export function currentBinding(load: () => PitionConfig | null = loadConfig): Binding {
  const cfg = load();
  if (!cfg) throw new Error("pition 未配置（没有 pition.config.json）——调 pition_boot stage=token 开始配置");
  const idx = cfg.currentBindingId;
  if (idx === undefined || idx === null || !cfg.bindings[idx]) {
    throw new Error("pition 没选当前库——调 pition_boot stage=select_db 选一个，或 stage=done 看状态");
  }
  return cfg.bindings[idx];
}

/** 运行态 span 解析：每次 before_agent_start 都重读（支持并行多事件） */
export function currentSpans(load: () => PitionConfig | null = loadConfig): ActiveSpan[] {
  return load()?._activeSpans ?? [];
}
