/** 世界页：世界包选择器 + lorebook 条目表格（增删改、enabled 开关）
 *  + 变量结构区（变量模板声明树编辑 + TAG 附加编辑，双模式：有活跃会话 = 档内副本
 *  （GET /api/session/state/sys 取数，PUT /api/session/state 带 sys 保存，立即生效），
 *  无 = 包基线（PUT 包文件，新会话生效）；模式指示行常显）。
 *  ResourceContext：打开即捕获不可变 ctx
 *  （GET/PUT 全程携带 ?set=——修复「无法编辑非默认包」）；切换包 = 重新捕获 ctx + 重载表单
 *  （旧表单不存活）；保存写打开时捕获的同一 ctx，不重读 picker；界面上持续显示「正在编辑」的包名。 */
import { api, el } from "../app.js";
import { createResourceContext } from "../resource-context.js";
import { createVarDeclEditor, createVarsTagsEditor } from "../views/var-decl-editor.js";
import { createVarDeclModel } from "../views/var-decl-model.js";
import { createVarsTagsModel } from "../views/vars-tags-model.js";
import { STRUCT_MODE_HINT, buildSysSaveBody, isNoActiveSession, savedRevision } from "../views/var-struct-source.js";

export async function renderWorld(root) {
  root.appendChild(el("h2", null, "世界"));
  const { sets } = await api("/api/worlds");
  if (!sets || sets.length === 0) {
    root.appendChild(el("div", "muted", "（没有可用的世界设定集）"));
    return;
  }

  // 世界包选择器（数据源 = /api/worlds 列表端点）
  const bar = el("div", "world-set-bar");
  bar.appendChild(el("span", "muted", "世界包："));
  const picker = el("select");
  for (const s of sets) {
    const opt = el("option", null, s);
    opt.value = s;
    picker.appendChild(opt);
  }
  const editing = el("span", "muted");
  bar.append(picker, editing);
  const host = el("div");
  root.append(bar, host);

  const load = async (setId) => {
    const ctx = createResourceContext({ worldSetId: setId }); // 捕获即不可变
    editing.textContent = `　正在编辑：${ctx.worldSetId}`;
    host.textContent = "";
    await renderWorldForm(host, ctx);
  };
  picker.onchange = () => {
    load(picker.value).catch((err) => {
      host.textContent = "";
      host.appendChild(el("div", "line-error", `加载失败：${err.message}`));
    });
  };
  await load(picker.value);
}

/** 表单整体（lorebook 表格 + 变量结构区）；所有 URL 经捕获的 ctx 构造。 */
async function renderWorldForm(host, ctx) {
  const data = await api(ctx.worldUrl());

  // ---- lorebook 表格 ----
  host.appendChild(el("h3", null, "Lorebook 条目"));
  const table = el("table");
  const head = el("tr");
  for (const h of ["ID", "标签（名称:等级，逗号分隔；等级 1-7 可省略=1）", "内容", "启用", ""]) head.appendChild(el("th", null, h));
  table.appendChild(head);

  // 标签列文本形态："名称:等级, 名称2"（等级省略 = 1；名称里的全角冒号不影响解析，只认半角冒号）
  const tagsToText = (tags) => (tags ?? []).map((t) => `${t.name}:${t.level ?? 1}`).join(", ");
  const textToTags = (text) =>
    text
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((item) => {
        const at = item.lastIndexOf(":");
        if (at < 0) return { name: item, level: 1 };
        const level = Number.parseInt(item.slice(at + 1), 10);
        return { name: item.slice(0, at).trim(), level: Number.isInteger(level) && level >= 1 && level <= 7 ? level : 1 };
      })
      .filter((t) => t.name !== "");

  // 条目 = {id, content, enabled?} 全末端外壳（TAG 挂载全部落在 content.tags）
  const addRow = (entry) => {
    const tr = el("tr");
    const idIn = document.createElement("input");
    idIn.value = entry?.id?.value ?? "";
    const tagsIn = document.createElement("input");
    tagsIn.value = tagsToText(entry?.content?.tags);
    const contentIn = el("textarea");
    contentIn.rows = 2;
    contentIn.value = entry?.content?.value ?? "";
    const enabledIn = document.createElement("input");
    enabledIn.type = "checkbox";
    enabledIn.checked = entry?.enabled?.value !== false;
    const del = el("button", "act", "删");
    del.onclick = () => tr.remove();
    for (const node of [idIn, tagsIn, contentIn, enabledIn, del]) {
      const td = el("td");
      td.appendChild(node);
      tr.appendChild(td);
    }
    table.appendChild(tr);
  };
  for (const entry of data.lorebook) addRow(entry);
  host.appendChild(table);

  const addBtn = el("button", "act", "新增条目");
  addBtn.onclick = () => addRow();
  const saveBtn = el("button", "act", "保存 lorebook");
  const status = el("span", "muted");
  saveBtn.onclick = async () => {
    status.textContent = "";
    const entries = [];
    for (const tr of table.querySelectorAll("tr")) {
      const inputs = tr.querySelectorAll("input, textarea");
      if (inputs.length < 4) continue; // 表头
      const [idIn, tagsIn, contentIn, enabledIn] = inputs;
      if (!idIn.value.trim()) continue;
      entries.push({
        id: { value: idIn.value.trim(), tags: [] },
        content: { value: contentIn.value, tags: textToTags(tagsIn.value) },
        enabled: { value: enabledIn.checked, tags: [] },
      });
    }
    try {
      const resp = await api(ctx.worldFileUrl("lorebook"), "PUT", entries);
      status.textContent = ` ${resp.note}`;
    } catch (err) {
      status.textContent = ` 保存失败：${err.message}`;
    }
  };
  host.append(el("div"), addBtn, saveBtn, status);

  // ---- 变量结构（双模式：有活跃会话 = 档内副本立即生效；无 = 包基线新会话生效） ----
  host.appendChild(el("h3", null, "变量结构"));
  // 模式探测：GET sys 端点成功 = 档内模式；404 NO_ACTIVE_SESSION = 包基线模式（其余错误上抛）
  let mode = "pack";
  let varsTemplate;
  let varsTags;
  let tagNames;
  let baseRevision = 0; // 档内模式乐观并发闸值（保存成功随应答推进）
  try {
    const sysData = await api("/api/session/state/sys");
    mode = "session";
    varsTemplate = sysData.varsTemplate;
    varsTags = sysData.varsTags;
    tagNames = Object.keys(sysData.tagRegistry ?? {}); // 档内模式注册表 = 会话 sys 根 tagRegistry
    baseRevision = sysData.baseRevision;
  } catch (err) {
    if (!isNoActiveSession(err)) throw err;
    [varsTemplate, varsTags] = await Promise.all([
      api(ctx.worldFileUrl("vars-template")),
      api(ctx.worldFileUrl("vars-tags")),
    ]);
    const tagRegistry = await api(ctx.worldFileUrl("tags")); // 包基线模式注册表 = 包 tags.json
    tagNames = Object.keys(tagRegistry ?? {});
  }
  // 模式指示行（常显）
  host.appendChild(el("div", "muted", STRUCT_MODE_HINT[mode]));

  /** 统一保存出口：档内 = PUT 直编通道带 sys（两份整体上送 + 乐观闸）；包基线 = PUT 包文件。 */
  const saveStruct = async (fileName, payload, status) => {
    status.textContent = "";
    try {
      if (mode === "session") {
        const resp = await api(
          "/api/session/state",
          "PUT",
          buildSysSaveBody({
            varsTemplate: declModel.getTemplate(),
            varsTags: tagsModel.getPayload(),
            baseRevision,
          }),
        );
        baseRevision = savedRevision(resp, baseRevision);
        status.textContent = ` ${resp.note}`;
      } else {
        const resp = await api(ctx.worldFileUrl(fileName), "PUT", payload);
        status.textContent = ` ${resp.note}`;
      }
    } catch (err) {
      // 档内模式 409 = 会话 revision 已前进：提示重取，不静默覆盖
      status.textContent =
        err.code === "REVISION_CONFLICT"
          ? " 保存失败：会话状态已前进，请重新加载本区后再编辑"
          : ` 保存失败：${err.message}`; // 400 校验错误原样展示
    }
  };

  // 变量模板：world / character / types 三根的声明树结构编辑（无实例列、无值编辑）
  host.appendChild(el("h4", null, "变量模板"));
  const declModel = createVarDeclModel({ template: JSON.parse(JSON.stringify(varsTemplate)) });
  host.appendChild(createVarDeclEditor({ el, model: declModel }).root);
  const tplSave = el("button", "act", "保存变量模板");
  const tplStatus = el("span", "muted");
  tplSave.onclick = () => saveStruct("vars-template", declModel.getTemplate(), tplStatus);
  host.append(el("div"), tplSave, tplStatus);

  // TAG 附加：按打开时加载的模板对拍（与服务端保存校验同一基准）；改过模板先保存再切包重载
  host.appendChild(el("h4", null, "TAG 附加"));
  host.appendChild(el("div", "muted", "节点上挂附加 TAG（按打开时加载的变量模板对拍；改过模板请先保存并切换包重载）。"));
  const tagsModel = createVarsTagsModel({
    template: JSON.parse(JSON.stringify(varsTemplate)),
    varsTags: JSON.parse(JSON.stringify(varsTags)),
  });
  host.appendChild(createVarsTagsEditor({ el, model: tagsModel, tagNames }).root);
  const tagsSave = el("button", "act", "保存 TAG 附加");
  const tagsStatus = el("span", "muted");
  tagsSave.onclick = () => saveStruct("vars-tags", tagsModel.getPayload(), tagsStatus);
  host.append(el("div"), tagsSave, tagsStatus);
}
