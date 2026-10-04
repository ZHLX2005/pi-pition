// new-extension.mjs 的类型声明：给 TS 侧测试一个稳定的边界契约
// （改参数名/返回字段会让 test/new-extension.test.ts 编译失败，而不是运行期 undefined）
export declare const USAGE: string;

export interface GenerateOptions {
  /** 目标根目录（不存在就创建） */
  target: string;
  /** 扩展名（决定 extensions/<name>.ts 与 package.json 的 name） */
  name: string;
  /** tool 名前缀；缺省 "<name>_" */
  prefix?: string;
  /** 目标已存在时仍写入 */
  force?: boolean;
}

export interface GenerateResult {
  root: string;
  name: string;
  prefix: string;
  /** pi 宿主版本下界（取自 src/injection/version.ts，不在脚手架里写死） */
  floor: string;
  /** 相对 root 的生成文件清单 */
  files: string[];
}

export declare function generate(options: GenerateOptions): GenerateResult;

export declare function main(
  argv: string[],
  io?: { log?: (m: string) => void; err?: (m: string) => void },
): number;
