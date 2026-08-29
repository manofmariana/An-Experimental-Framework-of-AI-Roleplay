/**
 * 提示词页：对象×功能矩阵两级页签（一级 = 对象：角色/GM/正文；二级 = 该对象的功能组：
 * 角色·决策 / GM·裁决·突发 / 正文·渲染）+ 模块列表编辑（新增/删除/上下排序/key/role 下拉/
 * content 多行）+ 右侧可用占位符目录。矩阵结构由服务端 GET /api/prompts 应答的 matrix
 * 字段供给（只读，无增删对象/功能的 UI）；编辑的只是模板内容，保存 = PUT 整体替换
 * modules（/api/prompts/{object}.{function}）；未知占位符由 API 400 返回并展示。
 * 顶层另有「占位符」页签 = 占位符目录编辑器（委托 views/placeholder-editor.js：nameplate
 * 陈列 ↔ 编辑子页面 + 引用 chip 级联寻路），本页负责取数——目录 GET 应答 entries/sources +
 * 分支记号 datalist 候选与引用寻路基准 varsTemplate（档内 = GET /api/session/state/sys，
 * 无会话 = 包基线 GET /api/world/tags 与 /api/world/vars-template；拉不到则降级：无候选 /
 * characters·world 两根仅系统声明分支可展开，不阻塞编辑）；保存 = 整份 PUT 经编辑器注入
 * 回调，机检 400 原文回显；成功后刷新共享目录与侧栏。
 */
import { api, el } from "../app.js";
import { createPlaceholderEditor } from "../views/placeholder-editor.js";

const OBJECT_LABELS = { character: "角色", gm: "GM", prose: "正文" };
const FUNCTION_LABELS = { decision: "决策", adjudication: "裁决", incident: "突发", render: "渲染" };
const PLACEHOLDERS_TAB = "__placeholders__";
const ROLES = ["system", "user", "assistant"];

export async function renderPrompts(root) {
  root.id = "prompts";
  root.appendChild(el("h2", null, "提示词模板"));
  root.appendChild(
    el("div", "muted", "有活跃会话时读写档内副本，保存后下一轮对话生效；无会话时读写世界包基线，新会话生效。动态内容（事件/场景/正文窗）建议放尾部模块——缓存友好是编辑约定。"),
  );

  const [promptsData, phData] = await Promise.all([
    api("/api/prompts"),
    api("/api/prompts/placeholders"),
  ]);
  const templates = promptsData.templates;
  // 矩阵结构（对象 → 功能名列表）：服务端单一出处，本页只读
  const matrix = promptsData.matrix;
  // 分支记号 datalist 候选 + 引用寻路基准 varsTemplate（档内 = sys 根；无会话 = 包基线；
  // 拉不到 = 无候选 / characters·world 两根仅系统声明分支可展开，不阻塞编辑）
  let tagNames = [];
  let varsTemplate = null;
  try {
    const sysData = await api("/api/session/state/sys");
    tagNames = Object.keys(sysData.tagRegistry ?? {});
    varsTemplate = sysData.varsTemplate ?? null;
  } catch (err) {
    if (err.code === "NO_ACTIVE_SESSION") {
      try {
        const [tags, template] = await Promise.all([api("/api/world/tags"), api("/api/world/vars-template")]);
        tagNames = Object.keys(tags ?? {});
        varsTemplate = template ?? null;
      } catch {
        tagNames = [];
        varsTemplate = null;
      }
    }
  }

  const tabs = el("div", "prompt-tabs");
  const subTabs = el("div", "prompt-tabs");
  const layout = el("div", "prompt-editor");
  const listEl = el("div", "module-list");
  const side = el("div", "placeholder-side");
  layout.append(listEl, side);
  root.append(tabs, subTabs, layout);

  let currentObject = "character";
  let currentFunction = null;
  /** 侧栏与占位符编辑器共享的目录数据（entries = [{key, description, source, segments}]） */
  let phEntries = phData.entries;
  const phSources = phData.sources;

  const renderSide = () => {
    side.textContent = "";
    side.appendChild(el("h3", null, "可用占位符"));
    // 声明式目录（全对象共享、读者无关）：条目名 + 内容源 + 说明
    for (const p of phEntries) {
      const row = el("div", "placeholder-row");
      row.appendChild(el("code", null, `{{${p.key}}}`));
      row.appendChild(el("span", "muted", `[${p.source ?? "落盘四根"}] ${p.description}`));
      side.appendChild(row);
    }
  };

  /** DOM → modules 数据（排序/删除/保存前先同步一次） */
  const readRows = () => {
    const modules = [];
    for (const row of listEl.querySelectorAll(".module-row")) {
      modules.push({
        key: row.querySelector(".mod-key").value.trim(),
        role: row.querySelector(".mod-role").value,
        content: row.querySelector(".mod-content").value,
      });
    }
    return modules;
  };

  const renderList = (modules) => {
    listEl.textContent = "";
    modules.forEach((mod, i) => {
      const row = el("div", "module-row");

      const head = el("div", "module-head");
      const keyIn = document.createElement("input");
      keyIn.className = "mod-key";
      keyIn.type = "text";
      keyIn.value = mod.key;
      keyIn.placeholder = "模块 key";
      const roleSel = document.createElement("select");
      roleSel.className = "mod-role";
      for (const r of ROLES) {
        const opt = el("option", null, r);
        opt.value = r;
        if (r === mod.role) opt.selected = true;
        roleSel.appendChild(opt);
      }
      const up = el("button", "act", "↑");
      up.disabled = i === 0;
      up.title = "上移";
      up.onclick = () => {
        const m = readRows();
        [m[i - 1], m[i]] = [m[i], m[i - 1]];
        renderList(m);
      };
      const down = el("button", "act", "↓");
      down.disabled = i === modules.length - 1;
      down.title = "下移";
      down.onclick = () => {
        const m = readRows();
        [m[i], m[i + 1]] = [m[i + 1], m[i]];
        renderList(m);
      };
      const del = el("button", "act danger", "删");
      del.onclick = () => {
        const m = readRows();
        m.splice(i, 1);
        renderList(m);
      };
      head.append(keyIn, roleSel, up, down, del);

      const ta = el("textarea", "mod-content");
      ta.rows = 8;
      ta.value = mod.content;

      row.append(head, ta);
      listEl.appendChild(row);
    });

    const addBtn = el("button", "act", "新增模块");
    addBtn.onclick = () => {
      const m = readRows();
      m.push({ key: "new_module", role: "system", content: "" });
      renderList(m);
    };
    const saveBtn = el("button", "act", "保存模板");
    const status = el("span", "muted");
    saveBtn.onclick = async () => {
      status.textContent = "";
      status.className = "muted";
      const templateId = `${currentObject}.${currentFunction}`;
      try {
        const resp = await api(`/api/prompts/${templateId}`, "PUT", {
          id: templateId,
          modules: readRows(),
        });
        status.textContent = ` ${resp.note}`;
      } catch (err) {
        status.className = "line-error";
        status.textContent = ` 保存失败：${err.message}`;
      }
    };
    listEl.append(el("div", "module-actions"), addBtn, saveBtn, status);
  };

  // -------------------------------------------------------------------------
  // 占位符目录编辑器（nameplate 陈列 ↔ 编辑子页面 + 引用 chip；DOM 委托 views/placeholder-editor.js）
  // -------------------------------------------------------------------------

  const renderPlaceholders = () => {
    listEl.textContent = "";
    createPlaceholderEditor({
      el,
      entries: structuredClone(phEntries),
      sources: phSources,
      tagNames,
      varsTemplate,
      save: async (catalog) => {
        const resp = await api("/api/prompts/placeholders", "PUT", catalog);
        // 刷新共享目录数据与侧栏（服务端已规范化分支记号集）
        phEntries = (await api("/api/prompts/placeholders")).entries;
        renderSide();
        return { note: resp.note, entries: structuredClone(phEntries) };
      },
    }).mount(listEl);
  };

  const renderSubTabs = () => {
    subTabs.textContent = "";
    if (currentObject === PLACEHOLDERS_TAB) return;
    for (const fn of matrix[currentObject] ?? []) {
      const b = el("button", null, FUNCTION_LABELS[fn] ?? fn);
      b.classList.toggle("active", fn === currentFunction);
      b.onclick = () => switchFunction(fn);
      subTabs.appendChild(b);
    }
  };

  const switchFunction = (fn) => {
    currentFunction = fn;
    renderSubTabs();
    const t = templates.find((tpl) => tpl.id === `${currentObject}.${fn}`);
    renderList(structuredClone(t.modules));
    renderSide();
  };

  const switchObject = (object) => {
    currentObject = object;
    for (const b of tabs.querySelectorAll("button")) {
      b.classList.toggle("active", b.dataset.object === object);
    }
    if (object === PLACEHOLDERS_TAB) {
      currentFunction = null;
      renderSubTabs();
      renderPlaceholders();
      renderSide();
      return;
    }
    // 切对象默认选该对象第一个功能组
    switchFunction((matrix[object] ?? [])[0]);
  };

  for (const object of Object.keys(matrix)) {
    const b = el("button", null, OBJECT_LABELS[object] ?? object);
    b.dataset.object = object;
    b.onclick = () => switchObject(object);
    tabs.appendChild(b);
  }
  const phTab = el("button", null, "占位符");
  phTab.dataset.object = PLACEHOLDERS_TAB;
  phTab.onclick = () => switchObject(PLACEHOLDERS_TAB);
  tabs.appendChild(phTab);
  switchObject(Object.keys(matrix)[0] ?? PLACEHOLDERS_TAB);
}
