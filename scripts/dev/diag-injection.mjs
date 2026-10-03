// 排障：给定一句话，打印**真实宿主**这次注入进 system prompt 的内容。
//
//   node scripts/dev/diag-injection.mjs "记一下今天吃了火锅"
//   node scripts/dev/diag-injection.mjs "我想练腹肌" --config ~/.pi/agent/extensions/pition.config.json
//   node scripts/dev/diag-injection.mjs "日志" --full      # 连正文一起打印
//
// 为什么走真宿主而不是打印 src/ 的中间结果：用户的问题是「模型到底看到了什么」，
// 唯一可信的答案来自 pi 的真实装配路径（loader + ExtensionRunner + options 归一化）。
//
// 安全：--config 指向的配置会被**复制**到临时目录再交给扩展——扩展在跨天物化目标时会写盘，
// 诊断命令绝不该动用户真实的配置文件。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assembleHost, EXPECTED_TOOLS } from "./host-harness.mjs";

const args = process.argv.slice(2);
const prompt = args.find((a) => !a.startsWith("--")) ?? "记一下今天吃了火锅";
const full = args.includes("--full");
const configArgIndex = args.indexOf("--config");
const configPath = configArgIndex >= 0 ? args[configArgIndex + 1] : null;

/** 默认用内置示例库（确定性）；--config 时用用户配置的副本 */
function resolveConfig() {
  if (!configPath) {
    return {
      label: "内置示例库（fixture）",
      config: {
        token: "ntn_diag",
        bindings: {
          diag: {
            dbId: "diag",
            title: "个人日常记录",
            description: "个人日常记录总表",
            fields: {
              Name: { type: "title", description: "记录标题，一般是当天日期" },
              标签: { type: "multi_select", description: "事项类别标签" },
              金额: { type: "number", description: "当日花销合计（元）" },
              心情: { type: "select", description: "当日整体心情" },
            },
          },
        },
        currentBindingId: "diag",
        _assistantMode: true,
      },
    };
  }
  const expanded = configPath.startsWith("~") ? join(homedir(), configPath.slice(1)) : configPath;
  return { label: `${configPath}（副本）`, config: JSON.parse(readFileSync(expanded, "utf8")) };
}

const { label, config } = resolveConfig();
const host = await assembleHost({ config });

try {
  const opts = await host.emit(prompt);
  const bytes = (s) => Buffer.byteLength(s, "utf8");

  console.log(`配置：${label}`);
  console.log(`输入：${prompt}`);
  console.log(`注册 tool：${host.tools.length} 个（${host.tools.sort().join(", ")}）`);
  console.log(`订阅事件：${host.handlers.sort().join(", ")}`);
  console.log("");
  console.log(`全局 guideline：${opts.promptGuidelines.length} 条`);
  console.log("注入 section：");

  const order = ["pition_core", "pition_scene", "pition_fields", "pition_runtime", "pition_goal", "pition_span"];
  const present = Object.keys(opts.sections ?? {});
  for (const name of order) {
    const text = opts.sections?.[name];
    console.log(
      text
        ? `  ✔ ${name.padEnd(16)} ${String(bytes(text)).padStart(5)} B`
        : `  · ${name.padEnd(16)}     —（本轮未注入）`,
    );
  }
  for (const extra of present.filter((n) => !order.includes(n))) {
    console.log(
      `  ✔ ${extra.padEnd(16)} ${String(bytes(opts.sections[extra])).padStart(5)} B  （未登记的 section 名，检查注入代码）`,
    );
  }

  const kept = [];
  const pruned = [];
  for (const name of EXPECTED_TOOLS) {
    (opts.toolGuidelines?.[name]?.length ? kept : pruned).push(name);
  }
  console.log("");
  console.log(`tool guideline：保留 ${kept.length} 个（${kept.join(", ") || "无"}）`);
  console.log(`                裁掉 ${pruned.length} 个（${pruned.join(", ") || "无"}）——工具本身仍可调用`);
  if (!opts.toolGuidelines) console.log("                （宿主不支持 toolGuidelines，已跳过裁剪）");

  if (full) {
    for (const name of order) {
      if (!opts.sections?.[name]) continue;
      console.log(`\n───── ${name} ─────\n${opts.sections[name]}`);
    }
  } else {
    console.log("\n（加 --full 打印 section 正文）");
  }
} finally {
  host.dispose();
}
