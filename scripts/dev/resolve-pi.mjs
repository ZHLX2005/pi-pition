// 开发脚本共享工具：解析 pi 包与 jiti 的位置，让 scripts/dev/ 在任意机器可跑。
//
// 解析顺序（先本仓库 node_modules，再本机 pi 安装位置）：
//   1. 仓库根 node_modules（npm install 后自动有）
//   2. $PI_CODING_AGENT_DIR 指向的 pi 安装（若设置了）
//
// 用法：
//   import { piEntry, typeboxEntry, jitiEntry, createRepoJiti } from "./resolve-pi.mjs";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 从某个目录起向上找 node_modules/<pkg>/<entry> */
function findInAncestors(startDir, relPath) {
  let dir = resolve(startDir);
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "node_modules", relPath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** pnpm 虚拟 store 里找包（.pnpm/<pkg>@<ver>/node_modules/<pkg>/<entry>） */
function findInPnpmStore(nodeModulesDir, pkgName, relPath) {
  const storeDir = join(nodeModulesDir, ".pnpm");
  if (!existsSync(storeDir)) return null;
  const prefix = pkgName.replace("/", "+").replace("@", "@");
  for (const entry of readdirSync(storeDir)) {
    if (!entry.startsWith(prefix) && !entry.startsWith(pkgName.replace("@", "").replace("/", "+"))) continue;
    const candidate = join(storeDir, entry, "node_modules", pkgName, relPath);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

/** 解析一个包的文件入口：普通 node_modules → pnpm store → 报错并给指引 */
export function resolvePkgEntry(pkgName, relPath) {
  const direct = findInAncestors(repoRoot, join(pkgName, relPath));
  if (direct) return direct;
  const directNM = findInAncestors(repoRoot, pkgName);
  if (directNM) {
    const nmDir = dirname(directNM);
    const stored = findInPnpmStore(nmDir, pkgName, relPath);
    if (stored) return stored;
  }
  // 退一步：本机全局 pi 安装
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (agentDir) {
    const globalTry = findInAncestors(agentDir, join(pkgName, relPath));
    if (globalTry) return globalTry;
  }
  throw new Error(
    `找不到 ${pkgName}/${relPath}。请在仓库根跑 \`npm install\`（devDependencies 里已含 pi 包与 jiti），` +
      `或设置 PI_CODING_AGENT_DIR 指向本机 pi 安装目录。`,
  );
}

export const piEntry = resolvePkgEntry("@earendil-works/pi-coding-agent", "dist/index.js");
export const typeboxEntry = resolvePkgEntry("typebox", "build/index.mjs");
export const jitiEntry = resolvePkgEntry("jiti", "lib/jiti.mjs");

/** 建一个已配好 pi / typebox alias 的 jiti 实例（给加载扩展源码用） */
export async function createRepoJiti() {
  const { createJiti } = await import(pathToFileURL(jitiEntry).href);
  return createJiti(pathToFileURL(join(repoRoot, "scripts", "smoke-load.mjs")).href, {
    alias: {
      "@earendil-works/pi-coding-agent": piEntry,
      typebox: typeboxEntry,
    },
  });
}

export const REPO_ROOT = repoRoot;
export const repoPath = (...segs) => join(repoRoot, ...segs);
