/** 世界页：setting / tone-card 编辑器 + lorebook 条目表格（增删改、enabled 开关）。 */
import { api, el } from "../app.js";

export async function renderWorld(root) {
  root.appendChild(el("h2", null, "世界"));
  const data = await api("/api/world");

  // ---- 两个 Markdown 编辑器 ----
  const editors = [
    ["setting", "世界设定（GM 的 L1）", data.setting],
    ["tone-card", "世界基调卡（正文的 L1）", data.toneCard],
  ];
  for (const [name, label, content] of editors) {
    root.appendChild(el("h3", null, label));
    const ta = el("textarea");
    ta.rows = 10;
    ta.value = content;
    const save = el("button", "act", "保存");
    const status = el("span", "muted");
    save.onclick = async () => {
      status.textContent = "";
      try {
        const resp = await api(`/api/world/${name}`, "PUT", { content: ta.value });
        status.textContent = ` ${resp.note}`;
      } catch (err) {
        status.textContent = ` 保存失败：${err.message}`;
      }
    };
    root.append(ta, el("div"), save, status);
  }

  // ---- lorebook 表格 ----
  root.appendChild(el("h3", null, "Lorebook 条目"));
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
  root.appendChild(table);

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
      const resp = await api("/api/world/lorebook", "PUT", entries);
      status.textContent = ` ${resp.note}`;
    } catch (err) {
      status.textContent = ` 保存失败：${err.message}`;
    }
  };
  root.append(el("div"), addBtn, saveBtn, status);
}
