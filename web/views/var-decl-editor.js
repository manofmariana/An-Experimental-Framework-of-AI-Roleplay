/**
 * 世界页「变量结构」DOM 层：变量模板声明树编辑器 + TAG 附加编辑器。
 *
 * createVarDeclEditor：渲染 var-decl-model 视图模型——根切换（世界 / 角色共享模板）+
 * 声明树区 + 类型区 + 错误行（模型操作报错原样落此）：
 * - 树形缩进（.vte-kids 左侧参考线）+ 容器折叠箭头（默认展开，按 root|path 持有）；
 * - 结构操作（+/×/ƒ）收在行尾 .vte-actions，行 hover 才浮现；
 * - 容器「+」开行内设定表单（名称 + 种类：五 valueType 扁平末端/结构体/结构化数组
 *   （引用类型或内联结构）——纯声明，无初始值/实例列）；类型区「+」= 新建类型，
 *   类型/内联数组字段上同一表单逐字段定义；删除（声明/类型/类型字段）一点即删
 *   （模型保护 character 根必需声明）；
 * - ƒ 开 formula 行内表单（expr = 表达式 + binds 每行 `标识符=路径`；union_attach =
 *   paths 每行一个；选「无」清空），从动末端带「从动」徽记 + formula 可读文本；
 * - character 根的系统声明分支节点带「系统」徽记，全部结构操作（+/×/ƒ）不渲染
 *   （只读展示；模型层对系统路径写操作同样抛错兜底）。
 *
 * createVarsTagsEditor：渲染 vars-tags-model 视图模型——声明树每个节点（含根节点
 * 自身）挂附加条目 chip（名称/类别 + 等级小字 + ×），行尾小型添加（下拉选「名称」
 * （datalist 来自同包 tags.json 注册表，允许自由输入）或「cid 类别」（按属主分发）
 * + level 1-7）；结构化数组节点整型挂载（{tags, array} 形式，扇出到元素结构全部
 * 末端），存在 children 旧形态时只读提示（不在本编辑器管理面）。
 *
 * el/model 注入，import 期零副作用。
 */

/** 结构新增种类选项（值 = 内部令牌：vt:* 扁平末端 / struct 结构体 / array 结构化数组（引用类型）/ arrayInline 结构化数组（内联结构））。 */
const KIND_OPTIONS = [
  ["vt:string", "字符串"],
  ["vt:number", "数值"],
  ["vt:boolean", "布尔"],
  ["vt:string_list", "扁平数组"],
  ["vt:tag_list", "TAG 数组"],
  ["struct", "结构体"],
  ["array", "结构化数组（引用类型）"],
  ["arrayInline", "结构化数组（内联结构）"],
];

/** formula 可读表达式文本。 */
function formulaLabel(f) {
  if (f === null) return "";
  if (f.kind === "expr") {
    const binds = Object.entries(f.binds).map(([k, p]) => `${k}=${p}`).join("，");
    return `ƒ ${f.expr}${binds ? `（${binds}）` : ""}`;
  }
  return `ƒ union_attach(${f.paths.join(", ")})`;
}

/**
 * 变量模板声明树编辑器。
 * @param {object} deps
 * @param {(tag: string, className?: string|null, text?: string) => any} deps.el DOM 构造器
 * @param {object} deps.model createVarDeclModel 产物
 * @returns {{root: any}} 挂载 root；保存载荷经 model.getTemplate() 取
 */
export function createVarDeclEditor({ el, model }) {
  let root = "world"; // 当前声明根（world / character）
  const folded = new Set(); // 折叠的容器 `${root}|${path}`
  const secFolded = new Set(); // 折叠的区块 `${root}|${section}`
  let addForm = null; // {target, root, path, typeName, name, kind, typeRef}
  let formulaForm = null; // {path, mode, exprText, bindsText, pathsText}

  const rootEl = el("div", "vte");
  const errEl = el("div", "vte-error");

  /** 模型操作统一出口：报错落错误行，随后整树重渲。 */
  function runOp(fn) {
    errEl.textContent = "";
    try {
      fn();
    } catch (err) {
      errEl.textContent = err.message ?? String(err);
    }
    render();
  }

  const foldKey = (path) => `${root}|${path}`;

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

  // ---- 行内表单 ---------------------------------------------------------------

  /** 空白结构新增表单状态。 */
  function openAddForm(target, info) {
    addForm = {
      target,
      path: info.path ?? "",
      typeName: info.typeName ?? "",
      name: "",
      kind: "vt:number",
      typeRef: model.listTypeNames()[0] ?? "",
    };
  }

  /** 结构新增/新建类型行内表单（纯声明，无初始值）。 */
  function renderAddForm() {
    const form = el("div", "vte-form");
    const name = el("input");
    name.type = "text";
    name.placeholder = addForm.target === "newType" ? "类型名" : "名称";
    name.value = addForm.name;
    name.onchange = () => {
      addForm.name = name.value;
    };
    form.appendChild(name);

    if (addForm.target !== "newType") {
      const kind = el("select");
      for (const [value, label] of KIND_OPTIONS) {
        const opt = el("option", null, label);
        opt.value = value;
        kind.appendChild(opt);
      }
      kind.value = addForm.kind;
      kind.onchange = () => {
        addForm.kind = kind.value;
        render(); // 换种类 = 换类型选择控件
      };
      form.appendChild(kind);

      if (addForm.kind === "array") {
        const typeNames = model.listTypeNames();
        if (typeNames.length === 0) {
          form.appendChild(el("span", "muted", "尚无类型：请先在「类型」区新建"));
        } else {
          const sel = el("select");
          for (const tn of typeNames) {
            const opt = el("option", null, tn);
            opt.value = tn;
            sel.appendChild(opt);
          }
          if (!typeNames.includes(addForm.typeRef)) addForm.typeRef = typeNames[0];
          sel.value = addForm.typeRef;
          sel.onchange = () => {
            addForm.typeRef = sel.value;
          };
          form.appendChild(sel);
        }
      }
    }

    const ok = el("button", "vte-btn", "确定");
    ok.onclick = () =>
      runOp(() => {
        if (addForm.target === "newType") {
          model.addType(addForm.name);
          addForm = null;
          return;
        }
        const spec = { name: addForm.name };
        if (addForm.kind.startsWith("vt:")) {
          spec.kind = "terminal";
          spec.valueType = addForm.kind.slice(3);
        } else if (addForm.kind === "struct") {
          spec.kind = "struct";
        } else if (addForm.kind === "array") {
          spec.kind = "array";
          spec.typeName = addForm.typeRef;
        } else {
          spec.kind = "arrayInline";
        }
        if (addForm.target === "typeField") model.addTypeField(addForm.typeName, addForm.path, spec);
        else model.addDecl(root, addForm.path, spec);
        addForm = null;
      });
    const cancel = el("button", "vte-btn", "取消");
    cancel.onclick = () => {
      addForm = null;
      render();
    };
    form.append(ok, cancel);
    return form;
  }

  /** formula 行内表单：无 / expr 公式（表达式 + binds 每行 标识符=路径）/ union_attach（paths 每行一个）。 */
  function renderFormulaForm() {
    const form = el("div", "vte-form-col");
    const head = el("div", "vte-form");
    head.appendChild(el("span", "muted", "formula"));
    const mode = el("select");
    for (const [value, label] of [["none", "无（普通末端）"], ["expr", "expr 公式"], ["unionAttach", "union_attach"]]) {
      const opt = el("option", null, label);
      opt.value = value;
      mode.appendChild(opt);
    }
    mode.value = formulaForm.mode;
    mode.onchange = () => {
      formulaForm.mode = mode.value;
      render();
    };
    head.appendChild(mode);
    form.appendChild(head);
    if (formulaForm.target === "type") {
      const hint = el("div", "vte-form");
      hint.appendChild(el("span", "muted", "类型内公式路径以类型为根"));
      form.appendChild(hint);
    }

    if (formulaForm.mode === "expr") {
      const expr = el("input");
      expr.type = "text";
      expr.placeholder = "表达式，如 str * 2";
      expr.value = formulaForm.exprText;
      expr.onchange = () => {
        formulaForm.exprText = expr.value;
      };
      const binds = el("textarea", "vte-list");
      binds.rows = 2;
      binds.placeholder = "binds（每行 标识符=模板路径）";
      binds.value = formulaForm.bindsText;
      binds.onchange = () => {
        formulaForm.bindsText = binds.value;
      };
      form.append(expr, binds);
    } else if (formulaForm.mode === "unionAttach") {
      const paths = el("textarea", "vte-list");
      paths.rows = 2;
      paths.placeholder = "paths（每行一个同根模板路径）";
      paths.value = formulaForm.pathsText;
      paths.onchange = () => {
        formulaForm.pathsText = paths.value;
      };
      form.appendChild(paths);
    }

    const foot = el("div", "vte-form");
    const ok = el("button", "vte-btn", "确定");
    ok.onclick = () =>
      runOp(() => {
        let formula = null;
        if (formulaForm.mode === "expr") {
          const binds = {};
          for (const line of formulaForm.bindsText.split("\n")) {
            const t = line.trim();
            if (t === "") continue;
            const eq = t.indexOf("=");
            if (eq <= 0) throw new Error(`binds 行须为 标识符=模板路径：「${t}」`);
            binds[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
          }
          formula = { expr: formulaForm.exprText.trim(), binds };
        } else if (formulaForm.mode === "unionAttach") {
          formula = {
            op: "union_attach",
            paths: formulaForm.pathsText.split("\n").map((s) => s.trim()).filter((s) => s !== ""),
          };
        }
        if (formulaForm.target === "type") model.setTypeDeclFormula(formulaForm.typeName, formulaForm.path, formula);
        else model.setDeclFormula(root, formulaForm.path, formula);
        formulaForm = null;
      });
    const cancel = el("button", "vte-btn", "取消");
    cancel.onclick = () => {
      formulaForm = null;
      render();
    };
    foot.append(ok, cancel);
    form.appendChild(foot);
    return form;
  }

  // ---- 树渲染 ---------------------------------------------------------------

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

  /** 只读行（不可判别声明）。 */
  function renderReadonlyRow(node, out) {
    const row = el("div", "vte-row");
    row.appendChild(chevron("", false));
    row.appendChild(el("span", "vte-key", node.key));
    row.appendChild(el("span", "vte-badge", "未识别"));
    row.appendChild(el("span", "muted", node.display));
    out.appendChild(row);
  }

  /** 声明末端行：名称 + valueType 徽记（+ 从动徽记与 formula 文本）+ hover ƒ/×；系统节点只读。 */
  function renderDeclTerminal(node, out) {
    const row = el("div", "vte-row");
    row.appendChild(chevron("", false));
    row.appendChild(el("span", "vte-key", node.key));
    row.appendChild(el("span", "vte-badge", node.valueType));
    if (node.system) row.appendChild(el("span", "vte-badge", "系统"));
    if (node.derived) {
      row.appendChild(el("span", "vte-badge vte-derived", "从动"));
      row.appendChild(el("span", "vte-formula", formulaLabel(node.formula)));
    }
    const btns = [];
    if (!node.system) {
      btns.push(
        iconBtn("ƒ", "编辑 formula 声明（选「无」清空）", () => {
          formulaForm = {
            target: "decl",
            path: node.path,
            mode: node.formula === null ? "none" : node.formula.kind,
            exprText: node.formula !== null && node.formula.kind === "expr" ? node.formula.expr : "",
            bindsText:
              node.formula !== null && node.formula.kind === "expr"
                ? Object.entries(node.formula.binds).map(([k, p]) => `${k}=${p}`).join("\n")
                : "",
            pathsText: node.formula !== null && node.formula.kind === "unionAttach" ? node.formula.paths.join("\n") : "",
          };
          render();
        }),
      );
    }
    if (node.canDelete) {
      btns.push(iconBtn("×", "删除声明", () => runOp(() => model.deleteDecl(root, node.path))));
    }
    if (btns.length > 0) row.appendChild(actionsOf(...btns));
    out.appendChild(row);

    if (formulaForm !== null && formulaForm.target === "decl" && formulaForm.path === node.path) {
      const kids = el("div", "vte-kids");
      kids.appendChild(renderFormulaForm());
      out.appendChild(kids);
    }
  }

  /** 声明容器/结构化数组行：折叠箭头 + 加粗名称 + 计数 + hover 操作；系统节点只读（无 +/×）。
   *  引用类型数组不展开（元素字段到类型区编辑）；内联元素结构可折叠展开并经 `[*]` 路径新增字段。 */
  function renderDeclContainerLike(node, out) {
    const isArray = node.kind === "declArray";
    const expandable = node.kind === "declContainer" || (isArray && node.elementType === null);
    const fk = foldKey(node.path);
    const row = el("div", "vte-row");
    row.appendChild(chevron(fk, expandable));
    row.appendChild(el("span", "vte-key vte-key-dir", node.key));
    if (isArray) row.appendChild(el("span", "vte-badge vte-type", node.elementType ?? "内联数组"));
    if (node.system) row.appendChild(el("span", "vte-badge", "系统"));
    if (expandable) row.appendChild(el("span", "vte-count", `${node.children.length}`));

    const btns = [];
    if (expandable && !node.system) {
      btns.push(
        iconBtn("+", "新增声明（扁平末端/结构体/结构化数组）", () => {
          openAddForm("decl", { path: isArray ? `${node.path}[*]` : node.path });
          folded.delete(fk); // 展开以露出表单
          render();
        }),
      );
    }
    if (node.canDelete) {
      btns.push(iconBtn("×", "删除声明", () => runOp(() => model.deleteDecl(root, node.path))));
    }
    if (btns.length > 0) row.appendChild(actionsOf(...btns));
    out.appendChild(row);

    if (!expandable || folded.has(fk)) return;
    const kids = el("div", "vte-kids");
    if (addForm !== null && addForm.target === "decl" && addForm.path === (isArray ? `${node.path}[*]` : node.path)) {
      kids.appendChild(renderAddForm());
    }
    for (const child of node.children) renderNode(child, kids);
    out.appendChild(kids);
  }

  /** 类型根行：+ 加字段 / × 删类型。 */
  function renderTypeRoot(node, out) {
    const fk = foldKey(`types|${node.path}`);
    const row = el("div", "vte-row");
    row.appendChild(chevron(fk, true));
    row.appendChild(el("span", "vte-key vte-key-dir", node.key));
    row.appendChild(el("span", "vte-badge vte-type", "类型"));
    row.appendChild(el("span", "vte-count", `${node.children.length}`));
    row.appendChild(
      actionsOf(
        iconBtn("+", "新增字段", () => {
          openAddForm("typeField", { typeName: node.key, path: "" });
          folded.delete(fk);
          render();
        }),
        iconBtn("×", "删除类型（被 {type} 容器引用时拒绝）", () => runOp(() => model.deleteType(node.key))),
      ),
    );
    out.appendChild(row);
    if (folded.has(fk)) return;
    const kids = el("div", "vte-kids");
    if (addForm !== null && addForm.target === "typeField" && addForm.typeName === node.key && addForm.path === "") {
      kids.appendChild(renderAddForm());
    }
    for (const child of node.children) renderNode(child, kids);
    out.appendChild(kids);
  }

  /** 类型声明容器/内联数组字段行：+ 递归加子字段 / × 删字段。 */
  function renderTypeDeclContainer(node, out) {
    const isArray = node.kind === "typeDeclArray";
    const kidsPath = isArray ? `${node.path}[*]` : node.path;
    const fk = foldKey(`types|${node.typeName}|${node.path}`);
    const row = el("div", "vte-row");
    row.appendChild(chevron(fk, true));
    row.appendChild(el("span", "vte-key vte-key-dir", node.key));
    if (isArray) row.appendChild(el("span", "vte-badge vte-type", "内联数组"));
    row.appendChild(el("span", "vte-count", `${node.children.length}`));
    row.appendChild(
      actionsOf(
        iconBtn("+", "新增子字段", () => {
          openAddForm("typeField", { typeName: node.typeName, path: kidsPath });
          folded.delete(fk);
          render();
        }),
        iconBtn("×", "删除字段", () => runOp(() => model.removeTypeField(node.typeName, node.path))),
      ),
    );
    out.appendChild(row);
    if (folded.has(fk)) return;
    const kids = el("div", "vte-kids");
    if (
      addForm !== null &&
      addForm.target === "typeField" &&
      addForm.typeName === node.typeName &&
      addForm.path === kidsPath
    ) {
      kids.appendChild(renderAddForm());
    }
    for (const child of node.children) renderNode(child, kids);
    out.appendChild(kids);
  }

  /** 类型声明叶子字段行（末端 / 引用类型数组）：末端带 ƒ formula 表单；× 删字段。 */
  function renderTypeDeclLeaf(node, out) {
    const row = el("div", "vte-row");
    row.appendChild(chevron("", false));
    row.appendChild(el("span", "vte-key", node.key));
    const btns = [];
    if (node.kind === "typeDeclTerminal") {
      row.appendChild(el("span", "vte-badge", node.valueType));
      if (node.derived) {
        row.appendChild(el("span", "vte-badge vte-derived", "从动"));
        row.appendChild(el("span", "vte-formula", formulaLabel(node.formula)));
      }
      btns.push(
        iconBtn("ƒ", "编辑 formula 声明（路径以类型为根；选「无」清空）", () => {
          formulaForm = {
            target: "type",
            typeName: node.typeName,
            path: node.path,
            mode: node.formula === null || node.formula === undefined ? "none" : node.formula.kind,
            exprText: node.formula != null && node.formula.kind === "expr" ? node.formula.expr : "",
            bindsText:
              node.formula != null && node.formula.kind === "expr"
                ? Object.entries(node.formula.binds).map(([k, p]) => `${k}=${p}`).join("\n")
                : "",
            pathsText: node.formula != null && node.formula.kind === "unionAttach" ? node.formula.paths.join("\n") : "",
          };
          render();
        }),
      );
    } else {
      row.appendChild(el("span", "vte-badge vte-type", `${node.elementType}[]`));
    }
    btns.push(iconBtn("×", "删除字段", () => runOp(() => model.removeTypeField(node.typeName, node.path))));
    row.appendChild(actionsOf(...btns));
    out.appendChild(row);

    if (
      formulaForm !== null &&
      formulaForm.target === "type" &&
      formulaForm.typeName === node.typeName &&
      formulaForm.path === node.path
    ) {
      const kids = el("div", "vte-kids");
      kids.appendChild(renderFormulaForm());
      out.appendChild(kids);
    }
  }

  function renderNode(node, out) {
    switch (node.kind) {
      case "unknown":
        renderReadonlyRow(node, out);
        return;
      case "declTerminal":
        renderDeclTerminal(node, out);
        return;
      case "declContainer":
      case "declArray":
        renderDeclContainerLike(node, out);
        return;
      case "typeRoot":
        renderTypeRoot(node, out);
        return;
      case "typeDeclContainer":
        renderTypeDeclContainer(node, out);
        return;
      case "typeDeclArray":
        if (node.elementType === null) renderTypeDeclContainer(node, out);
        else renderTypeDeclLeaf(node, out);
        return;
      case "typeDeclTerminal":
        renderTypeDeclLeaf(node, out);
        return;
      default:
        renderReadonlyRow({ key: node.key ?? "?", display: "未知节点" }, out);
    }
  }

  /** 可折叠区块：箭头 + 标题 + 头部操作 + 子级参考线容器。 */
  function renderSection(title, secId, out, headerActions, renderKids) {
    const sk = `${root}|${secId}`;
    const head = el("div", "vte-sec-head");
    const ch = el("span", "vte-fold", secFolded.has(sk) ? "▸" : "▾");
    ch.onclick = () => {
      if (secFolded.has(sk)) secFolded.delete(sk);
      else secFolded.add(sk);
      render();
    };
    head.appendChild(ch);
    head.appendChild(el("span", null, title));
    if (headerActions !== null) head.appendChild(headerActions);
    out.appendChild(head);
    if (secFolded.has(sk)) return;
    const kids = el("div", "vte-kids");
    renderKids(kids);
    out.appendChild(kids);
  }

  function render() {
    rootEl.textContent = "";
    // 头行：声明根切换
    const head = el("div", "vte-head");
    head.appendChild(el("span", "muted", "声明根"));
    const select = el("select", "vte-scope");
    for (const r of model.listRoots()) {
      const opt = el("option", null, r.label);
      opt.value = r.id;
      select.appendChild(opt);
    }
    select.value = root;
    select.onchange = () => {
      root = select.value;
      addForm = null;
      formulaForm = null;
      render();
    };
    head.appendChild(select);
    rootEl.appendChild(head);

    const tree = el("div", "vte-tree");
    renderSection(
      "声明树",
      "sec-decl",
      tree,
      actionsOf(
        iconBtn("+", "新增根级声明", () => {
          openAddForm("decl", { path: "" });
          secFolded.delete(`${root}|sec-decl`);
          render();
        }),
      ),
      (kids) => {
        if (addForm !== null && addForm.target === "decl" && addForm.path === "") {
          kids.appendChild(renderAddForm());
        }
        for (const node of model.buildRootView(root).children) renderNode(node, kids);
      },
    );
    renderSection(
      "类型",
      "sec-types",
      tree,
      actionsOf(
        iconBtn("+", "新建类型（命名 + 空结构体）", () => {
          openAddForm("newType", {});
          secFolded.delete(`${root}|sec-types`);
          render();
        }),
      ),
      (kids) => {
        if (addForm !== null && addForm.target === "newType") kids.appendChild(renderAddForm());
        for (const node of model.buildTypesView().children) renderNode(node, kids);
      },
    );
    rootEl.appendChild(tree);
    rootEl.appendChild(errEl);
  }

  render();
  return { root: rootEl };
}

/**
 * TAG 附加编辑器。
 * @param {object} deps
 * @param {(tag: string, className?: string|null, text?: string) => any} deps.el DOM 构造器
 * @param {object} deps.model createVarsTagsModel 产物
 * @param {string[]} deps.tagNames 同包 tags.json 注册表条目名（datalist 下拉；自由输入不受限）
 * @returns {{root: any}} 挂载 root；保存载荷经 model.getPayload() 取
 */
export function createVarsTagsEditor({ el, model, tagNames }) {
  let root = "world";
  const folded = new Set();

  const rootEl = el("div", "vte");
  const errEl = el("div", "vte-error");
  const datalistId = "vde-tag-names";

  function runOp(fn) {
    errEl.textContent = "";
    try {
      fn();
    } catch (err) {
      errEl.textContent = err.message ?? String(err);
    }
    render();
  }

  const foldKey = (path) => `${root}|${path}`;

  function iconBtn(text, title, onclick) {
    const b = el("button", "vte-icon", text);
    b.title = title;
    b.onclick = onclick;
    return b;
  }

  /** 附加条目 chips：{name} 原名、{category} 显示「类·名」；行尾小型添加（下拉选名称/「cid 类别」）。 */
  function renderChips(node) {
    const box = el("span", "vte-chips");
    node.entries.forEach((entry, i) => {
      const chip = el("span", "vte-chip");
      chip.appendChild(el("span", null, "name" in entry ? entry.name : `类·${entry.category}`));
      chip.appendChild(el("span", "vte-chip-level", `Lv${entry.level}`));
      const x = el("button", "vte-chip-x", "×");
      x.title = "移除";
      x.onclick = () => runOp(() => model.setNodeTags(root, node.path, node.entries.filter((_, j) => j !== i)));
      chip.appendChild(x);
      box.appendChild(chip);
    });
    const kind = el("select");
    for (const [value, label] of [["name", "名称"], ["cid", "cid 类别（按属主分发）"]]) {
      const opt = el("option", null, label);
      opt.value = value;
      kind.appendChild(opt);
    }
    const name = el("input");
    name.type = "text";
    name.setAttribute("list", datalistId);
    name.placeholder = "TAG 名";
    kind.onchange = () => {
      name.disabled = kind.value !== "name";
    };
    const level = el("input");
    level.type = "number";
    level.min = "1";
    level.max = "7";
    level.value = "1";
    level.title = "等级 1-7";
    const add = iconBtn("+", "添加附加条目", () =>
      runOp(() => {
        const lv = Number(level.value);
        if (kind.value === "cid") {
          model.setNodeTags(root, node.path, [...node.entries, { category: "cid", level: lv }]);
          return;
        }
        const nm = name.value.trim();
        if (nm === "") throw new Error("TAG 名不能为空");
        model.setNodeTags(root, node.path, [...node.entries, { name: nm, level: lv }]);
      }),
    );
    box.append(kind, name, level, add);
    return box;
  }

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

  function renderNode(node, out) {
    if (node.kind === "unknown") {
      const row = el("div", "vte-row");
      row.appendChild(chevron("", false));
      row.appendChild(el("span", "vte-key", node.key));
      row.appendChild(el("span", "vte-badge", "未识别"));
      row.appendChild(el("span", "muted", node.display));
      out.appendChild(row);
      return;
    }
    if (node.kind === "tagsTerminal" || node.kind === "tagsArray") {
      const row = el("div", "vte-row");
      row.appendChild(chevron("", false));
      row.appendChild(el("span", "vte-key", node.key));
      if (node.kind === "tagsArray") {
        row.appendChild(el("span", "vte-badge vte-type", node.elementType !== null ? `${node.elementType}[]` : "内联数组"));
      } else {
        row.appendChild(el("span", "vte-badge", node.valueType));
      }
      if (node.kind === "tagsArray" && node.hasLegacyChildren) {
        row.appendChild(el("span", "muted", "（存在 children 旧形态附加，本编辑器不管理）"));
      } else {
        row.appendChild(renderChips(node));
      }
      out.appendChild(row);
      return;
    }
    // tagsContainer：折叠箭头 + 自身条目 chips + 子级
    const fk = foldKey(node.path);
    const row = el("div", "vte-row");
    row.appendChild(chevron(fk, true));
    row.appendChild(el("span", "vte-key vte-key-dir", node.key));
    row.appendChild(renderChips(node));
    out.appendChild(row);
    if (folded.has(fk)) return;
    const kids = el("div", "vte-kids");
    for (const child of node.children) renderNode(child, kids);
    out.appendChild(kids);
  }

  function render() {
    rootEl.textContent = "";
    const head = el("div", "vte-head");
    head.appendChild(el("span", "muted", "声明根"));
    const select = el("select", "vte-scope");
    for (const r of model.listRoots()) {
      const opt = el("option", null, r.label);
      opt.value = r.id;
      select.appendChild(opt);
    }
    select.value = root;
    select.onchange = () => {
      root = select.value;
      render();
    };
    head.appendChild(select);
    const datalist = el("datalist");
    datalist.id = datalistId;
    for (const name of tagNames) {
      const opt = el("option");
      opt.value = name;
      datalist.appendChild(opt);
    }
    head.appendChild(datalist);
    rootEl.appendChild(head);

    const tree = el("div", "vte-tree");
    const view = model.buildRootView(root);
    // 根节点自身条目（根挂 = 级联到该根全部末端）
    const rootRow = el("div", "vte-row");
    rootRow.appendChild(el("span", "vte-fold"));
    rootRow.appendChild(el("span", "vte-key vte-key-dir", "（根）"));
    rootRow.appendChild(renderChips({ path: "", entries: view.rootEntries }));
    tree.appendChild(rootRow);
    const kids = el("div", "vte-kids");
    for (const node of view.children) renderNode(node, kids);
    tree.appendChild(kids);
    rootEl.appendChild(tree);
    rootEl.appendChild(errEl);
  }

  render();
  return { root: rootEl };
}
