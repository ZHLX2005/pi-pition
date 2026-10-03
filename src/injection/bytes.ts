// 注入预算的度量原语 —— 「每轮让模型多看到多少字节」必须可算。
//
// 为什么需要：谁都能往提示词里加一句，但没有度量就不会有人为它负责，
// 常驻注入会一路膨胀（膨胀的代价是每轮 token + 用噪音稀释真正的指令）。
// 把度量做成纯函数、把结果固化成产物、在 CI 里校验是否漂移 —— 这是唯一可靠的刹车。
//
// 本文件只给**原语**（字节/行数/转义/单场景度量）；上限与违规文案是**每个扩展自己的事**
// （你的常驻面多大，取决于你的 tool 有多少、skill 有多长）。
export interface ByteSurface {
  /** 口径说明（进台账，让后来人知道这个数字是怎么来的） */
  serialization: string;
  bytes: number;
  lines: number;
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

export function surface(serialization: string, text: string): ByteSurface {
  return { serialization, bytes: utf8Bytes(text), lines: lineCount(text) };
}

/** 按已知数字造 ByteSurface（聚合面用：文本本身不落台账） */
export function summed(serialization: string, bytes: number, lines: number): ByteSurface {
  return { serialization, bytes, lines };
}

/** 与 pi 的 `formatSkillsForPrompt` 同源转义（& < >）——台账要复现模型真正看到的字符数 */
export function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** pi 的 skills 发现条目：一个 skill 每轮常驻的那一小段 XML */
export interface SkillEntry {
  root: string;
  name: string;
  description: string;
}

/** 与 pi 的 formatSkillsForPrompt 逐字符对齐（4 空格缩进 + escapeXml + location 指到 SKILL.md） */
export function renderSkillEntry(skill: SkillEntry): string {
  return [
    "  <skill>",
    `    <name>${escapeXml(skill.name)}</name>`,
    `    <description>${escapeXml(skill.description)}</description>`,
    `    <location>${escapeXml(`${skill.root}/SKILL.md`)}</location>`,
    "  </skill>",
  ].join("\n");
}

/** 单场景注入面的度量（sections 逐段字节 + 合计） */
export interface SceneMeasure {
  id: string;
  bytes: number;
  sections: Array<{ name: string; bytes: number }>;
}

export function measureSceneSections(scene: { id: string; sections: Record<string, string> }): SceneMeasure {
  const sections = Object.entries(scene.sections).map(([name, text]) => ({ name, bytes: utf8Bytes(text) }));
  return { id: scene.id, bytes: sections.reduce((sum, s) => sum + s.bytes, 0), sections };
}

/** 一组 guideline 子弹（`- xxx\n`）的字节 */
export function measureGuidelines(bullets: string[]): ByteSurface {
  return surface("UTF-8 bytes of LF-joined Pi prompt guideline bullets", bullets.map((g) => `- ${g}`).join("\n"));
}
