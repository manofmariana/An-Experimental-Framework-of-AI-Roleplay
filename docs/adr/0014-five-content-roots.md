# 五根同构：四大内容根 + sys 独立第五根

**决定**：

- **events / lores / characters / world = 四大内容根，全部同构**：末端一律 {value, tags, formula?} 外壳（与变量树末端同一形状），容器级联、路径路由、逐末端 TAG 过滤共用引擎同一套代码；四大根视为广义变量。事件元素 = {id, t, seq, kind, location?, content} 全字段外壳（时间/地点同为可挂 tags 的调取对象；实际往哪些字段挂 tags 归后续 GM 输出契约，本刀只立结构）；lore 条目 = {id, content, enabled?} 全外壳，条目级 tags 取消（挂载全部挪到 content 末端）。
- **_sys 从 world 下移出 = 第五根（sys.json）**：{schema_version, tagRegistry, varsTemplate, varsTags, cycles_since_gm, gm_trigger, gm_trigger_batch, pipeline}。schema_version 单点化——只在 sys.json 盖章，readSaveSet 版本闸只读 sys 一处，其余文件 codec 不再携版本字面量。程序计数键经 `sys.*` VarChange 通道落账（回溯可逆）；pipeline 不落 VarChange（同前例）。
- **time.json 删除**：start 废弃——初始时间 = world 变量树 time 锚（新档 = 代码缺省实例，原点 y0 元旦 00:00）；periods 时段表并入 world.time（变量树内，档内随 world.json）。time 是代码侧 world 系统声明分支（镜像 character 系统分支先例，systemWorld.ts），调度经 WorldStore.setClock 专用通道推进（保留外壳 tags），GM deltas 拒写 world.time。TimeStore 删除；worldTimeToMinutes/minutesToWorldTime/renderTimeHeader 纯函数落 systemWorld.ts；clock 占位符渲染改从 world.time 读锚与时段表。
- **世界包 setting.md / tone-card.md 删除**：静态文本直接内嵌进提示词模板的静态文案；setting/tone_card 两个占位符源删除。
- **占位符 source 二分类**：程序组装类（封闭枚举：working_set/prose_window/last_prose/clock/cast/contacts/departure_notices/incoming_contact/timers/fortune/gm_event/incident_target/world_snapshot/snapshot/group_members/long_term_memory/self_name/self_cid/location）| 本地落盘四根（条目无 source 字段，路径首段即根，模板直接写全路由链路径 {events[*].content}）。{_content}/{_owner} 伪路径弃用——组装源条目改用命名路径 {<source>.content} / {<source>.owner}（每个组装源暴露 content/owner 两个固定可调用末端）。
- **事件/lore 过滤从 Store/投影收进引擎**：投影层全量供给（仅两处取数范围截取——prose 读者的事件滑窗、prose 读者的 lores 参与者触发集），引擎路由逐末端过 evaluateTagFilter。EventsStore.readVisibleTo 与 simulator.visibleEvents 删除，Store 只留存储语义。events 根 string 末端经引擎过 renderIdentity（cid 模式）身份替换后处理（GM 该模式 = @ID 原文；事件注入文本写入时定型的口径不变）。
- **VarChanges 机制保持现状**：events append/truncate、lore changelog 专口不动。

**为什么**：

- 此前事件/lore 是"特殊内容"：扁平条目 + 伪路径 + Store/投影双侧各带一份过滤求值（readVisibleTo、visibleEvents、Lorebook.getByTags 三处重复口径），与 vars 末端过滤引擎割裂。四根同构后，TAG 安插、占位符调取、过滤逻辑只有一套实现（引擎逐末端求值），过滤语义只剩"读者有效 TAG 集 × 外壳 tags"一个口径。
- _sys 混在 world 变量树里让"作者内容"与"程序分支"纠缠（直编要豁免、编辑器要滤键、模板要剔除）；独立第五根后 world.json 是纯变量树，sys.json 是程序自留地，schema_version 单点盖章顺带消掉逐文件 literal 比对的混合版本误判面。
- time.json 是四根之外唯一的"散养配置"：start 与 world.time 锚语义重复（双出处），periods 是事实上的世界变量。并入 world.time 后时间全部回归变量树，世界作者可调、档内随 world.json、回溯随 VarChange。
- setting/tone-card 是"只有一个消费点的静态文本"，专为它们维持两个占位符源 + 两个包文件 + 两个编辑器不成比例；内嵌进模板静态文案后，提示词的全部内容只在一个地方（模板 + 占位符目录）。

**代价**：

- 世界包失去自定义初始时间锚与时段表的通道（time.json 删除的必然代价）：新档一律从代码缺省（原点 + 白天/夜晚两段）开局，调整走档内状态直编。baitan 示例包的原自定义时段表（拂晓/清晨/…）随之消失。
- 存档不兼容（14 → 15）：旧档拒载不迁移（一贯口径）；旧布局 Generation 缺 sys.json 按 version 拒绝。
- 角色读者事件可见性少了 `t <= 当前时钟` 一项（Store 侧过滤删除后只按 TAG 求值）——正常流程不存在未来事件（commit 时 t = 当前 clock，回溯按 seq 截断），仅状态直编注入的未来 t 事件不再被时间项过滤。
- GM 的 lore 注入不再罗列各条目标签清单（原 GM 全量视图带 `（标签：…）`）；需要时可在模板里经 {lores[*].content.tags} 自取（stringify 只出名称不出等级）。
- 直编 sys 结构通道的 HTTP 契约变化：PUT /api/session/state 的 sys 键原样并入直编载荷（不再由路由层拼进 world），sys 与 world 从互斥变为两个可同携的独立域。
- 落盘根渲染的拼接语义微调：空渲染实例（无实例/不放行侧缺省空模板）在轴拼接处整条丢弃——与组装源空条目丢弃同口径，原先会留下空行。
