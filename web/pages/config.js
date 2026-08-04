/**
 * 配置页：四区——
 * 密钥（/api/secrets）/ API 预设（/api/presets）/ Agent 绑定 + 运行设置（PUT /api/config）。
 * 页面持有 configRevision：所有 mutation 携带 baseConfigRevision；成功用返回的
 * {configRevision, view} 原地更新本地状态（不整页重取）；409 CONFIG_REVISION_CONFLICT
 * → 提示「配置已被他处修改，请刷新」并重取（对齐 state-editor 的 409 口径）。
 * 请求体构造纯逻辑在 views/config-form.js；密钥值绝不回填表单（公共视图只有掩码）。
 */
import { api, el } from "../app.js";
import {
  SECRET_KIND,
  buildAgentPresetsPatch,
  buildPresetPayload,
  buildSecretRenameBody,
  buildSecretWriteBody,
  buildSettingsPatch,
} from "../views/config-form.js";

const AGENT_LABELS = { character: "角色", gm: "GM", prose: "正文" };

export async function renderConfig(root) {
  root.appendChild(el("h2", null, "配置"));
  root.appendChild(
    el("div", "muted", "保存后立即生效（无需新会话）。环境变量 DEEPSEEK_API_KEY 等部署级覆盖优先于此处配置。"),
  );

  // ---- 页面状态：ConfigStateView + configRevision（并发闸） ----
  const state = { view: null, revision: 0 };
  const load = async () => {
    state.view = await api("/api/config");
    state.revision = state.view.settings.configRevision ?? 0;
  };
  await load();

  /** mutation 统一收口：成功 → 用返回的 {configRevision, view} 更新 + refresh；409 → 提示并重取。 */
  const runMutation = async (statusEl, fn) => {
    statusEl.textContent = "";
    try {
      const result = await fn();
      state.view = result.view;
      state.revision = result.configRevision;
      refresh();
      statusEl.textContent = " 已保存并生效";
      return true;
    } catch (err) {
      if (err.code === "CONFIG_REVISION_CONFLICT") {
        statusEl.textContent = " 配置已被他处修改，请刷新（已重取最新状态）";
        try {
          await load();
          refresh();
        } catch {
          /* 重取失败保留提示即可 */
        }
      } else if (err.code === "PRESET_IN_USE") {
        statusEl.textContent = " 该预设正被 agent 绑定，请先在「Agent 绑定」区解除引用";
      } else {
        statusEl.textContent = ` 操作失败：${err.message}`;
      }
      return false;
    }
  };

  // =========================================================================
  // 1. 密钥区
  // =========================================================================
  root.appendChild(el("h3", null, "密钥（API key）"));
  const secretsList = el("div");
  const secretStatus = el("span", "muted");
  const newLabel = document.createElement("input");
  newLabel.placeholder = "标签（如：主力 key）";
  const newValue = document.createElement("input");
  newValue.type = "password";
  newValue.placeholder = "密钥值（只写入，不回填）";
  const addSecret = el("button", "act", "新增密钥");
  addSecret.onclick = async () => {
    let body;
    try {
      body = buildSecretWriteBody({ label: newLabel.value, value: newValue.value });
    } catch (err) {
      secretStatus.textContent = ` ${err.message}`;
      return;
    }
    const ok = await runMutation(secretStatus, () =>
      api("/api/secrets", "POST", { ...body, baseConfigRevision: state.revision }),
    );
    if (ok) {
      newLabel.value = "";
      newValue.value = "";
    }
  };
  const addForm = el("div");
  addForm.append(newLabel, newValue, addSecret, secretStatus);
  root.append(secretsList, addForm);

  const renderSecrets = () => {
    secretsList.textContent = "";
    const records = state.view.secrets[SECRET_KIND] ?? [];
    if (records.length === 0) {
      secretsList.appendChild(el("div", "muted", "（还没有密钥，请在下方新增）"));
      return;
    }
    for (const rec of records) {
      const row = el("div", "config-row");
      row.appendChild(el("span", null, rec.label));
      row.appendChild(el("span", "muted", ` ${rec.maskedValue}`));
      if (rec.active) row.appendChild(el("span", "muted", "（使用中）"));
      const reveal = el("span", "muted");

      const activate = el("button", "act", "激活");
      activate.disabled = rec.active;
      activate.onclick = () =>
        runMutation(secretStatus, () =>
          api(`/api/secrets/${SECRET_KIND}/${rec.id}/activate`, "POST", {
            baseConfigRevision: state.revision,
          }),
        );

      const rename = el("button", "act", "重命名");
      rename.onclick = async () => {
        const label = prompt("新标签", rec.label);
        if (label === null) return;
        let body;
        try {
          body = buildSecretRenameBody({ label });
        } catch (err) {
          secretStatus.textContent = ` ${err.message}`;
          return;
        }
        await runMutation(secretStatus, () =>
          api(`/api/secrets/${SECRET_KIND}/${rec.id}/rename`, "POST", {
            ...body,
            baseConfigRevision: state.revision,
          }),
        );
      };

      const del = el("button", "act", "删除");
      del.onclick = async () => {
        if (!confirm(`确定删除密钥「${rec.label}」（${rec.maskedValue}）？引用它的预设将回落到该类的 active 密钥。`)) return;
        await runMutation(secretStatus, () =>
          api(`/api/secrets/${SECRET_KIND}/${rec.id}`, "DELETE", {
            baseConfigRevision: state.revision,
          }),
        );
      };

      const view = el("button", "act", "查看明文");
      view.onclick = async () => {
        reveal.textContent = "";
        try {
          const data = await api(`/api/secrets/${SECRET_KIND}/${rec.id}/view`);
          reveal.textContent = ` 明文：${data.value}`;
        } catch (err) {
          reveal.textContent =
            err.code === "FORBIDDEN"
              ? " 服务端未开启密钥暴露（allowKeysExposure=false），无法查看明文"
              : ` 查看失败：${err.message}`;
        }
      };

      row.append(activate, rename, del, view, reveal);
      secretsList.appendChild(row);
    }
  };

  // =========================================================================
  // 2. API 预设区
  // =========================================================================
  root.appendChild(el("h3", null, "API 预设"));
  const presetsList = el("div");
  root.appendChild(presetsList);

  // 预设表单（新建 / 编辑共用；editingId 非空 = 编辑模式）
  const form = { editingId: null };
  const formTitle = el("div", "muted", "新建预设");
  const pName = presetInput("名称");
  const pProvider = presetInput("provider（如 deepseek）");
  const pBaseUrl = presetInput("baseUrl");
  const pModel = presetInput("model");
  const pSecret = document.createElement("select"); // secret 引用下拉（refresh 时重建选项）
  const pJsonMode = document.createElement("select");
  for (const [v, label] of [["", "json_mode：留空 = 默认关"], ["true", "json_mode：开"], ["false", "json_mode：关"]]) {
    const opt = el("option", null, label);
    opt.value = v;
    pJsonMode.appendChild(opt);
  }
  const pEffort = presetInput("reasoningEffort（如 low/medium/high，可留空）");

  function presetInput(placeholder) {
    const input = document.createElement("input");
    input.placeholder = placeholder;
    return input;
  }
  const resetPresetForm = () => {
    form.editingId = null;
    formTitle.textContent = "新建预设";
    for (const input of [pName, pProvider, pBaseUrl, pModel, pEffort]) input.value = "";
    pSecret.value = "";
    pJsonMode.value = "";
  };
  const presetStatus = el("span", "muted");
  const savePreset = el("button", "act", "保存预设");
  savePreset.onclick = async () => {
    let preset;
    try {
      preset = buildPresetPayload({
        id: form.editingId ?? undefined,
        name: pName.value,
        provider: pProvider.value,
        baseUrl: pBaseUrl.value,
        model: pModel.value,
        secretId: pSecret.value,
        jsonMode: pJsonMode.value,
        reasoningEffort: pEffort.value,
      });
    } catch (err) {
      presetStatus.textContent = ` ${err.message}`;
      return;
    }
    const ok = await runMutation(presetStatus, () =>
      api("/api/presets", "POST", { preset, baseConfigRevision: state.revision }),
    );
    if (ok) resetPresetForm();
  };
  const cancelEdit = el("button", "act", "清空/新建");
  cancelEdit.onclick = resetPresetForm;
  const presetForm = el("div");
  presetForm.append(formTitle, el("div"), pName, pProvider, pBaseUrl, pModel, pSecret, pJsonMode, pEffort, el("div"), savePreset, cancelEdit, presetStatus);
  root.appendChild(presetForm);

  /** secret 引用下拉选项重建（数据 = 掩码态密钥列表；值 = secretId，"" = 用该类 active）。 */
  const renderSecretOptions = () => {
    const selected = pSecret.value;
    pSecret.textContent = "";
    const activeOpt = el("option", null, "secret：使用该类的 active 密钥");
    activeOpt.value = "";
    pSecret.appendChild(activeOpt);
    for (const rec of state.view.secrets[SECRET_KIND] ?? []) {
      const opt = el("option", null, `secret：${rec.label}（${rec.maskedValue}）`);
      opt.value = rec.id;
      pSecret.appendChild(opt);
    }
    pSecret.value = selected; // 选项仍在则保留选择，否则回落 ""
  };

  const renderPresets = () => {
    presetsList.textContent = "";
    if (state.view.presets.length === 0) {
      presetsList.appendChild(el("div", "muted", "（还没有预设，请在下方新建）"));
      return;
    }
    for (const p of state.view.presets) {
      const row = el("div", "config-row");
      row.appendChild(el("span", null, p.name));
      row.appendChild(el("span", "muted", ` ${p.provider} · ${p.model} · ${p.baseUrl}`));

      const edit = el("button", "act", "编辑");
      edit.onclick = () => {
        form.editingId = p.id;
        formTitle.textContent = `编辑预设：${p.name}`;
        pName.value = p.name;
        pProvider.value = p.provider;
        pBaseUrl.value = p.baseUrl;
        pModel.value = p.model;
        pSecret.value = p.secretId ?? "";
        pJsonMode.value = p.jsonMode === true ? "true" : p.jsonMode === false ? "false" : "";
        pEffort.value = p.reasoningEffort ?? "";
      };

      const dup = el("button", "act", "复制");
      dup.onclick = () =>
        runMutation(presetStatus, () =>
          api(`/api/presets/${p.id}/duplicate`, "POST", { baseConfigRevision: state.revision }),
        );

      const del = el("button", "act", "删除");
      del.onclick = async () => {
        if (!confirm(`确定删除预设「${p.name}」？`)) return;
        await runMutation(presetStatus, () =>
          api(`/api/presets/${p.id}`, "DELETE", { baseConfigRevision: state.revision }),
        );
      };

      row.append(edit, dup, del);
      presetsList.appendChild(row);
    }
  };

  // =========================================================================
  // 3. Agent 绑定区（三 activation → preset）
  // =========================================================================
  root.appendChild(el("h3", null, "Agent 绑定"));
  const bindingSelects = {};
  for (const kind of ["character", "gm", "prose"]) {
    const wrap = el("label", "field");
    wrap.appendChild(el("span", null, `${AGENT_LABELS[kind]}（${kind}）使用的预设`));
    const select = document.createElement("select");
    bindingSelects[kind] = select;
    wrap.appendChild(select);
    root.appendChild(wrap);
  }
  const bindingStatus = el("span", "muted");
  const saveBindings = el("button", "act", "保存绑定");
  saveBindings.onclick = () =>
    runMutation(bindingStatus, () =>
      api("/api/config", "PUT", {
        ...buildAgentPresetsPatch({
          character: bindingSelects.character.value,
          gm: bindingSelects.gm.value,
          prose: bindingSelects.prose.value,
        }),
        baseConfigRevision: state.revision,
      }),
    );
  root.append(el("div"), saveBindings, bindingStatus);

  /** 绑定下拉选项重建（数据 = 预设列表；选中值 = settings.agentPresets）。 */
  const renderBindings = () => {
    const bindings = state.view.settings.agentPresets ?? {};
    for (const kind of ["character", "gm", "prose"]) {
      const select = bindingSelects[kind];
      select.textContent = "";
      const none = el("option", null, "（未绑定）");
      none.value = "";
      select.appendChild(none);
      for (const p of state.view.presets) {
        const opt = el("option", null, p.name);
        opt.value = p.id;
        select.appendChild(opt);
      }
      select.value = bindings[kind] ?? "";
    }
  };

  // =========================================================================
  // 4. 运行设置区（旧页搬来：校验逻辑在 config-form.buildSettingsPatch）
  // =========================================================================
  root.appendChild(el("h3", null, "运行设置"));
  const pwWrap = el("label", "field");
  pwWrap.appendChild(el("span", null, "正文滑窗轮数（prose_window_turns）"));
  const pwInput = document.createElement("input");
  pwInput.type = "number";
  pwInput.min = "0";
  pwInput.step = "1";
  pwInput.placeholder = "留空 = 保持不变（默认 5）";
  pwWrap.appendChild(pwInput);
  const gmWrap = el("label", "field");
  gmWrap.appendChild(el("span", null, "GM 强制间隔（行动周期数）"));
  const gmInput = document.createElement("input");
  gmInput.type = "number";
  gmInput.min = "1";
  gmInput.step = "1";
  gmInput.placeholder = "留空 = 保持不变（默认 3）";
  gmWrap.appendChild(gmInput);
  const settingsStatus = el("span", "muted");
  const saveSettings = el("button", "act", "保存运行设置");
  saveSettings.onclick = async () => {
    let patch;
    try {
      patch = buildSettingsPatch({
        proseWindowTurns: pwInput.value,
        gmIntervalCycles: gmInput.value,
      });
    } catch (err) {
      settingsStatus.textContent = ` 保存失败：${err.message}`;
      return;
    }
    await runMutation(settingsStatus, () =>
      api("/api/config", "PUT", { ...patch, baseConfigRevision: state.revision }),
    );
  };
  root.append(pwWrap, gmWrap, el("div"), saveSettings, settingsStatus);

  /** 全部动态区重渲（数据 = 本地 state.view，不重取）。 */
  function refresh() {
    renderSecrets();
    renderSecretOptions();
    renderPresets();
    renderBindings();
    pwInput.value = state.view.settings.proseWindowTurns ?? "";
    gmInput.value = state.view.settings.gmIntervalCycles ?? "";
  }
  refresh();
}
