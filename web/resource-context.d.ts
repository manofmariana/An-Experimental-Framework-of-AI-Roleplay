/**
 * web/resource-context.js 的类型声明（供 TS 测试 import；权威运行时行为见 resource-context.js）。
 */
export const DEFAULT_USERNAME: string;

export interface ResourceContext {
  readonly username: string;
  readonly worldSetId: string;
  worldSetsUrl(): string;
  worldUrl(): string;
  worldFileUrl(name: string): string;
  charactersUrl(): string;
  characterUrl(id: string): string;
}

export function createResourceContext(identity?: {
  username?: string;
  worldSetId?: string;
}): ResourceContext;
