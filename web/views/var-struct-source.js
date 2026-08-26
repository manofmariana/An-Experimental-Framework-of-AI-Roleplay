/**
 * 世界页「变量结构」双模式数据源纯逻辑（零 DOM 零网络，node:test 可直接 import）。
 *
 * 模式判定：打开时页面探 GET /api/session/state/sys——成功 = 档内模式（数据源 = 应答的
 * varsTemplate/varsTags/tagRegistry + baseRevision；保存 = PUT /api/session/state 带 sys
 * 载荷，立即生效）；404 NO_ACTIVE_SESSION = 包基线模式（数据源 = 包三文件；保存 = 现状
 * PUT 包文件，新会话生效）。其余错误不属于模式判定，原样上抛。
 */

/** 模式提示行文案（常显）。 */
export const STRUCT_MODE_HINT = {
  session: "编辑目标：当前会话存档，保存后立即生效",
  pack: "编辑目标：世界包基线，新会话生效",
};

/** GET sys 端点错误 → 是否「无活跃会话」（包基线模式的唯一判据）。 */
export function isNoActiveSession(err) {
  return err !== null && typeof err === "object" && err.code === "NO_ACTIVE_SESSION";
}

/**
 * 档内模式保存载荷：sys 两份文件整体提交（单键替换语义在服务端，前端恒整体上送两模型
 * 工作副本——避免只存模板时附加文件对拍基准漂移）+ baseRevision 乐观并发闸。
 */
export function buildSysSaveBody({ varsTemplate, varsTags, baseRevision }) {
  return { sys: { varsTemplate, varsTags }, baseRevision };
}

/** 保存成功后的 baseRevision 推进：取服务端应答 revision（缺省/非法保持现值）。 */
export function savedRevision(response, fallback) {
  const rev = response !== null && typeof response === "object" ? response.revision : undefined;
  return Number.isInteger(rev) && rev >= 0 ? rev : fallback;
}
