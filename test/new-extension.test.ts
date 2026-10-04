// 脚手架自检：别人照着「一条命令造扩展」走时，最怕的是**生成出来的东西悄悄不对**——
// 尤其这两条，坏了没有任何报错：
//   1. 复制过去的 src/injection/ 与仓库里的不是同一份（改了内核不同步 → 复用失效）
//   2. package.json 的 pi 下界写错/写旧 → 装上后零注入，且 pi 的错误边界会吞掉异常
//
// 直接 import 而不是 spawn 子进程：生成逻辑在进程内跑，断言的是真实产物。
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { generate, main, USAGE } from "../scripts/new-extension.mjs";
import { MIN_PI_FOR_STRUCTURED } from "../src/injection/version.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const KERNEL_DIR = join(REPO_ROOT, "src", "injection");
const SCRATCH = mkdtempSync(join(tmpdir(), "pition-new-ext-"));

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

function tree(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...tree(dir, r));
    else out.push(r);
  }
  return out.sort();
}

const TARGET = join(SCRATCH, "snip");
const RESULT = generate({ target: TARGET, name: "snip" });

describe("new-extension.mjs", () => {
  it("生成完整的骨架（含 tsconfig —— 没有它 tsc 直接 TS18003）", () => {
    for (const rel of [
      "package.json",
      "tsconfig.json",
      "index.ts",
      "extensions/snip.ts",
      "src/state.ts",
      "src/scenes.ts",
      "src/spec.ts",
      "test/injection.test.ts",
      "README.md",
    ]) {
      expect(RESULT.files, `缺 ${rel}`).toContain(rel);
      expect(readFileSync(join(TARGET, rel), "utf8").length, `${rel} 是空的`).toBeGreaterThan(0);
    }
  });

  it("复制过去的 src/injection/ 与仓库里的逐字节相同", () => {
    const mine = join(TARGET, "src", "injection");
    expect(tree(mine)).toEqual(tree(KERNEL_DIR));
    for (const rel of tree(KERNEL_DIR)) {
      expect(readFileSync(join(mine, rel), "utf8"), `内核文件被改动：${rel}`).toBe(
        readFileSync(join(KERNEL_DIR, rel), "utf8"),
      );
    }
  });

  it("package.json 是合法 JSON，且 pi 下界取自内核的单一真相源", () => {
    const pkg = JSON.parse(readFileSync(join(TARGET, "package.json"), "utf8"));
    expect(pkg.name).toBe("snip");
    expect(pkg.peerDependencies["@earendil-works/pi-coding-agent"]).toBe(`>=${MIN_PI_FOR_STRUCTURED}`);
    // 内核 bytes.ts 用了 Buffer：缺 @types/node 时 vitest 照样绿、tsc 才报 TS2580
    expect(pkg.devDependencies["@types/node"]).toBeTruthy();
    expect(pkg.pi.extensions).toEqual(["./extensions/snip.ts"]);
  });

  it("所有生成文件里的 {{TOKEN}} 都被替换掉了", () => {
    for (const rel of tree(TARGET)) {
      if (rel.startsWith("src/injection/")) continue;
      expect(readFileSync(join(TARGET, rel), "utf8"), `${rel} 里有未替换的占位符`).not.toMatch(/\{\{[A-Z_]+\}\}/);
    }
  });

  it("tool 前缀按 --prefix 走，用于 tool_execution_end 的结果采集", () => {
    generate({ target: join(SCRATCH, "custom"), name: "custom", prefix: "cx_" });
    expect(readFileSync(join(SCRATCH, "custom", "src", "spec.ts"), "utf8")).toContain('toolPrefix: "cx_"');
    expect(readFileSync(join(SCRATCH, "custom", "extensions", "custom.ts"), "utf8")).toContain(
      "createInjectionRuntime(spec, state).attach(pi)",
    );
  });

  it("目录已存在 → 抛错，绝不覆盖用户已有的东西；--force 才写", () => {
    expect(() => generate({ target: TARGET, name: "snip" })).toThrow(/已存在/);
    expect(() => generate({ target: TARGET, name: "snip", force: true })).not.toThrow();
  });

  it("扩展名不合法直接拒（防止生成出不适配 pi 的目录名）", () => {
    expect(() => generate({ target: join(SCRATCH, "bad"), name: "Bad_Name" })).toThrow(/不合法/);
  });

  it("CLI：不带参数打印用法并返回非零码（不会静默生成一个空目录）", () => {
    const out: string[] = [];
    const code = main([], { log: (m) => out.push(m) });
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("用法");
    expect(out.join("\n")).toContain("--force");
    expect(USAGE).toContain("--name");
  });

  it("CLI：--help 退出码 0；参数错误退出码 1 且不抛", () => {
    expect(main(["--help"], { log: () => {} })).toBe(0);
    const errs: string[] = [];
    expect(main([join(SCRATCH, "bad2"), "--name", "Bad_Name"], { log: () => {}, err: (m) => errs.push(m) })).toBe(1);
    expect(errs.join("\n")).toContain("不合法");
  });
});
