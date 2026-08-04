/** 世界页：世界包选择器 + setting / tone-card 编辑器 + lorebook 条目表格（增删改、enabled 开关）。
 *  D5 ResourceContext（docs/optimization-review.md §10）：打开即捕获不可变 ctx
 *  （GET/PUT 全程携带 ?set=——修复「无法编辑非默认包」）；切换包 = 重新捕获 ctx + 重载表单
 *  （旧表单不存活）；保存写打开时捕获的同一 ctx，不重读 picker；界面上持续显示「正在编辑」的包名。 */
import { api, el } from "../app.js";
import { createResourceContext } from "../resource-context.js";

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

/** 表单整体（两个 Markdown 编辑器 + lorebook 表格）；所有 URL 经捕获的 ctx 构造。 */
async function renderWorldForm(host, ctx) {
  const data = await api(ctx.worldUrl());

  // ---- 两个 Markdown 编辑器 ----
  const editors = [
    ["setting", "世界设定（GM 的 L1）", data.setting],
    ["tone-card", "世界基调卡（正文的 L1）", data.toneCard],
  ];
  for (const [name, label, content] of editors) {
    host.appendChild(el("h3", null, label));
    const ta = el("textarea");
    ta.rows = 10;
    ta.value = content;
    const save = el("button", "act", "保存");
    const status = el("span", "muted");
    save.onclick = async () => {
      status.textContent = "";
      try {
        const resp = await api(ctx.worldFileUrl(name), "PUT", { content: ta.value });
        status.textContent = ` ${resp.note}`;
      } catch (err) {
        status.textContent = ` 保存失败：${err.message}`;
      }
    };
    host.append(ta, el("div"), save, status);
  }

  // ---- lorebook 表格 ----
  host.appendChild(el("h3", null, "Lorebook 条目"));
  const table = el("table");
  const head = el("tr");
  for (const h of ["ID", "标签（逗号分隔）", "内容", "启用", ""]) head.appendChild(el("th", null, h));
  table.appendChild(head);

  const addRow = (entry = { id: "", tags: [], content: "", enabled: true }) => {
    const tr = el("tr");
    const idIn = document.createElement("input");
    idIn.value = entry.id;
    const tagsIn = document.createElement("input");
    tagsIn.value = (entry.tags ?? []).join(", ");
    const contentIn = el("textarea");
    contentIn.rows = 2;
    contentIn.value = entry.content ?? "";
    const enabledIn = document.createElement("input");
    enabledIn.type = "checkbox";
    enabledIn.checked = entry.enabled !== false;
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
        id: idIn.value.trim(),
        tags: tagsIn.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        content: contentIn.value,
        enabled: enabledIn.checked,
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
}
