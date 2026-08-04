/**
 * 资源上下文（优化阶段 D5，docs/optimization-review.md §10「ResourceContext」）：
 * 世界/角色等用户资源 URL 的唯一构造口。createResourceContext 捕获
 * {username, worldSetId} 即不可变——编辑表单打开时捕获，保存写同一捕获目标，
 * 不随 picker 当前值漂移（「打开 A 后切到 B 却把旧表单写入 B」的结构性消除）。
 *
 * 与服务端 D3 路由对齐：worlds/characters 域均已支持 ?set=（resolveWorldDir）。
 * 与 Session 的 runId/revision 身份分离（那是会话域，这是资源域）。
 *
 * 纯 ESM、零 DOM 零网络（node:test 可直接 import；resource-context.d.ts 供 TS 测试）。
 */

export const DEFAULT_USERNAME = "default_user";

/**
 * @param {object} identity
 * @param {string} [identity.username] 用户资源目录名（当前仅 default_user，预留多用户）
 * @param {string} identity.worldSetId 目标世界设定集（必填，空串即抛——无 set 的 URL 一律经 ctx 构造，不允许漏带）
 * @returns {Readonly<object>} 冻结的上下文：身份字段 + URL 构造器（全部携带 ?set=）
 */
export function createResourceContext({ username = DEFAULT_USERNAME, worldSetId } = {}) {
  if (typeof worldSetId !== "string" || worldSetId.trim() === "") {
    throw new Error("createResourceContext: worldSetId 必填（非空字符串）");
  }
  const set = worldSetId;
  const setQuery = `?set=${encodeURIComponent(set)}`;
  return Object.freeze({
    username,
    worldSetId: set,
    /** 世界设定集列表（不带 set——列表本身跨包）。 */
    worldSetsUrl: () => "/api/worlds",
    /** 世界三文件整读（setting + toneCard + lorebook）。 */
    worldUrl: () => `/api/world${setQuery}`,
    /** 世界单文件写（name ∈ setting / tone-card / lorebook）。 */
    worldFileUrl: (name) => `/api/world/${encodeURIComponent(name)}${setQuery}`,
    /** 角色 manifest 列表。 */
    charactersUrl: () => `/api/characters${setQuery}`,
    /** 单角色 manifest 读/写。 */
    characterUrl: (id) => `/api/characters/${encodeURIComponent(id)}${setQuery}`,
  });
}
