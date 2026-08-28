/**
 * 四个竞态修复的可测纯逻辑：
 * 零 DOM 零网络——取数函数注入 apiFn，守卫为纯函数；页面层（sessions.js/play.js 及其 view）
 * 只负责把守卫接到真实 api 与 DOM 上。 AbortController 只停无用工作，最终正确性靠这里的
 * epoch/身份检查。
 *
 * 覆盖点：
 * - 竞态 1（会话详情 A/B 晚到互写）：createEpochGuard + fetchRunDetail（取数/渲染分离）；
 * - 竞态 2（world A→B CID 逆序覆盖 knownChars）：fetchKnownChars + sameCharsIdentity；
 * - 竞态 3（WS 未连接读档仍导航）：loadSessionThenNavigate（成功才导航）；
 * - 竞态 4（会话 modal 晚到展示上一 run）：isModalLive（runId 身份 + isConnected 双核验）。
 */

/**
 * 请求 epoch 守卫：每次进入 begin() 取新令牌并使旧令牌失效；
 * await 后 isCurrent(token) 不符 = 已有更新请求接管，晚到者弃写。
 */
export function createEpochGuard() {
  let epoch = 0;
  return {
    begin: () => ++epoch,
    isCurrent: (token) => token === epoch,
  };
}

/**
 * 会话回放六端点取数 + 形状归一（数据获取与渲染分离的可测一半）。
 * @param {(path: string) => Promise<any>} apiFn GET JSON 助手（调用方可包 signal）
 * @param {string} id runId
 */
export async function fetchRunDetail(apiFn, id) {
  const [events, world, characters, archive, sys, stats] = await Promise.all([
    apiFn(`/api/sessions/${id}/events`),
    apiFn(`/api/sessions/${id}/world`),
    apiFn(`/api/sessions/${id}/characters`),
    apiFn(`/api/sessions/${id}/archive`),
    apiFn(`/api/sessions/${id}/sys`),
    apiFn(`/api/sessions/${id}/stats`),
  ]);
  return {
    events: events?.events ?? [],
    world: world?.world ?? {},
    pipeline: sys?.pipeline ?? {},
    characters: characters?.characters ?? {},
    archive: archive?.entries ?? [],
    stats: stats ?? [],
  };
}

/**
 * CID 下拉数据源取数（竞态 2 的可测一半）：有活跃会话读档内 characters，
 * 否则读世界设定集 manifest（带 ?set=）；C0 玩家恒排除。
 * @param {(path: string) => Promise<any>} apiFn
 * @param {{runId: string|null, worldSetId?: string}} identity 调用时捕获的身份
 */
export async function fetchKnownChars(apiFn, { runId, worldSetId }) {
  if (runId !== null && runId !== undefined) {
    const data = await apiFn(`/api/sessions/${runId}/characters`);
    return Object.entries(data?.characters ?? {})
      .map(([cid, c]) => ({ cid, name: c?.name ?? cid }))
      .filter((c) => c.cid !== "C0");
  }
  const setQuery = worldSetId ? `?set=${encodeURIComponent(worldSetId)}` : "";
  const data = await apiFn(`/api/characters${setQuery}`);
  return (data ?? [])
    .map((item) => ({ cid: item.id, name: item.manifest?.name ?? item.id }))
    .filter((c) => c.cid !== "C0");
}

/**
 * CID 请求身份核验（竞态 2 的写闸）：await 期间会话或世界包已切换 → false，晚到响应不得写入。
 * @param {{runId: string|null, worldSetId?: string}} captured 请求发起时捕获
 * @param {{runId: string|null, worldSetId?: string}} current 响应到达时的当前身份
 */
export function sameCharsIdentity(captured, current) {
  return (
    captured.runId === current.runId &&
    (captured.worldSetId ?? "") === (current.worldSetId ?? "")
  );
}

/**
 * 会话绑定 modal 存活判定（竞态 4）：捕获 runId 与当前一致 且 元素仍在 DOM。
 * runId 变化时页面层统一 remove 存活 modal（isConnected 变 false），本判定兜住
 * 「remove 之前已发出的晚到响应」。
 */
export function isModalLive(capturedRunId, currentRunId, isConnected) {
  return capturedRunId === currentRunId && isConnected === true;
}

/**
 * 读档后导航（竞态 3）：load_session 的 command_result（按 requestId 匹配）成功才 navigate；
 * 失败（含 WS 未连接立即 reject）原样抛出，由调用方在原页显示错误、不导航。
 * @param {{sendCommand: (type: string, fields?: object) => Promise<any>,
 *          navigate: (page: string) => any}} deps
 */
export async function loadSessionThenNavigate({ sendCommand, navigate }, runId) {
  await sendCommand("load_session", { runId });
  await navigate("play");
}
