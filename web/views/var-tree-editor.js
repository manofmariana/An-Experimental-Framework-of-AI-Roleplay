/**
 * 树状变量编辑器 DOM 层（直编 modal 变量区，只做实例状态编辑）。
 *
 * 渲染 var-tree-model 的视图模型，把控件事件翻译为模型操作；数据读写全部经 model
 * （本层不碰工作副本）。每次操作后整树重渲；折叠状态按 `${scope}|${path}` 持有，
 * 区块折叠按 `${scope}|${section}` 持有。
 *
 * 形态：作用域切换下拉（「世界」+ 各 CID）+ 单树区 + 错误行（模型操作报错原样落此）。
 * - 世界作用域 =「世界变量」区块；角色作用域 =「角色变量」单区块——系统声明分支
 *   投影与 vars 实例树同一棵树，不再分区；
 * - 树形缩进：子级包 .vte-kids（左侧参考线），容器行首折叠箭头（默认展开）；
 * - 状态操作按钮（实例 +/×、tags）收在行尾 .vte-actions，行 hover 才浮现；
 *   类型容器行尾「+」开行内实例名表单（只动实例不动模板；relations 同通道）；
 * - 外壳 tags = chip 胶囊（名称 + 等级小字 + ×），行尾小型添加（名称 datalist 来自
 *   _sys.tagRegistry 允许自由输入 + level 1-7）；全部末端（含系统字段）可编——
 *   系统末端写侧车、vars 末端写外壳；附加来源 tags（模型 attachTags）以「附加」徽记
 *   只读 chip 并入同一 chips 区（无 ×、不出添加控件），tags 钮计数 `n+m`；
 * - attachtags/tags 池 = string_list 纯名集合：名称 chips（无等级列；池只读从动）；
 * - 系统五字段值只读 +「系统」徽记（tags 仍可编）；从动末端只读值 + formula 只读
 *   标注 +「从动」徽记（formula 结构编辑在世界页变量结构区，此处不开放）；
 * - initiative 为 null 时子字段显示空输入，两值齐全才整体写回对象（不清空回 null）。
 *
 * 可选注入：scrollHost = 整树重渲时保持其 scrollTop（直编 modal 滚动容器不跳顶）；
 * onEdit = 模型操作成功后的回调（外层脏标记，取消确认用）。
 *
 * el/model 注入，import 期零副作用。
 */

import { WORLD_SCOPE } from "./var-tree-model.js";

/**
 * @param {object} deps
 * @param {(tag: string, className?: string|null, text?: string) => any} deps.el DOM 构造器
 * @param {object} deps.model createVarTreeModel 产物
 * @param {any} [deps.scrollHost] 滚动容器（重渲前后保持 scrollTop）
 * @param {() => void} [deps.onEdit] 模型操作成功回调（脏标记）
 * @returns {{root: any}} 挂载 root；保存载荷经 model.getPayload() 取
 */
export function createVarTreeEditor({ el, model, scrollHost, onEdit }) {
  const scopes = model.listScopes();
  let scope = scopes.length > 0 ? scopes[0].id : WORLD_SCOPE;
  const folded = new Set(); // 折叠的容器 `${scope}|${path}`
  const secFolded = new Set(); // 折叠的区块 `${scope}|${section}`
  const tagsOpen = new Set(); // 展开外壳 tags 编辑器的末端 `${scope}|${path}`
  let instForm = null; // {path, name}（类型容器新增实例行内表单）
  const structPending = new Map(); // `${scope}|${path}` → {texts}（null 结构体两值暂存）

  const root = el("div", "vte");
  const errEl = el("div", "vte-error");
  const datalistId = "vte-tag-names";

  /** 模型操作统一出口：报错落错误行，成功后通知外层脏标记，随后整树重渲。 */
  function runOp(fn) {
    errEl.textContent = "";
    try {
      fn();
    } catch (err) {
      errEl.textContent = err.message ?? String(err);
      render();
      return;
    }
    onEdit?.();
    render();
  }

  const foldKey = (path) => `${scope}|${path}`;

  /** 行尾小型图标按钮（hover 浮现）。 */
  function iconBtn(text, title, onclick) {
    const b = el("button", "vte-icon", text);
    b.title = title;
    b.onclick = onclick;
    return b;
  }

  function actionsOf(...btns) {
    const box = el("span", "vte-actions");
    box.append(...btns);
    return box;
  }

  // ---- 控件 -----------------------------------------------------------------

  /** string_list 文本域 ↔ 数组：每行一个，尾部空行丢弃。 */
  const linesToList = (text) => (text.trim() === "" ? [] : text.replace(/\n+$/, "").split("\n"));

  /** 内容侧挂载 chips（外壳 tags）：chip = 名称 + 等级小字 + ×；行尾小型添加。
   *  attachItems = 附加来源只读 chips（「附加」徽记、无 × 不参与编辑），只作显示。 */
  function renderChips(items, apply, readonly, attachItems) {
    const box = el("span", "vte-chips");
    items.forEach((item, i) => {
      const chip = el("span", "vte-chip");
      chip.appendChild(el("span", null, item.name));
      chip.appendChild(el("span", "vte-chip-level", `Lv${item.level}`));
      if (!readonly) {
        const x = el("button", "vte-chip-x", "×");
        x.title = "移除";
        x.onclick = () => runOp(() => apply(items.filter((_, j) => j !== i)));
        chip.appendChild(x);
      }
      box.appendChild(chip);
    });
    for (const item of attachItems ?? []) {
      const chip = el("span", "vte-chip vte-chip-attach");
      chip.title = "附加来源（vars-tags 读取期合并），只读不落实例值";
      chip.appendChild(el("span", null, item.name));
      chip.appendChild(el("span", "vte-chip-level", `Lv${item.level}`));
      chip.appendChild(el("span", "vte-badge", "附加"));
      box.appendChild(chip);
    }
    if (!readonly) {
      const name = el("input");
      name.type = "text";
      name.setAttribute("list", datalistId);
      name.placeholder = "TAG 名";
      const level = el("input");
      level.type = "number";
      level.min = "1";
      level.max = "7";
      level.value = "1";
      level.title = "等级 1-7";
      const add = iconBtn("+", "添加 TAG", () =>
        runOp(() => {
          const nm = name.value.trim();
          if (nm === "") throw new Error("TAG 名不能为空");
          apply([...items, { name: nm, level: Number(level.value) }]);
        }),
      );
      box.append(name, level, add);
    }
    return box;
  }

  /** 对象侧纯名集合 chips（attachtags/tags 池 string_list）：chip = 名称 + ×（无等级列）。 */
  function renderNameChips(items, apply, readonly) {
    const box = el("span", "vte-chips");
    items.forEach((item, i) => {
      const chip = el("span", "vte-chip");
      chip.appendChild(el("span", null, item));
      if (!readonly) {
        const x = el("button", "vte-chip-x", "×");
        x.title = "移除";
        x.onclick = () => runOp(() => apply(items.filter((_, j) => j !== i)));
        chip.appendChild(x);
      }
      box.appendChild(chip);
    });
    if (!readonly) {
      const name = el("input");
      name.type = "text";
      name.setAttribute("list", datalistId);
      name.placeholder = "TAG 名";
      const add = iconBtn("+", "添加 TAG", () =>
        runOp(() => {
          const nm = name.value.trim();
          if (nm === "") throw new Error("TAG 名不能为空");
          apply([...items, nm]);
        }),
      );
      box.append(name, add);
    }
    return box;
  }

  /** 变量末端值控件（非从动）；onchange 整体回写模型。 */
  function renderValueControl(node) {
    const path = node.path;
    switch (node.valueType) {
      case "number": {
        const input = el("input");
        input.type = "number";
        input.value = node.hasInstance ? String(node.value) : "";
        input.onchange = () => runOp(() => model.writeTerminalValue(scope, path, Number(input.value)));
        return input;
      }
      case "string": {
        const input = el("input");
        input.type = "text";
        input.value = node.hasInstance ? String(node.value) : "";
        input.onchange = () => runOp(() => model.writeTerminalValue(scope, path, input.value));
        return input;
      }
      case "boolean": {
        const input = el("input");
        input.type = "checkbox";
        input.checked = node.value === true;
        input.onchange = () => runOp(() => model.writeTerminalValue(scope, path, input.checked));
        return input;
      }
      case "string_list": {
        const items = Array.isArray(node.value) ? node.value : [];
        // attachtags = 对象侧纯名集合：名称 chips（无等级列）
        if (node.key === "attachtags") {
          return renderNameChips(items, (list) => model.writeTerminalValue(scope, path, list), false);
        }
        const ta = el("textarea", "vte-list");
        ta.value = items.join("\n");
        ta.rows = 3;
        ta.onchange = () => runOp(() => model.writeTerminalValue(scope, path, linesToList(ta.value)));
        return ta;
      }
      case "tag_list": {
        const items = Array.isArray(node.value) ? node.value : [];
        return renderChips(items, (list) => model.writeTerminalValue(scope, path, list), false);
      }
      default:
        return el("span", "muted", `未知类型 ${node.valueType}`);
    }
  }

  /** 从动末端的只读值呈现：数值/字符串原样、string_list 纯名只读 chips、tag_list 只读 chips。 */
  function renderDerivedValue(node) {
    if (!node.hasInstance) return el("span", "muted", "（无实例）");
    if (node.valueType === "tag_list") {
      return renderChips(Array.isArray(node.value) ? node.value : [], null, true);
    }
    if (node.valueType === "string_list") {
      return renderNameChips(Array.isArray(node.value) ? node.value : [], null, true);
    }
    return el("span", "vte-readonly", String(node.value));
  }

  /** formula 只读标注文本。 */
  function formulaLabel(f) {
    if (f === null) return "";
    if (f.kind === "expr") {
      const binds = Object.entries(f.binds).map(([k, p]) => `${k}=${p}`).join("，");
      return `ƒ ${f.expr}${binds ? `（${binds}）` : ""}`;
    }
    return `ƒ union_attach(${f.paths.join(", ")})`;
  }

  // ---- 行内表单 ---------------------------------------------------------------

  /** 类型容器新增实例行内表单（只动实例不动模板；relations 同通道）。 */
  function renderInstForm() {
    const form = el("div", "vte-form");
    const name = el("input");
    name.type = "text";
    name.placeholder = "实例名";
    name.value = instForm.name;
    name.onchange = () => {
      instForm.name = name.value;
    };
    form.appendChild(name);
    const ok = el("button", "vte-btn", "确定");
    ok.onclick = () =>
      runOp(() => {
        model.addTypeInstance(scope, instForm.path, instForm.name);
        instForm = null;
      });
    const cancel = el("button", "vte-btn", "取消");
    cancel.onclick = () => {
      instForm = null;
      render();
    };
    form.append(ok, cancel);
    return form;
  }

  // ---- 树渲染 ---------------------------------------------------------------

  /** 折叠箭头（foldable = false 时出占位保持对齐）。 */
  function chevron(fk, foldable) {
    if (!foldable) return el("span", "vte-fold");
    const isFolded = folded.has(fk);
    const span = el("span", "vte-fold", isFolded ? "▸" : "▾");
    span.onclick = () => {
      if (folded.has(fk)) folded.delete(fk);
      else folded.add(fk);
      render();
    };
    return span;
  }

  /** 只读行（未声明键）。 */
  function renderReadonlyRow(node, out) {
    const row = el("div", "vte-row");
    row.appendChild(chevron("", false));
    row.appendChild(el("span", "vte-key", node.key));
    row.appendChild(el("span", "vte-badge", "未声明"));
    row.appendChild(el("span", "muted", node.display));
    out.appendChild(row);
  }

  /** 外壳 tags 行内编辑展开区（系统末端写侧车、vars 末端写外壳，模型层分流）。 */
  function renderTagsEditor(node, out) {
    const tk = foldKey(node.path);
    if (!tagsOpen.has(tk)) return;
    const kids = el("div", "vte-kids");
    const box = el("div", "vte-form");
    box.appendChild(el("span", "muted", "外壳 tags"));
    box.appendChild(renderChips(node.tags, (list) => model.writeTerminalTags(scope, node.path, list), false, node.attachTags));
    kids.appendChild(box);
    out.appendChild(kids);
  }

  /** tags 操作钮（全部末端含系统字段可编；附加来源计数 +n 只读展示）。 */
  function tagsButton(node) {
    const attach = Array.isArray(node.attachTags) ? node.attachTags.length : 0;
    return iconBtn(`tags·${node.tags.length}${attach > 0 ? `+${attach}` : ""}`, "外壳 tags（TAG 挂载位；+n = 附加来源只读）", () => {
      const tk = foldKey(node.path);
      if (tagsOpen.has(tk)) tagsOpen.delete(tk);
      else tagsOpen.add(tk);
      render();
    });
  }

  /** 变量末端行：名称 + 控件（系统 = 只读值 + 系统徽记；从动 = 只读值 + formula 标注）+ hover tags。 */
  function renderTerminal(node, out) {
    const row = el("div", "vte-row");
    row.appendChild(chevron("", false));
    row.appendChild(el("span", "vte-key", node.key));
    if (node.valueType === "tag_list") row.appendChild(el("span", "vte-badge", "tag_list"));
    if (node.system) {
      row.appendChild(el("span", "vte-badge", "系统"));
      row.appendChild(el("span", "vte-readonly", JSON.stringify(node.value) ?? "undefined"));
    } else if (node.derived) {
      row.appendChild(el("span", "vte-badge vte-derived", "从动"));
      row.appendChild(renderDerivedValue(node));
      row.appendChild(el("span", "vte-formula", formulaLabel(node.formula)));
    } else {
      row.appendChild(renderValueControl(node));
    }
    row.appendChild(actionsOf(tagsButton(node)));
    out.appendChild(row);
    renderTagsEditor(node, out);
  }

  /** initiative null 通道：空输入两值暂存，齐全即整体写入对象（不做清空回 null）。 */
  function renderInitiativeNullForm(node, out) {
    const pk = `${scope}|${node.path}`;
    const pending = structPending.get(pk) ?? { texts: {} };
    for (const child of node.children) {
      const crow = el("div", "vte-row");
      crow.appendChild(chevron("", false));
      crow.appendChild(el("span", "vte-key", child.key));
      const input = el("input");
      input.type = child.valueType === "number" ? "number" : "text";
      input.value = pending.texts[child.key] ?? "";
      input.onchange = () => {
        pending.texts[child.key] = input.value;
        structPending.set(pk, pending);
        const ready = node.children.every((c) => (pending.texts[c.key] ?? "").trim() !== "");
        if (ready) {
          runOp(() => {
            const obj = {};
            for (const c of node.children) {
              obj[c.key] = c.valueType === "number" ? Number(pending.texts[c.key]) : pending.texts[c.key];
            }
            model.writeTerminalValue(scope, node.path, obj);
            structPending.delete(pk);
          });
        }
      };
      crow.appendChild(input);
      out.appendChild(crow);
    }
  }

  /** 容器类行（普通容器 / 类型容器 / 类型实例）：折叠箭头 + 加粗名称 + 计数 + hover 操作。 */
  function renderContainerLike(node, out) {
    const fk = foldKey(node.path);
    const row = el("div", "vte-row");
    row.appendChild(chevron(fk, true));
    row.appendChild(el("span", "vte-key vte-key-dir", node.key));
    if (node.kind === "typeContainer") row.appendChild(el("span", "vte-badge vte-type", node.typeName));
    if (node.kind === "typeInstance") row.appendChild(el("span", "vte-badge", "实例"));
    // initiative null = 容器无实例（系统分支投影）
    const isNullInitiative = node.path === "initiative" && node.children.every((c) => !c.hasInstance);
    if (isNullInitiative) row.appendChild(el("span", "vte-badge", "null"));
    row.appendChild(el("span", "vte-count", `${node.children.length}`));

    const btns = [];
    if (node.kind === "typeContainer") {
      btns.push(
        iconBtn("+", "新增实例（只动实例不动模板）", () => {
          instForm = { path: node.path, name: "" };
          folded.delete(fk); // 展开以露出表单
          render();
        }),
      );
    }
    if (node.kind === "typeInstance" && node.canRemoveInstance) {
      const parentPath = node.path.includes(".") ? node.path.slice(0, node.path.lastIndexOf(".")) : "";
      btns.push(
        iconBtn("×", "删除实例（不动模板）", () => runOp(() => model.removeTypeInstance(scope, parentPath, node.key))),
      );
    }
    if (btns.length > 0) row.appendChild(actionsOf(...btns));
    out.appendChild(row);

    if (folded.has(fk)) return;
    const kids = el("div", "vte-kids");
    if (instForm !== null && instForm.path === node.path) kids.appendChild(renderInstForm());
    if (isNullInitiative) {
      renderInitiativeNullForm(node, kids);
    } else {
      for (const child of node.children) renderNode(child, kids);
    }
    out.appendChild(kids);
  }

  function renderNode(node, out) {
    switch (node.kind) {
      case "unknown":
        renderReadonlyRow(node, out);
        return;
      case "terminal":
        renderTerminal(node, out);
        return;
      case "container":
      case "typeContainer":
      case "typeInstance":
        renderContainerLike(node, out);
        return;
      default:
        renderReadonlyRow({ key: node.key ?? "?", kind: "unknown", display: "未知节点" }, out);
    }
  }

  /** 可折叠区块：箭头 + 标题 + 子级参考线容器。 */
  function renderSection(title, secId, out, renderKids) {
    const sk = `${scope}|${secId}`;
    const head = el("div", "vte-sec-head");
    const ch = el("span", "vte-fold", secFolded.has(sk) ? "▸" : "▾");
    ch.onclick = () => {
      if (secFolded.has(sk)) secFolded.delete(sk);
      else secFolded.add(sk);
      render();
    };
    head.appendChild(ch);
    head.appendChild(el("span", null, title));
    out.appendChild(head);
    if (secFolded.has(sk)) return;
    const kids = el("div", "vte-kids");
    renderKids(kids);
    out.appendChild(kids);
  }

  function render() {
    const scrollTop = scrollHost?.scrollTop; // 重渲前暂存滚动位（树塌陷会钳回 0）
    root.textContent = "";
    // 头行：作用域切换 + TAG 名 datalist
    const head = el("div", "vte-head");
    head.appendChild(el("span", "muted", "作用域"));
    const select = el("select", "vte-scope");
    for (const s of model.listScopes()) {
      const opt = el("option", null, s.label);
      opt.value = s.id;
      select.appendChild(opt);
    }
    select.value = scope;
    select.onchange = () => {
      scope = select.value;
      instForm = null;
      render();
    };
    head.appendChild(select);
    const datalist = el("datalist");
    datalist.id = datalistId;
    for (const name of model.getTagNames()) {
      const opt = el("option");
      opt.value = name;
      datalist.appendChild(opt);
    }
    head.appendChild(datalist);
    root.appendChild(head);

    const tree = el("div", "vte-tree");
    renderSection(scope === WORLD_SCOPE ? "世界变量" : "角色变量", "sec-vars", tree, (kids) => {
      for (const node of model.buildTree(scope).children) renderNode(node, kids);
    });
    root.appendChild(tree);
    root.appendChild(errEl);
    if (scrollHost && typeof scrollTop === "number") scrollHost.scrollTop = scrollTop; // 重渲后还原
  }

  render();
  return { root };
}
