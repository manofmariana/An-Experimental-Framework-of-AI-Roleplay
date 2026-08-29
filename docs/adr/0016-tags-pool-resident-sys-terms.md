# tags 池常驻系统字段 + union terms 组合公式

**决定**：角色有效 TAG 池（`characters.{cid}.vars.tags` 从动末端）把属主角色的三个系统字段常驻化——自身 cid、当前地点名、当前频道号（无频道 = 空集）——经从动公式组合实现，不再由过滤层读时注入。公式载体 = `union` 算子的 terms 组合形态：`{op: "union", terms: [...]}`，term 两类——`{attach: paths[]}`（自身 attachtags ∪ 各子树路径下全部 attachtags 末端值，paths 须解析到容器/数组声明）与 `{sys: "cid"|"location"|"channel"}`（读属主系统字段；只允许出现在 character 根，terms 内不得重复）；求值 = 按 terms 顺序并集、按名去重（先取者胜）。sys 项不产生依赖图边（系统字段不是从动末端）：`CharactersStore.setVars`（系统字段白名单写通道）在 location/channel 变更后重算该角色池，值变才追加池的 VarChange（回溯随批覆盖）；存档安全网（validateSaveSet）每次提交按档内模板重算全部角色池并与存值比对，把未来漏挂的写路径变成当场 invariant 报错。旧 `{op: "union_attach", paths}` 形态整体替换、不保留兼容解析（存档版本 17→18）。A/V 工具挂载与全知权重保持读时派生，不入池。

**为什么**：常驻化让角色有效 TAG 集在 WebUI 状态编辑器/存档里直接可读（可视化是动机），且程序消费路径单一化（过滤层只读池，不再拼接三处来源，语义只在一处定义）。terms 组合形态而非把系统字段焊死进单算子：池的构成对世界作者可见可编（attach 子树与系统项都在模板里显式列出）、可扩展（未来加系统项 = 加枚举值），且与用户草图同构。

**代价**：`setVars` 需要持有档内 character 模板（构造/工厂注入，cloneTruth 透传）并多一个池重算挂钩；saveSet 安全网每次提交全量重算全部角色池（池小、角色少，可承受）——两处都是常驻化的长期维护负担。池快照含系统字段名（存档噪声略增，注入 token 同量——过滤层本就注入这些名字）。
