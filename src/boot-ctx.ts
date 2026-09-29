// pition_boot 的 description 里那段「当前状态」摘要的拼装。
//
// 为什么放这里：agent 第一次看到 boot 工具描述就知道现状（token / 当前库 / 字段覆盖率 /
// 助理模式），不必先 ping stage=done 再决定下一步。这是运行态快照，注册时算一次。
import type { PitionConfig } from "./types.ts";

/** 把配置状态摘要成几行文本（拼进 boot 的 description） */
export function buildBootCtx(cfg: PitionConfig | null): string {
  const binding = cfg?.currentBindingId ? cfg.bindings[cfg.currentBindingId] : null;
  const coverage = binding
    ? `${Object.values(binding.fields).filter((f) => f.description).length}/${Object.keys(binding.fields).length}`
    : null;
  return (
    `\n\n当前状态：\n` +
    `- token: ${cfg?.token ? `已落盘（${cfg.token.slice(0, 8)}...${cfg.token.slice(-4)}）` : "未设置"}` +
    `\n- 库：${binding ? `已绑定「${binding.title}」${binding.description ? `（${binding.description}）` : ""}，字段覆盖率 ${coverage}` : "未绑定"}` +
    `\n- 助理模式：${cfg?._assistantMode ? "开" : "关"}`
  );
}
