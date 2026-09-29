/** knip 配置：检测未使用的文件、导出、依赖。
 *
 * 范围严格限定在本项目源码 —— `.claude/` 下是 clone 的参考仓库，
 * 不排除会让 knip 递归扫描外部代码（实测直接 OOM）。
 */
export default {
  entry: ["index.ts", "extensions/pition.ts", "test/**/*.test.ts", "scripts/**/*.mjs"],
  project: ["src/**/*.ts", "extensions/**/*.ts", "test/**/*.ts"],
  ignore: [".claude/**"],
  ignoreExportsUsedInFile: true,
};
