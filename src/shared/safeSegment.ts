/**
 * 跨层基础工具：路径安全段校验（docs/optimization-review.md §9 服务端边界收敛）。
 * 原属 src/server/api.ts；移出后 HTTP transport、SessionManager、resources 等共用，
 * 消除 SessionManager 对 transport 层的反向依赖。
 * shared/ 不依赖 src 内任何域模块（依赖审计守护）。
 */

/**
 * 路径安全：拒绝 `..`、斜杠、空串、点开头——防目录穿越。
 * 通过则原样返回（调用方拼进受控目录）。
 */
export function safeSegment(name: string): string {
  if (
    name.length === 0 ||
    name.includes("..") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.startsWith(".") ||
    !/^[\w-]+(\.[\w-]+)*$/.test(name)
  ) {
    throw new Error(`非法名称: ${JSON.stringify(name)}`);
  }
  return name;
}
