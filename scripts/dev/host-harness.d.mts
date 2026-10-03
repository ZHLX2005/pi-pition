// host-harness.mjs 的类型声明：给 TS 侧的测试一个稳定的边界契约
// （改 harness 的字段名会让 test/host-injection.test.ts 直接编译失败，而不是运行期 undefined）
import type { ExtensionRunner } from "@earendil-works/pi-coding-agent";

export declare const EXPECTED_TOOLS: string[];

export interface HostHarness {
  /** 真实 pi 模块（用于取 ExtensionRunner 等构造器） */
  pi: { ExtensionRunner: typeof ExtensionRunner };
  runner: ExtensionRunner;
  loaded: {
    errors: unknown[];
    extensions: Array<{
      path: string;
      handlers: Map<string, Array<(event: any, ctx?: any) => unknown>>;
      tools: Map<string, unknown>;
    }>;
  };
  /** 真实 loader 收集到的 tool 名（从注册结果读，不手抄清单） */
  tools: string[];
  /** 真实 loader 收集到的事件名 */
  handlers: string[];
  /** 临时 pition.config.json 的绝对路径（用例可改写它来模拟状态变化） */
  configPath: string;
  /** 复刻 agent-session 传给 before_agent_start 的 options（真实形状） */
  baseOptions(overrides?: Record<string, unknown>): Record<string, unknown>;
  /** 与 agent-session 同路径地跑一轮 before_agent_start，返回归一化后的 options */
  emit(prompt: string, overrides?: Record<string, unknown>): Promise<Record<string, any>>;
  /** 派发任意事件（session_start / tool_execution_end 走真实派发路径） */
  fire(event: Record<string, unknown>): Promise<unknown>;
  /** 还原环境变量并删掉临时目录 */
  dispose(): void;
}

export declare function assembleHost(options?: {
  /** 写进临时配置文件的内容 */
  config?: unknown;
  /** 扩展包根（默认 pition 仓库根）——别的扩展复用本 harness 时换成自己的 */
  root?: string;
  /** 扩展读配置用的环境变量名 */
  configEnv?: string;
  /** 临时配置文件名 */
  configFile?: string;
  /** 复刻 agent-session 的 selectedTools（默认 pition 的 7 个） */
  expectedTools?: string[];
}): Promise<HostHarness>;
