// 真宿主装配：用真实 pi 的 loader + ExtensionRunner 跑一遍 before_agent_start。
//
// 为什么需要它：`test/extension.test.ts` 里那个「假 pi」是**我们自己写的**——它验证不了
// 「我 mutate 的 event.systemPromptOptions 真的是宿主后来用的那个对象」这类假设。
// 一旦假设错了，测试全绿而功能失效。这里走真 pi：
//
//   discoverAndLoadExtensions(包根)        ← pi 的真实扩展发现（package.json#pi.extensions）
//     → new ExtensionRunner(...)           ← pi 的真实派发（含 systemPromptOptions 归一化）
//        → runner.emitBeforeAgentStart(...) ← 与 agent-session 同一条代码路径
//
// 全程离线、不碰模型、不需要 API key；用临时目录做 agentDir，避免误加载用户自己的扩展。
//
// 注意：`ExtensionRunner` 不 bindCore 也能派发 before_agent_start（handler 不触碰 ctx）——
// 已实测；若将来 pi 改成必须 bindCore，这里会立刻报错而不是静默通过。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { piEntry, REPO_ROOT } from "./resolve-pi.mjs";

/** 全部 pition tool 名（与 package.json 的 pi.extensions 同源：从注册结果读，不抄清单） */
export const EXPECTED_TOOLS = [
  "pition_boot",
  "pition_create_today",
  "pition_goal",
  "pition_history",
  "pition_read",
  "pition_span",
  "pition_write",
];

/**
 * 装配一个真实宿主环境。
 *
 * 参数化是为了**给别的扩展复用**：把 `root` / `configEnv` / `configFile` / `expectedTools`
 * 换成你自己的，这套「真 loader + 真 runner + 离线派发」就能原样搬走 ——
 * 它是唯一能验证「我 mutate 的 systemPromptOptions 真的是宿主后来用的那个对象」的手段。
 *
 * @param {object} options
 * @param {object} options.config        写进临时配置文件的内容
 * @param {string} [options.root]        扩展包根（默认 pition 仓库根）
 * @param {string} [options.configEnv]   扩展读配置用的环境变量名
 * @param {string} [options.configFile]  临时配置文件名
 * @param {string[]} [options.expectedTools] 复刻 agent-session 的 selectedTools（默认 pition 的 7 个）
 */
export async function assembleHost({
  config = { token: "", bindings: {}, currentBindingId: null },
  root = REPO_ROOT,
  configEnv = "PITION_CONFIG",
  configFile = "pition.config.json",
  expectedTools = EXPECTED_TOOLS,
} = {}) {
  const pi = await import(pathToFileURL(piEntry).href);
  const sandbox = mkdtempSync(join(tmpdir(), "pition-host-"));
  const configPath = join(sandbox, configFile);
  writeFileSync(configPath, JSON.stringify(config), "utf8");

  // 配置隔离：扩展在 loadConfig 时读这个环境变量（绝不碰用户的真实配置）
  const previous = process.env[configEnv];
  process.env[configEnv] = configPath;

  const loaded = await pi.discoverAndLoadExtensions([root], root, sandbox);
  const runner = new pi.ExtensionRunner(loaded.extensions, loaded.runtime, root, null, null);
  const tools = loaded.extensions.flatMap((e) => [...(e.tools?.keys?.() ?? [])]);
  const handlers = loaded.extensions.flatMap((e) => [...(e.handlers?.keys?.() ?? [])]);

  const dispose = () => {
    if (previous === undefined) delete process.env[configEnv];
    else process.env[configEnv] = previous;
    rmSync(sandbox, { recursive: true, force: true });
  };

  return {
    pi,
    runner,
    loaded,
    tools,
    handlers,
    configPath,
    dispose,
    /** 复刻 agent-session 传给 before_agent_start 的 options（真实形状） */
    baseOptions(overrides = {}) {
      return {
        cwd: root,
        selectedTools: [...expectedTools],
        toolSnippets: Object.fromEntries(expectedTools.map((n) => [n, `${n} snippet`])),
        toolGuidelines: Object.fromEntries(expectedTools.map((n) => [n, [`${n} 的约定`]])),
        promptGuidelines: [],
        sections: {},
        skills: [],
        ...overrides,
      };
    },
    /** 与 agent-session 同路径地跑一轮 before_agent_start，返回归一化后的 options */
    async emit(prompt, overrides = {}) {
      const res = await runner.emitBeforeAgentStart(prompt, undefined, this.baseOptions(overrides));
      return res.systemPromptOptions;
    },
    /** 派发任意事件（用于 session_start / tool_execution_end 的真实派发路径） */
    async fire(event) {
      await runner.emit(event);
    },
  };
}
