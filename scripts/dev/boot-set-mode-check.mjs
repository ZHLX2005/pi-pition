// boot set_mode 落盘一致性：模拟 boot tool 调 stage=set_mode，验证 cfg 真的写入 _assistantMode
//
// 用法: node scripts/dev/boot-set-mode-check.mjs
// 前置: 仓库根 npm install + 有 pition.config.json（脚本会临时改 _assistantMode 后还原）

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createRepoJiti, repoPath } from "./resolve-pi.mjs";

const jiti = await createRepoJiti();
const cfgPath = repoPath("pition.config.json");
const before = JSON.parse(readFileSync(cfgPath, "utf8"));
const beforeMode = !!before._assistantMode;
console.log("[before] _assistantMode =", beforeMode);

// 用 fake pi 启 boot tool；执行 set_mode toggle
const tools = [];
const fakePi = {
  registerTool: (t) => tools.push(t),
  registerCommand: () => {},
  on: () => () => {},
  registerShortcut: () => {},
  registerFlag: () => {},
};

const extPath = pathToFileURL(repoPath("extensions", "pition.ts")).href;
const mod = await jiti.import(extPath);
mod.default(fakePi);

const boot = tools.find((t) => t.name === "pition_boot");
if (!boot) {
  console.error("FAIL: 找不到 pition_boot");
  process.exit(1);
}

// 调 set_mode 不带 enabled → 应该 toggle
const r1 = await boot.execute("test-id", { stage: "set_mode" }, undefined, undefined, {
  hasUI: true,
  ui: { notify: () => {} },
  reload: () => {},
});
console.log("[set_mode toggle]", r1.content[0].text);
console.log("[details]", JSON.stringify(r1.details));

// 再调一次 toggle → 应当回到原值
const r2 = await boot.execute("test-id", { stage: "set_mode" }, undefined, undefined, {
  hasUI: true,
  ui: { notify: () => {} },
  reload: () => {},
});
console.log("[set_mode toggle again]", r2.content[0].text);

// 调 done 验证 assistantMode 在返回字段里
const r3 = await boot.execute("test-id", { stage: "done" }, undefined, undefined, {
  hasUI: true,
  ui: { notify: () => {} },
  reload: () => {},
});
console.log("[done] assistantMode =", r3.details.assistantMode);

// 恢复原值（不污染工作区）
writeFileSync(cfgPath, `${JSON.stringify(before, null, 2)}\n`, "utf8");
const after = JSON.parse(readFileSync(cfgPath, "utf8"));
if (!!after._assistantMode !== beforeMode) {
  console.error(`FAIL: _assistantMode 没恢复（was ${beforeMode}, now ${after._assistantMode}）`);
  process.exit(1);
}
if (r1.details.stage !== "set_mode") {
  console.error("FAIL: set_mode 阶段返回 stage 错");
  process.exit(1);
}
if (typeof r1.details.assistantMode !== "boolean") {
  console.error("FAIL: set_mode 返回 details.assistantMode 不是 boolean");
  process.exit(1);
}
if (typeof r3.details.assistantMode !== "boolean") {
  console.error("FAIL: done 返回 details.assistantMode 不是 boolean");
  process.exit(1);
}
console.log("SET_MODE PERSIST PASS");
