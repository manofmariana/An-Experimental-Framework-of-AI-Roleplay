/**
 * web/views/system-char-decl.js 的类型声明（供 TS 测试 import；权威运行时行为见 system-char-decl.js）。
 * 本模块是服务端 src/vars/systemChar.ts 的镜像，变更需两侧同步。
 */

/** 原始声明节点形态（字符串简写末端 / {children} 容器 / {array} 结构化数组 / 完整形末端）。 */
export type RawDecl = unknown;

/** character 根系统声明子树（键序 = 界面呈现序，位于作者声明之前）。 */
export const SYSTEM_CHAR_DECLS: Record<string, RawDecl>;

/** 系统类型声明（relations 数组元素引用 relation）。 */
export const SYSTEM_CHAR_TYPES: Record<string, { children: Record<string, RawDecl> }>;

/** 系统分支键集。 */
export const SYSTEM_CHAR_KEYS: ReadonlySet<string>;
