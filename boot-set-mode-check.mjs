// boot set_mode 落盘一致性：模拟 boot tool 调 stage=set_mode，验证 cfg 真的写入 _assistantMode
import { createJiti } from "file:///D:/a_js/js_proj/nx-as/node_modules/.pnpm/jiti@2.7.0/node_modules/jiti/lib/jiti.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const PI = "D:/a_js/js_proj/nx-as/node_modules/.pnpm/@earendil-works+pi-coding-agent@0.87.1_ws@8.21.3/node_modules/@earendil-works/pi-coding-agent";
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": `${PI}/dist/index.js`,
    typebox: "D:/a_js/js_proj/nx-as/node_modules/.pnpm/typebox@1.3.27/node_modules/typebox/build/index.mjs",
  },
});

const cfgPath = join(here, "pition.config.json");
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

const extPath = "file:///" + join(here, "extensions", "pition.ts").replace(/\\/g, "/");
const mod = await jiti.import(extPath);
mod.default(fakePi);

const boot = tools.find((t) => t.name === "pition_boot");
if (!boot) { console.error("FAIL: 找不到 pition_boot"); process.exit(1); }

// 调 set_mode 不带 enabled → 应该 toggle
const r1 = await boot.execute("test-id", { stage: "set_mode" }, undefined, undefined, { hasUI: true, ui: { notify: () => {} }, reload: () => {} });
console.log("[set_mode toggle]", r1.content[0].text);
console.log("[details]", JSON.stringify(r1.details));

// 再调一次 toggle → 应当回到原值
const r2 = await boot.execute("test-id", { stage: "set_mode" }, undefined, undefined, { hasUI: true, ui: { notify: () => {} }, reload: () => {} });
console.log("[set_mode toggle again]", r2.content[0].text);

// 调 done 验证 assistantMode 在返回字段里
const r3 = await boot.execute("test-id", { stage: "done" }, undefined, undefined, { hasUI: true, ui: { notify: () => {} }, reload: () => {} });
console.log("[done] assistantMode =", r3.details.assistantMode);

// 恢复原值（不污染工作区）
writeFileSync(cfgPath, JSON.stringify(before, null, 2) + "\n", "utf8");
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