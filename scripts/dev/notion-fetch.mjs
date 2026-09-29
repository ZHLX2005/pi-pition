// 开发脚本的 Notion 客户端：**复用 src/notion.ts**（经 jiti 加载 TS 源码），
// 不再自带常量副本——避免与扩展的重试策略各自演化。
//
// 为什么用 jiti：裸 Node 不能 import .ts。开发脚本本身是 .mjs，
// 通过 src 的 TS 源码走一遍 jiti 才能拿到同一份实现。
import { createRepoJiti } from "./resolve-pi.mjs";

const jiti = await createRepoJiti();
const notionMod = await jiti.import("../../src/notion.ts");
const configMod = await jiti.import("../../src/config.ts");

/** 带重试的 fetch（复用 src/notion.ts 的实现） */
export const fetchNotion = notionMod.fetchNotion;

/**
 * 创建一个绑定 token 的 Notion API 客户端。
 * 用法：const api = createNotionClient(token); await api("GET", "/v1/users/me");
 */
export function createNotionClient(token) {
  return async function api(method, path, body) {
    return notionMod.notionWith(token, method, path, body);
  };
}

/** 读当前仓库的 pition.config.json（复用 src/config.ts 的归一逻辑） */
export const loadRepoConfig = configMod.loadConfig;
