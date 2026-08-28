/**
 * 提示词页「占位符」页签 DOM 层（el 注入，import 期零副作用）。
 *
 * 两态页内切换：
 * - 列表态 = nameplate 陈列（每占位符一牌：名 + description 摘要）+ 末尾加号牌
 *   （新增占位符并直接进入子页面）；
 * - 编辑子页面 = 占位符名 / description / 段列（静态文本 = 文本域；条目 = pass/fail
 *   模板 + 分支动态行（记号集 datalist 候选）+ 「关闭身份过滤」勾选 +
 *   order/separator/merge）+ 删除占位符；「← 返回列表」先落回工作副本再回列表。
 *   source 不设手选控件：保存时由全部路径调用推导（deriveEntrySource——组装类路径
 *   全同一 source 且不混落盘根，违反 = 本地报错不提交；服务端机检同口径）。
 *
 * 模板文本域 = contenteditable + 引用 chip：「引用」钮 → 级联 dropdown（贴钮弹出、逐列
 * 展开、数组列带 [*]/下标/cid 手输行；列外点击 / Esc 关闭）→ 末端选定在光标处插入原子
 * chip（contenteditable=false，文本 = `{路径}` 原文——复制/剪切/粘贴天然携带路径文本，
 * 整体删除、内部不可编辑）。菜单顶层两大类：路径（落盘四根逐级树）/ 程序（组装源 →
 * content/owner 两末端）。加载经 splitPathCalls 把路径调用解析为 chip，保存序列化回
 * `{路径}` 文本——存储/校验格式零改动。Enter/粘贴/拖放拦截保持 DOM 扁平（文本节点 +
 * chip），粘贴文本中的路径调用形态自动还原为 chip。
 *
 * 保存 = 整份工作副本 → catalog（空名/重名/零段前端预检）经注入 save 回调（PUT 由调用方
 * 负责），机检 400 原文回显；成功后以服务端规范化目录替换工作副本。
 */
import { buildRefMenu, deriveEntrySource, expandArray, splitPathCalls } from "./placeholder-path-model.js";

const ORDER_OPTIONS = [
  ["pre", "前置（默认）"],
  ["post", "置后"],
];

export function createPlaceholderEditor({ el, entries, sources, tagNames, varsTemplate, save }) {
  /** 工作副本（nameplate 列表与编辑子页面共用；保存成功后被规范化目录整份替换）。 */
  let workEntries = entries;
  /** 当前编辑下标（-1 = 列表态）。 */
  let editIndex = -1;
  /** 段读出器（编辑子页面打开期间有效；删段/删分支从各自闭包剔除）。 */
  let segReaders = [];
  /** 编辑子页面字段引用（flushEditor 用）。 */
  let editRefs = null;

  const root = el("div", "ph-editor");
  const toolbar = el("div", "module-actions ph-toolbar");
  const saveBtn = el("button", "act", "保存占位符目录");
  const status = el("span", "muted");
  toolbar.append(saveBtn, status);
  const view = el("div", "ph-view");
  root.append(toolbar, view);
  if (tagNames.length > 0) {
    const datalist = document.createElement("datalist");
    datalist.id = "ph-tag-candidates";
    for (const name of tagNames) {
      const opt = document.createElement("option");
      opt.value = name;
      datalist.appendChild(opt);
    }
    root.appendChild(datalist);
  }

  // -------------------------------------------------------------------------
  // 引用 chip（模板文本域 = contenteditable；DOM 恒扁平：文本节点 + chip span）
  // -------------------------------------------------------------------------

  const makeChip = (path) => {
    const chip = el("span", "ph-chip", `{${path}}`);
    chip.contentEditable = "false";
    chip.dataset.phPath = path;
    return chip;
  };

  const fillTpl = (tpl, text) => {
    tpl.textContent = "";
    for (const token of splitPathCalls(text)) {
      tpl.appendChild(token.type === "path" ? makeChip(token.value) : document.createTextNode(token.value));
    }
  };

  /** DOM → 模板文本（chip → `{路径}`；防御性处理 BR/嵌套块为换行）。 */
  const serializeTpl = (node) => {
    let out = "";
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        out += child.data;
      } else if (child.nodeType === 1) {
        if (child.dataset && child.dataset.phPath !== undefined) out += `{${child.dataset.phPath}}`;
        else if (child.tagName === "BR") out += "\n";
        else out += serializeTpl(child);
      }
    }
    return out;
  };

  const placeCaretAfter = (node) => {
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  };

  /** 在光标处插入 token 序列（粘贴/Enter 共用；路径 token 成 chip）。 */
  const insertTokens = (tpl, text) => {
    const tokens = splitPathCalls(text);
    if (tokens.length === 0) return;
    const sel = window.getSelection();
    let range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    if (range === null || !tpl.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(tpl);
      range.collapse(false);
    }
    range.deleteContents();
    for (const token of tokens) {
      const node = token.type === "path" ? makeChip(token.value) : document.createTextNode(token.value);
      range.insertNode(node);
      range.setStartAfter(node);
    }
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  };

  /** 在记忆的光标处插入引用 chip（chip 后保证有文本节点收容光标）。 */
  const insertPathAt = (tpl, savedRange, path) => {
    const chip = makeChip(path);
    tpl.focus();
    if (savedRange !== null && tpl.contains(savedRange.commonAncestorContainer)) {
      savedRange.deleteContents();
      savedRange.insertNode(chip);
    } else {
      tpl.appendChild(chip);
    }
    if (chip.nextSibling === null) tpl.appendChild(document.createTextNode(""));
    placeCaretAfter(chip);
  };

  /** 模板字段：「引用」钮 + contenteditable 文本域；get() 出序列化模板文本。 */
  const tplField = (value) => {
    const wrap = el("div", "ph-tpl-wrap");
    const bar = el("div", "ph-tpl-bar");
    const refBtn = el("button", "act ph-ref", "引用");
    refBtn.type = "button";
    const tpl = el("div", "ph-tpl");
    tpl.contentEditable = "true";
    tpl.spellcheck = false;
    fillTpl(tpl, value);

    let savedRange = null;
    const capture = () => {
      const sel = window.getSelection();
      if (sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        if (tpl.contains(range.commonAncestorContainer)) savedRange = range.cloneRange();
      }
    };
    tpl.addEventListener("keyup", capture);
    tpl.addEventListener("mouseup", capture);
    tpl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        insertTokens(tpl, "\n");
      }
    });
    tpl.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text !== "") insertTokens(tpl, text);
    });
    tpl.addEventListener("drop", (e) => {
      e.preventDefault();
      const text = e.dataTransfer?.getData("text/plain") ?? "";
      if (text !== "") insertTokens(tpl, text);
    });
    // mousedown 抢先 preventDefault：保住文本域内的光标选区供 chip 落点
    refBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      capture();
    });
    refBtn.addEventListener("click", () => {
      openRefMenu(refBtn, (path) => insertPathAt(tpl, savedRange, path));
    });
    bar.appendChild(refBtn);
    wrap.append(bar, tpl);
    return { element: wrap, get: () => serializeTpl(tpl) };
  };

  // -------------------------------------------------------------------------
  // 级联 dropdown（单例；贴「引用」钮弹出，逐列展开，列外点击 / Esc 关闭）
  // -------------------------------------------------------------------------

  let closeCurrent = null;
  const closeRefMenu = () => {
    if (closeCurrent !== null) {
      closeCurrent();
      closeCurrent = null;
    }
  };

  const openRefMenu = (anchor, onPick) => {
    closeRefMenu();
    const menu = el("div", "ph-menu");
    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${Math.max(0, Math.min(rect.left, window.innerWidth - 760))}px`;

    const trimTo = (depth) => {
      while (menu.children.length > depth) menu.lastElementChild.remove();
    };
    const markActive = (btn) => {
      for (const b of btn.parentElement.querySelectorAll(".ph-menu-item.active")) b.classList.remove("active");
      btn.classList.add("active");
    };
    const itemButton = (item, depth) => {
      if (item.kind === "endpoint") {
        const b = el("button", "ph-menu-item ph-menu-leaf", item.label);
        b.type = "button";
        b.title = `{${item.path}}`;
        b.onclick = () => {
          onPick(item.path);
          closeRefMenu();
        };
        return b;
      }
      const b = el("button", "ph-menu-item", `${item.label} ▸`);
      b.type = "button";
      b.onclick = () => {
        markActive(b);
        if (item.kind === "branch") renderColumn(item.children, depth + 1);
        else renderArrayColumn(item, depth + 1, "*");
      };
      return b;
    };
    const renderColumn = (items, depth) => {
      trimTo(depth);
      const col = el("div", "ph-menu-col");
      if (items.length === 0) col.appendChild(el("div", "ph-menu-hint", "（无子级）"));
      for (const item of items) col.appendChild(itemButton(item, depth));
      menu.appendChild(col);
    };
    const renderArrayColumn = (node, depth, seg) => {
      trimTo(depth);
      const col = el("div", "ph-menu-col");
      const form = el("div", "ph-menu-axis");
      const input = document.createElement("input");
      input.type = "text";
      input.value = seg;
      input.placeholder = node.axis === "cid" ? "* 或 cid（如 C1001）" : "* 或下标（如 0）";
      const ok = el("button", "act", "确定");
      ok.type = "button";
      const apply = () => {
        const v = input.value.trim();
        const valid = v === "*" || (node.axis === "cid" ? /^C\d+$/.test(v) : /^\d+$/.test(v));
        if (!valid) {
          input.classList.add("ph-axis-bad");
          return;
        }
        renderArrayColumn(node, depth, v);
      };
      ok.onclick = apply;
      input.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          apply();
        }
      };
      form.append(input, ok);
      col.appendChild(form);
      const children = expandArray(node, seg);
      if (children.length === 0) col.appendChild(el("div", "ph-menu-hint", "（无子级）"));
      for (const child of children) col.appendChild(itemButton(child, depth));
      menu.appendChild(col);
    };

    renderColumn(buildRefMenu(varsTemplate, sources), 0);

    const onDocDown = (e) => {
      if (!menu.contains(e.target)) closeRefMenu();
    };
    const onKey = (e) => {
      if (e.key === "Escape") closeRefMenu();
    };
    document.addEventListener("mousedown", onDocDown, true);
    document.addEventListener("keydown", onKey, true);
    closeCurrent = () => {
      document.removeEventListener("mousedown", onDocDown, true);
      document.removeEventListener("keydown", onKey, true);
      menu.remove();
    };
  };

  // -------------------------------------------------------------------------
  // 编辑子页面（段/分支/条目读出器闭包登记；删块即摘读出器）
  // -------------------------------------------------------------------------

  /** 分支行动态行：记号集输入（datalist 候选）+ 模板字段 + 删除钮。 */
  const branchRow = (branch, register) => {
    const row = el("div", "ph-branch");
    const tokens = document.createElement("input");
    tokens.className = "br-tokens";
    tokens.type = "text";
    tokens.placeholder = "匹配记号集（空格/逗号分隔；留空 = 空集）";
    tokens.value = (branch?.tokens ?? []).join(" ");
    if (tagNames.length > 0) tokens.setAttribute("list", "ph-tag-candidates");
    const btpl = tplField(branch?.template ?? "");
    const del = el("button", "act danger", "×");
    del.title = "删除分支";
    del.type = "button";
    const reader = {
      read: () => ({
        tokens: tokens.value.split(/[\s,，、]+/).filter(Boolean),
        template: btpl.get(),
      }),
    };
    del.onclick = () => {
      register(null, reader);
      row.remove();
    };
    register(reader, null);
    row.append(tokens, btpl.element, del);
    return row;
  };

  /** 条目一侧（pass/fail）：模板字段 + 分支行动态区。 */
  const sideBlock = (label, side) => {
    const wrap = el("div", "ph-side");
    wrap.appendChild(el("div", "muted", label));
    const tpl = tplField(side?.template ?? "");
    wrap.appendChild(tpl.element);
    const rows = el("div", "ph-branches");
    let branchReaders = [];
    const register = (reader, remove) => {
      if (remove !== null) branchReaders = branchReaders.filter((r) => r !== remove);
      if (reader !== null) branchReaders.push(reader);
    };
    for (const branch of side?.branches ?? []) rows.appendChild(branchRow(branch, register));
    const add = el("button", "act", "+ 分支");
    add.type = "button";
    add.onclick = () => rows.appendChild(branchRow(null, register));
    wrap.append(rows, add);
    return {
      element: wrap,
      read: () => ({
        template: tpl.get(),
        // 全空行（无记号且无模板）= 未使用
        branches: branchReaders
          .map((r) => r.read())
          .filter((b) => b.tokens.length > 0 || b.template !== ""),
      }),
    };
  };

  /** 段编辑块（静态文本 = 文本域；条目 = pass/fail 两侧 + order/separator/merge）。 */
  const segmentBlock = (seg) => {
    const isStatic = seg.kind === "static";
    const block = el("div", isStatic ? "ph-seg ph-seg-static" : "ph-seg ph-seg-entry");
    const head = el("div", "module-head");
    head.appendChild(el("span", "muted", isStatic ? "静态文本" : "条目"));
    const del = el("button", "act danger", "删除");
    del.type = "button";
    head.appendChild(del);
    block.appendChild(head);

    if (isStatic) {
      const ta = el("textarea", "seg-text");
      ta.rows = 3;
      ta.value = seg.text ?? "";
      block.appendChild(ta);
      const reader = { read: () => ({ kind: "static", text: ta.value }) };
      del.onclick = () => {
        segReaders = segReaders.filter((r) => r !== reader);
        block.remove();
      };
      segReaders.push(reader);
      return block;
    }

    const passSide = sideBlock("放行模板（pass）", seg.pass);
    const failSide = sideBlock("不放行模板（fail，缺省 = 空）", seg.fail);
    block.append(passSide.element, failSide.element);
    const identityWrap = el("label", "ph-identity");
    const identityBox = document.createElement("input");
    identityBox.type = "checkbox";
    identityBox.checked = seg.identity === false;
    identityWrap.append(identityBox, document.createTextNode("关闭身份过滤（直接输出 @CID/cid 原文）"));
    block.appendChild(identityWrap);
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

    const reader = {
      read: () => {
        const pass = passSide.read();
        const fail = failSide.read();
        const out = { kind: "entry", pass: { template: pass.template } };
        if (pass.branches.length > 0) out.pass.branches = pass.branches;
        if (fail.template !== "" || fail.branches.length > 0) {
          out.fail = { template: fail.template };
          if (fail.branches.length > 0) out.fail.branches = fail.branches;
        }
        if (orderSel.value === "post") out.order = "post";
        if (identityBox.checked) out.identity = false;
        if (sep.value !== "") out.separator = sep.value;
        if (merge.value !== "") out.merge = merge.value;
        return out;
      },
    };
    del.onclick = () => {
      segReaders = segReaders.filter((r) => r !== reader);
      block.remove();
    };
    segReaders.push(reader);
    return block;
  };

  /** 编辑子页面 DOM → 工作副本当前条目。 */
  const flushEditor = () => {
    if (editIndex < 0 || editRefs === null) return;
    const entry = workEntries[editIndex];
    entry.key = editRefs.keyIn.value.trim();
    entry.description = editRefs.desc.value;
    entry.segments = segReaders.map((r) => r.read());
  };

  const renderEdit = (index) => {
    editIndex = index;
    segReaders = [];
    const entry = workEntries[index];
    view.textContent = "";
    const detail = el("div", "ph-detail");

    const head = el("div", "module-head");
    const back = el("button", "act", "← 返回列表");
    back.type = "button";
    back.onclick = () => {
      flushEditor();
      renderList();
    };
    const keyIn = document.createElement("input");
    keyIn.className = "ph-key";
    keyIn.type = "text";
    keyIn.placeholder = "占位符名（\\w+）";
    keyIn.value = entry.key;
    const del = el("button", "act danger", "删除占位符");
    del.type = "button";
    del.onclick = () => {
      workEntries.splice(index, 1);
      editIndex = -1;
      editRefs = null;
      renderList();
    };
    head.append(back, keyIn, del);

    const desc = el("textarea", "ph-desc");
    desc.rows = 2;
    desc.placeholder = "description（占位符说明）";
    desc.value = entry.description ?? "";

    editRefs = { keyIn, desc };

    const segs = el("div", "ph-segs");
    for (const seg of entry.segments ?? []) segs.appendChild(segmentBlock(seg));
    const addEntry = el("button", "act", "+ 条目");
    addEntry.type = "button";
    addEntry.onclick = () => segs.appendChild(segmentBlock({ kind: "entry", pass: { template: "" } }));
    const addStatic = el("button", "act", "+ 静态文本");
    addStatic.type = "button";
    addStatic.onclick = () => segs.appendChild(segmentBlock({ kind: "static", text: "" }));
    const addRow = el("div", "module-actions");
    addRow.append(addEntry, addStatic);

    detail.append(head, desc, segs, addRow);
    view.appendChild(detail);
  };

  // -------------------------------------------------------------------------
  // 列表态（nameplate 陈列 + 加号牌）
  // -------------------------------------------------------------------------

  const summaryOf = (text) => {
    const first = (text ?? "").split("\n")[0].trim();
    if (first === "") return "（无 description）";
    return first.length > 60 ? `${first.slice(0, 60)}…` : first;
  };

  const uniqueName = () => {
    const taken = new Set(workEntries.map((e) => e.key));
    if (!taken.has("new_placeholder")) return "new_placeholder";
    let i = 2;
    while (taken.has(`new_placeholder_${i}`)) i++;
    return `new_placeholder_${i}`;
  };

  const renderList = () => {
    editIndex = -1;
    editRefs = null;
    segReaders = [];
    closeRefMenu();
    view.textContent = "";
    const grid = el("div", "ph-plates");
    workEntries.forEach((entry, i) => {
      const plate = el("div", "ph-plate");
      plate.tabIndex = 0;
      const head = el("div", "ph-plate-head");
      head.appendChild(el("code", null, `{{${entry.key}}}`));
      plate.append(head, el("div", "ph-plate-desc", summaryOf(entry.description)));
      plate.onclick = () => renderEdit(i);
      plate.onkeydown = (e) => {
        if (e.key === "Enter") renderEdit(i);
      };
      grid.appendChild(plate);
    });
    const add = el("div", "ph-plate ph-plate-add", "＋ 新增占位符");
    add.tabIndex = 0;
    add.onclick = () => {
      workEntries.push({ key: uniqueName(), description: "", segments: [{ kind: "static", text: "" }] });
      renderEdit(workEntries.length - 1);
    };
    add.onkeydown = (e) => {
      if (e.key === "Enter") add.onclick();
    };
    grid.appendChild(add);
    view.appendChild(grid);
  };

  // -------------------------------------------------------------------------
  // 保存（整份工作副本 → catalog；前端预检空名/重名/零段，机检 400 原文回显）
  // -------------------------------------------------------------------------

  const buildCatalog = () => {
    const catalog = {};
    for (const entry of workEntries) {
      const key = entry.key.trim();
      if (key === "") throw new Error("存在空占位符名");
      if (key in catalog) throw new Error(`占位符名重复: ${key}`);
      if (!Array.isArray(entry.segments) || entry.segments.length === 0) {
        throw new Error(`占位符 "${key}" 至少需要一段（条目或静态文本）`);
      }
      // source 由全部路径调用推导（组装类全同一 source 且不混落盘根，否则本地报错不提交）
      let source;
      try {
        source = deriveEntrySource(entry.segments, sources);
      } catch (err) {
        throw new Error(`占位符 "${key}"：${err.message}`);
      }
      catalog[key] = {
        description: entry.description ?? "",
        ...(source !== undefined ? { source } : {}),
        segments: entry.segments,
      };
    }
    return catalog;
  };

  saveBtn.onclick = async () => {
    status.textContent = "";
    status.className = "muted";
    flushEditor();
    let catalog;
    try {
      catalog = buildCatalog();
    } catch (err) {
      status.className = "line-error";
      status.textContent = ` ${err.message}`;
      return;
    }
    try {
      const result = await save(catalog);
      workEntries = result.entries;
      status.textContent = ` ${result.note}`;
      if (editIndex < 0) renderList(); // 列表态重渲反映服务端规范化结果
    } catch (err) {
      status.className = "line-error";
      status.textContent = ` 保存失败：${err.message}`;
    }
  };

  return {
    mount(parent) {
      parent.appendChild(root);
      renderList();
    },
  };
}
