/**
 * web/views/var-struct-source.js 的类型声明（供 TS 测试 import；权威运行时行为见 var-struct-source.js）。
 */
export const STRUCT_MODE_HINT: {
  readonly session: string;
  readonly pack: string;
};

export function isNoActiveSession(err: unknown): boolean;

export function buildSysSaveBody(args: {
  varsTemplate: unknown;
  varsTags: unknown;
  baseRevision: number;
}): { sys: { varsTemplate: unknown; varsTags: unknown }; baseRevision: number };

export function savedRevision(response: unknown, fallback: number): number;
