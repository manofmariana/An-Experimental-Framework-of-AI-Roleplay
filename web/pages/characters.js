/** 角色页：统一 manifest 字段与结构化 location 编辑。 */
import { api, el } from "../app.js";

export async function renderCharacters(root) {
  root.appendChild(el("h2", null, "角色"));
  const list = await api("/api/characters");
  const picker = el("select");
  for (const item of list) { const option = el("option", null, `${item.manifest.name}（${item.id}）`); option.value = item.id; picker.appendChild(option); }
  root.appendChild(picker);
  const host = el("div"); root.appendChild(host);

  const renderForm = (id) => {
    const source = list.find((item) => item.id === id)?.manifest; host.textContent = ""; if (!source) return;
    const fields = {};
    const add = (key, label, multiline = false) => {
      const wrap = el("label", "field"); wrap.appendChild(el("span", null, label));
      const input = multiline ? el("textarea") : document.createElement("input"); if (!multiline) input.type = "text";
      const value = source[key]; input.value = Array.isArray(value) ? value.join("\n") : String(value ?? "");
      if (multiline) input.rows = 4; if (key === "id") input.disabled = true;
      wrap.appendChild(input); host.appendChild(wrap); fields[key] = input;
    };
    add("id", "ID"); add("name", "名字"); add("gender", "性别"); add("age", "年龄（字符串）"); add("personality", "性格（1-2句）", true);
    add("locationName", "初始地点名"); fields.locationName.value = source.location?.name ?? "";
    add("locationLevel", "地点等级"); fields.locationLevel.value = String(source.location?.level ?? 1);
    add("timer", "初始 timer 偏移（分钟；留空为 null）"); add("reaction", "反应"); add("level", "角色等级");
    add("tags", "固定标签（每行一个）", true); add("initial_memories", "初始记忆（每行一条）", true);
    const save = el("button", "act", "保存"); const status = el("span", "muted");
    save.onclick = async () => {
      const lines = (key) => fields[key].value.split("\n").map((value) => value.trim()).filter(Boolean);
      const manifest = {
        ...source, id, name: fields.name.value.trim(), gender: fields.gender.value.trim(), age: fields.age.value.trim(),
        personality: fields.personality.value.trim(), location: { name: fields.locationName.value.trim(), level: Number(fields.locationLevel.value) || 1 },
        timer: fields.timer.value.trim() === "" ? null : Number(fields.timer.value), reaction: Number(fields.reaction.value) || 0,
        level: Number(fields.level.value) || 1, tags: lines("tags"), initial_memories: lines("initial_memories"), relations: source.relations ?? {}, vars: source.vars ?? {},
      };
      try { const response = await api(`/api/characters/${id}`, "PUT", manifest); status.textContent = ` ${response.note}`; }
      catch (error) { status.textContent = ` 保存失败：${error.message}`; }
    };
    host.append(save, status);
  };
  picker.onchange = () => renderForm(picker.value); if (list.length > 0) renderForm(list[0].id);
}
