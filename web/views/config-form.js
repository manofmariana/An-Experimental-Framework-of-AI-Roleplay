/**
 * 配置页请求体构造纯逻辑：
 * 零 DOM 零网络——表单原始字符串 → 请求 payload；页面层（pages/config.js）只负责
 * 把这些构造函数接到真实 api 与 DOM 上。与 contracts/config.ts、contracts/secrets.ts
 * 的 schema 对齐（前端先行校验，服务端 zod 仍是权威）。
 *
 * 语义：
 * - settings patch 留空 = 保持不变（留空字段不出现在 payload；服务端各字段缺省即保留）；
 * - 掩码防呆：任何值形如服务端掩码（含 "…" 或连续 4 个以上 "*"）即拒构造抛错——
 *   防止把公共视图里的掩码（"****3456"）当新 key/新值写回；
 * - preset 表单 → ApiPreset payload（jsonMode 三态：留空 = 省略 = 默认关）；
 * - agent 绑定 patch：agentPresets 整体替换语义（未选 = 解绑，key 不出现）。
 */

/** UI 固定的密钥种类（契约层是开放字符串；当前服务端只有 deepseek 一类）。 */
export const SECRET_KIND = "deepseek";

/**
 * 掩码特征判定：服务端掩码形状 = "****" + 至多末 4 位（contracts/secrets.ts maskSecret）。
 * 防呆放宽到「含 … 或连续 ≥4 个 *」，宁可误拒真实值也不让掩码回流成新值。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isMaskedValue(value) {
  if (typeof value !== "string") return false;
  return value.includes("…") || /\*{4}/.test(value);
}

/**
 * 掩码防呆闸：值形如掩码即抛错（拒构造）。
 * @param {string} value 已 trim 的值
 * @param {string} field 字段中文名（进错误消息）
 */
export function assertNotMasked(value, field) {
  if (isMaskedValue(value)) {
    throw new Error(`${field}看起来是掩码值（含 … 或 ****），不是真实内容，已拒绝提交`);
  }
}

function requireNonEmpty(value, field) {
  const v = String(value ?? "").trim();
  if (!v) throw new Error(`${field}不能为空`);
  return v;
}

/**
 * 新增密钥请求体（POST /api/secrets）：{kind, value, label}。
 * @param {{label: string, value: string, kind?: string}} form 表单原始值
 */
export function buildSecretWriteBody({ label, value, kind = SECRET_KIND }) {
  const v = String(value ?? "").trim();
  if (!v) throw new Error("密钥值不能为空");
  assertNotMasked(v, "密钥值");
  return { kind, value: v, label: requireNonEmpty(label, "密钥标签") };
}

/**
 * 重命名请求体（POST /api/secrets/:kind/:id/rename）：{label}。
 * @param {{label: string}} form
 */
export function buildSecretRenameBody({ label }) {
  return { label: requireNonEmpty(label, "密钥标签") };
}

/**
 * preset 表单 → ApiPreset payload（POST /api/presets 的 preset 字段）。
 * @param {object} form
 * @param {string} [form.id] 编辑模式携带；新建省略（服务端生成）
 * @param {string} form.name
 * @param {string} form.provider
 * @param {string} form.baseUrl
 * @param {string} form.model
 * @param {string} [form.secretKind] 缺省 "deepseek"
 * @param {string} [form.secretId] 留空 = 省略（解析时用该 kind 的 active secret）
 * @param {string|boolean} [form.jsonMode] 三态："" = 省略；"true"/true = 开；"false"/false = 关
 * @param {string} [form.reasoningEffort] 留空 = 省略
 */
export function buildPresetPayload(form) {
  const name = requireNonEmpty(form.name, "预设名称");
  const provider = requireNonEmpty(form.provider, "provider");
  const baseUrl = requireNonEmpty(form.baseUrl, "baseUrl");
  const model = requireNonEmpty(form.model, "model");
  const secretKind = String(form.secretKind ?? "").trim() || SECRET_KIND;
  const secretId = String(form.secretId ?? "").trim();
  const reasoningEffort = String(form.reasoningEffort ?? "").trim();
  for (const [v, field] of [
    [name, "预设名称"],
    [provider, "provider"],
    [baseUrl, "baseUrl"],
    [model, "model"],
    [secretId, "secret 引用"],
    [reasoningEffort, "reasoningEffort"],
  ]) {
    assertNotMasked(v, field);
  }
  const payload = { name, provider, baseUrl, model, secretKind };
  if (form.id) payload.id = String(form.id);
  if (secretId) payload.secretId = secretId;
  if (form.jsonMode === true || form.jsonMode === "true") payload.jsonMode = true;
  else if (form.jsonMode === false || form.jsonMode === "false") payload.jsonMode = false;
  // "" / undefined = 三态留空 → 省略（服务端默认关）
  if (reasoningEffort) payload.reasoningEffort = reasoningEffort;
  return payload;
}

/**
 * agent 绑定 patch（PUT /api/config）：agentPresets 整体替换——
 * 未选（""）的 activation key 不出现 = 解绑。
 * @param {{character?: string, gm?: string, prose?: string}} selected 三个下拉的当前值
 */
export function buildAgentPresetsPatch(selected) {
  const agentPresets = {};
  for (const kind of ["character", "gm", "prose"]) {
    const v = String(selected[kind] ?? "").trim();
    if (v) agentPresets[kind] = v;
  }
  return { agentPresets };
}

/**
 * 运行设置 patch（PUT /api/config）：留空 = 保持不变（字段不出现）。
 * @param {{proseWindowTurns?: string, gmIntervalCycles?: string}} form 表单原始字符串
 */
export function buildSettingsPatch(form) {
  const patch = {};
  const pw = String(form.proseWindowTurns ?? "").trim();
  if (pw !== "") {
    const n = Number(pw);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error("正文滑窗轮数必须是 ≥0 的整数");
    }
    patch.proseWindowTurns = n;
  }
  const gm = String(form.gmIntervalCycles ?? "").trim();
  if (gm !== "") {
    const n = Number(gm);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error("GM 强制间隔必须是 ≥1 的整数");
    }
    patch.gmIntervalCycles = n;
  }
  return patch;
}
