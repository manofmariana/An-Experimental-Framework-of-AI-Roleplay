/**
 * 提示词页：四份模板（character/gm/prose/gm-incident）切换 + 模块列表编辑
 * （新增/删除/上下排序/key/role 下拉/content 多行）+ 右侧可用占位符目录。
 * 保存 = PUT 整体替换 modules；未知占位符由 API 400 返回并展示。
 * 第五个页签「占位符」= 占位符目录结构化编辑器（条目增删/key/description/source 下拉 +
 * 段列编辑：静态段文本、条目段 pass/fail 模板 + 分支动态行 + order/separator/merge），
 * 保存 = PUT /api/prompts/placeholders 整份提交；机检 400 原文回显在编辑器旁。
 * 分支记号输入的 datalist 候选 = 当前模式 TAG 注册表名集（档内 = GET /api/session/state/sys，
 * 无会话 = 包基线 GET /api/world/tags；拉不到则无候选，纯文本输入）。
 */
import { api, el } from "../app.js";

const AGENT_LABELS = { character: "角色", gm: "GM", prose: "正文", "gm-incident": "突发GM" };
const PROMPT_IDS = ["character", "gm", "prose", "gm-incident"];
const PLACEHOLDERS_TAB = "__placeholders__";
const ROLES = ["system", "user", "assistant"];
const ORDER_OPTIONS = [
  ["pre", "前置（默认）"],
  ["post", "置后"],
];

export async function renderPrompts(root) {
  root.id = "prompts";
  root.appendChild(el("h2", null, "提示词模板"));
  root.appendChild(
    el("div", "muted", "有活跃会话时读写档内副本，保存后下一轮对话生效；无会话时读写世界包基线，新会话生效。动态内容（事件/场景/正文窗）建议放尾部模块——缓存友好是编辑约定。"),
  );

  const [templates, phData] = await Promise.all([
    api("/api/prompts"),
    api("/api/prompts/placeholders"),
  ]);
  // 分支记号 datalist 候选 = 当前模式注册表名集（拉不到 = 无候选，不阻塞编辑）
  let tagNames = [];
  try {
    const sysData = await api("/api/session/state/sys");
    tagNames = Object.keys(sysData.tagRegistry ?? {});
  } catch (err) {
    if (err.code === "NO_ACTIVE_SESSION") {
      try {
        tagNames = Object.keys((await api("/api/world/tags")) ?? {});
      } catch {
        tagNames = [];
      }
    }
  }

  const tabs = el("div", "prompt-tabs");
  const layout = el("div", "prompt-editor");
  const listEl = el("div", "module-list");
  const side = el("div", "placeholder-side");
  layout.append(listEl, side);
  root.append(tabs, layout);

  let currentAgent = "character";
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
      row.appendChild(el("span", "muted", `[${p.source}] ${p.description}`));
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
      try {
        const resp = await api(`/api/prompts/${currentAgent}`, "PUT", {
          id: currentAgent,
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
  // 占位符目录结构化编辑器（增删直接操作 DOM，不重渲——未保存输入不丢失；保存时整份读出）
  // -------------------------------------------------------------------------

  /** 分支行动态行：记号集输入（datalist 候选）+ 模板文本域 + 删除钮。 */
  const branchRow = (branch) => {
    const row = el("div", "ph-branch");
    const tokens = document.createElement("input");
    tokens.className = "br-tokens";
    tokens.type = "text";
    tokens.placeholder = "匹配记号集（空格/逗号分隔；留空 = 空集）";
    tokens.value = (branch?.tokens ?? []).join(" ");
    if (tagNames.length > 0) tokens.setAttribute("list", "ph-tag-candidates");
    const ta = el("textarea", "br-template");
    ta.rows = 2;
    ta.value = branch?.template ?? "";
    const del = el("button", "act danger", "×");
    del.title = "删除分支";
    del.onclick = () => row.remove();
    row.append(tokens, ta, del);
    return row;
  };

  /** 条目段一侧（pass/fail）：模板文本域 + 分支行动态区。 */
  const sideBlock = (label, side, taClass, rowsClass) => {
    const block = el("div", "ph-side");
    block.appendChild(el("div", "muted", label));
    const ta = el("textarea", taClass);
    ta.rows = 3;
    ta.value = side?.template ?? "";
    const rows = el("div", rowsClass);
    for (const branch of side?.branches ?? []) rows.appendChild(branchRow(branch));
    const add = el("button", "act", "+ 分支");
    add.onclick = () => rows.appendChild(branchRow(null));
    block.append(ta, rows, add);
    return block;
  };

  /** 段编辑块（静态段 = 文本域；条目段 = pass/fail 两侧 + order/separator/merge）。 */
  const segmentBlock = (seg) => {
    const isStatic = seg.kind === "static";
    const block = el("div", isStatic ? "ph-seg ph-seg-static" : "ph-seg ph-seg-entry");
    const head = el("div", "module-head");
    head.appendChild(el("span", "muted", isStatic ? "静态段" : "条目段"));
    const del = el("button", "act danger", "删段");
    del.onclick = () => block.remove();
    head.appendChild(del);
    block.appendChild(head);
    if (isStatic) {
      const ta = el("textarea", "seg-text");
      ta.rows = 3;
      ta.value = seg.text ?? "";
      block.appendChild(ta);
      return block;
    }
    block.appendChild(sideBlock("放行模板（pass）", seg.pass, "seg-pass", "br-rows-pass"));
    block.appendChild(sideBlock("不放行模板（fail，缺省 = 空）", seg.fail, "seg-fail", "br-rows-fail"));
    const orderSel = document.createElement("select");
    orderSel.className = "seg-order";
    for (const [value, label] of ORDER_OPTIONS) {
      const opt = el("option", null, label);
      opt.value = value;
      if ((seg.order ?? "pre") === value) opt.selected = true;
      orderSel.appendChild(opt);
    }
    const sep = document.createElement("input");
    sep.className = "seg-sep";
    sep.type = "text";
    sep.placeholder = "separator（缺省 \\n）";
    sep.value = seg.separator ?? "";
    const merge = document.createElement("input");
    merge.className = "seg-merge";
    merge.type = "text";
    merge.placeholder = "merge（缺省 = separator）";
    merge.value = seg.merge ?? "";
    const tail = el("div", "module-head");
    tail.append(el("span", "muted", "遍历序"), orderSel, sep, merge);
    block.appendChild(tail);
    return block;
  };

  /** 条目编辑块：key + source 下拉 + 删除钮 + description 文本域 + 段列。 */
  const entryBlock = (entry) => {
    const block = el("div", "ph-entry module-row");
    const head = el("div", "module-head");
    const keyIn = document.createElement("input");
    keyIn.className = "ph-key";
    keyIn.type = "text";
    keyIn.placeholder = "占位符名（\\w+）";
    keyIn.value = entry.key;
    const sourceSel = document.createElement("select");
    sourceSel.className = "ph-source";
    for (const s of phSources) {
      const opt = el("option", null, s);
      opt.value = s;
      if (s === entry.source) opt.selected = true;
      sourceSel.appendChild(opt);
    }
    const del = el("button", "act danger", "删条目");
    del.onclick = () => block.remove();
    head.append(keyIn, sourceSel, del);
    const desc = el("textarea", "ph-desc");
    desc.rows = 2;
    desc.placeholder = "description（条目说明）";
    desc.value = entry.description ?? "";
    const segs = el("div", "ph-segs");
    for (const seg of entry.segments ?? []) segs.appendChild(segmentBlock(seg));
    const addStatic = el("button", "act", "+ 静态段");
    addStatic.onclick = () => segs.appendChild(segmentBlock({ kind: "static", text: "" }));
    const addEntry = el("button", "act", "+ 条目段");
    addEntry.onclick = () => segs.appendChild(segmentBlock({ kind: "entry", pass: { template: "" } }));
    block.append(head, desc, segs, addStatic, addEntry);
    return block;
  };

  /** 读一侧（pass/fail）DOM → 数据；fail 全空 = undefined（缺省空模板）。 */
  const readSide = (segEl, taClass, rowsClass) => {
    const template = segEl.querySelector(`.${taClass}`).value;
    const branches = [];
    for (const row of segEl.querySelectorAll(`.${rowsClass} .ph-branch`)) {
      const tokens = row.querySelector(".br-tokens").value.split(/[\s,，、]+/).filter(Boolean);
      const branchTemplate = row.querySelector(".br-template").value;
      if (tokens.length === 0 && branchTemplate === "") continue; // 全空行 = 未使用
      branches.push({ tokens, template: branchTemplate });
    }
    return { template, branches };
  };

  /** DOM → 目录数据（保存时整份读出）。 */
  const readCatalog = () => {
    const catalog = {};
    for (const entryEl of listEl.querySelectorAll(".ph-entry")) {
      const key = entryEl.querySelector(".ph-key").value.trim();
      if (key === "") throw new Error("存在空占位符名");
      if (key in catalog) throw new Error(`占位符名重复: ${key}`);
      const segments = [];
      for (const segEl of entryEl.querySelectorAll(".ph-segs > .ph-seg")) {
        if (segEl.classList.contains("ph-seg-static")) {
          segments.push({ kind: "static", text: segEl.querySelector(".seg-text").value });
          continue;
        }
        const pass = readSide(segEl, "seg-pass", "br-rows-pass");
        const fail = readSide(segEl, "seg-fail", "br-rows-fail");
        const seg = { kind: "entry", pass: { template: pass.template } };
        if (pass.branches.length > 0) seg.pass.branches = pass.branches;
        if (fail.template !== "" || fail.branches.length > 0) {
          seg.fail = { template: fail.template };
          if (fail.branches.length > 0) seg.fail.branches = fail.branches;
        }
        if (segEl.querySelector(".seg-order").value === "post") seg.order = "post";
        const separator = segEl.querySelector(".seg-sep").value;
        if (separator !== "") seg.separator = separator;
        const merge = segEl.querySelector(".seg-merge").value;
        if (merge !== "") seg.merge = merge;
        segments.push(seg);
      }
      if (segments.length === 0) throw new Error(`占位符 "${key}" 至少需要一个段`);
      catalog[key] = {
        description: entryEl.querySelector(".ph-desc").value,
        source: entryEl.querySelector(".ph-source").value,
        segments,
      };
    }
    return catalog;
  };

  const renderPlaceholders = (entries) => {
    listEl.textContent = "";
    if (tagNames.length > 0) {
      const datalist = document.createElement("datalist");
      datalist.id = "ph-tag-candidates";
      for (const name of tagNames) {
        const opt = document.createElement("option");
        opt.value = name;
        datalist.appendChild(opt);
      }
      listEl.appendChild(datalist);
    }
    for (const entry of entries) listEl.appendChild(entryBlock(entry));

    const addBtn = el("button", "act", "新增条目");
    const saveBtn = el("button", "act", "保存占位符目录");
    const status = el("span", "muted");
    const actions = el("div", "module-actions ph-actions");
    addBtn.onclick = () => {
      listEl.insertBefore(
        entryBlock({ key: "new_placeholder", description: "", source: phSources[0], segments: [{ kind: "static", text: "" }] }),
        actions,
      );
    };
    saveBtn.onclick = async () => {
      status.textContent = "";
      status.className = "muted";
      let catalog;
      try {
        catalog = readCatalog();
      } catch (err) {
        status.className = "line-error";
        status.textContent = ` ${err.message}`;
        return;
      }
      try {
        const resp = await api("/api/prompts/placeholders", "PUT", catalog);
        status.textContent = ` ${resp.note}`;
        // 刷新共享目录数据与侧栏（服务端已规范化分支记号集）
        phEntries = (await api("/api/prompts/placeholders")).entries;
        renderSide();
      } catch (err) {
        status.className = "line-error";
        status.textContent = ` 保存失败：${err.message}`;
      }
    };
    actions.append(addBtn, saveBtn, status);
    listEl.appendChild(actions);
  };

  const switchAgent = (agent) => {
    currentAgent = agent;
    for (const b of tabs.querySelectorAll("button")) {
      b.classList.toggle("active", b.dataset.agent === agent);
    }
    if (agent === PLACEHOLDERS_TAB) {
      renderPlaceholders(structuredClone(phEntries));
      renderSide();
      return;
    }
    const t = templates.find((tpl) => tpl.id === agent);
    renderList(structuredClone(t.modules));
    renderSide();
  };

  for (const agent of PROMPT_IDS) {
    const b = el("button", null, AGENT_LABELS[agent] ?? agent);
    b.dataset.agent = agent;
    b.onclick = () => switchAgent(agent);
    tabs.appendChild(b);
  }
  const phTab = el("button", null, "占位符");
  phTab.dataset.agent = PLACEHOLDERS_TAB;
  phTab.onclick = () => switchAgent(PLACEHOLDERS_TAB);
  tabs.appendChild(phTab);
  switchAgent("character");
}
