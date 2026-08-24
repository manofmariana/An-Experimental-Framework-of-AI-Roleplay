# ROADMAP（规划）

只记录**未实现**的规划。规划项落地时把内容移入 `DESIGN.md` 并从此处删除对应条目；分期只是优先级，不是承诺。

## P2（逻辑 TAG 组装与提示词组装）

六大块：TAG 系统（选择层）/ 占位符系统（渲染层，全声明式）/ 对象×功能提示词矩阵（两轴封闭）/ 变量系统（树模型 + 末端级过滤）/ 数值规则系统（纯机械自定义动作）/ 状态栏引擎（随变量增删自动变化 + 前端两级逻辑区域隔离）。设计基准：adr/0007–0012。

阶段切割（依赖序；成本量级 S/M/L/XL；每阶段门禁 = `npm run check` 全绿 + 对应套件）：

- **P2-1 TAG 过滤内核（M，无依赖，先行）**——设计已定案，见专节。
- **P2-2 变量树（XL，最大单块，数据基座）**——设计已定案，见专节。
- **P2-3 声明式占位符引擎 + 组装管线接入（L，依赖 1+2）**——设计已定案，见专节。
- **P2-4 对象×功能矩阵 + 输入模式（M，可与 3 并行）**——设计已定案，见专节。
- **P2-5 数值规则/动作（M，依赖 2 的路径 + 3 的工作集条目）**——设计已定案，见专节。
- **P2-6 状态栏引擎 + 前端隔离骨架（M-L，依赖 2+3）**——设计已定案，见专节。
- **P2-7 测试世界包 + 端到端验证（S-M，贯穿全程）**——设计已定案，见专节；包内容由人类主导逐步设计。
- 两个大头 = P2-2 与 P2-3，也是测试适配重灾区（触到 `vars` 扁平表、事件 tags、占位符注册表的现有测试都要改，适配量不小于新代码）；存档版本在 P2-2 升版一次，后续阶段在同一版本内演进。

### P2-1 设计定案：TAG 过滤内核

新模块 `src/tags/`（先登记 CODEINDEX 再写码）：纯逻辑零 IO，走 unit 套件；仿 scheduler 加禁边规则（变量值一律由调用方 scope 注入，否则 compile→tags→truth 传递违规）。

**TAG 注册表**：统一落盘 `world.json` 系统分支 `_sys.tagRegistry`——名称即键；条目 = {name, description?, condition?, category?, system?}，各字段均为外壳末端（name 冗余为末端使名称可被路径调用；condition = 容器，含 path/op/value 三原始值型末端）、tags 恒空（注册表分支恒不挂 TAG，可读性由抓取层控制：只有 GM/程序向占位符路由到此分支）；category = 封闭枚举 {cid, channel, location}，有类别按类别声明登记（实例合法性程序判定；实例值 GM 经变量注入可见，不重复登记）、无类别按名称登记；system 条目 = 程序化只读参考（真实挂载与求值逻辑由代码持有，加载校验与代码常量一致，任何层不得占用同名）；非程序化条目 = 求值真实数据源，GM 运行期增改走裁决包结构化字段、随 changes 落账。GM 经占位符路由一处读全。

**TAG 逻辑代数**：见 adr/0007（等级表达式 T = ∧(∨)；等级 = 内容侧挂载属性，对象侧纯名称集合；虚拟全知按非空等级组注入；无 TAG = 恒通过；matched 开放类别归一化；condition 存续；ID 体系废除）。

**求值契约**：逐末端返回 {status, content, matched}——status = pass/fail 显式枚举；matched = 双侧共同持有记号集（含虚拟挂载；cid/channel/location 命中归一化为类别记号）。对象有效 TAG 集 = 落盘 ∪ 派生（纯名称集合），合并在组装层，求值器只收有效集；condition 求值经注入的 varReader，对全知读者跳过。

出口：等级表达式全组合单测（∧/∨ 组合、空组恒过、虚拟全知按组注入、归一化记号、condition 求值与全知跳过、status/matched 契约）。

### P2-2 设计定案：变量树

**存储分层 + 命名空间统一**：系统字段（timer/location/channel/acted/initiative/group/level）保持 `CharacterState` 顶层 + 白名单专用通道原样；tags 迁入树（从动末端原型）。统一在两层兑现——GM/WebUI 路径语法统一（`world.…` / `characters.{cid}.…`，解析器把系统分支路由到专用字段并拒写，调度语义仍走 durations/location 契约字段）；WebUI 树视图把系统字段投影为只读分支。世界侧程序键（cycles_since_gm 等）归 `_sys`，time 锚保留 setClock 专用通道。

**树模型**：容器（可含子节点）/ 末端（末端类型 = 复合类型且直接属性全原始；唯一末端类型 = `{value, tags, formula?}` 外壳——模板无裸原始属性，`name: string` = 外壳简写，自定义类型实例恒为容器）；无数组节点（有序集合 = 容器 + 数字键）；容器子键 = 人类可读名称。valueType 封闭集 = number / string / boolean / string_list / tag_list（{name, level} 数组原子值，值元素非树节点、不可寻址）。

**变量模板**（世界包 `vars-template.json`，档内副本 `_sys.varsTemplate`）：`{world, character, types}` 三棵声明树；容器声明 `{kind, children, type?}`（type 引用类型名，容器下每个子容器按类型展开），末端声明 `{kind, valueType}`。character 声明树全体角色共享，个体差异在实例侧。结构编辑与实例写值解耦：只加声明不写值 = 合法的预备结构调整；有声明无实例 = 取不到数的定义空行为；无声明有实例 = 校验拒绝。

**TAG 附加文件**（世界包 `vars-tags.json`，档内副本 `_sys.varsTags`，与模板同构）：节点级条目向下级联到每个末端、末端级条目只挂该末端；按模板末端位置解析（不对实例递归）再映射到实例路径；cid 类 TAG 按实例属主分发（每角色仅自身 CID 一个）。

**从动变量**：有 formula = 同步从动（无"异步从动"类别——轮次写入是普通变量的存在形式）。数值公式 = compileFormula（依赖静态解析、拓扑级联、成环在世界包加载/结构编辑时拒绝）；非数值 = 封闭内置算子（P2-2 仅 `union_attach`：显式子树路径列表 + 固有 tags 末端基准，原型 = character.tags）。依赖 = 拿模板路径去选（与占位符选变量内容同一机制），同根、模板可静态解析，实例路径不可指定；跨根与依赖系统字段不开放。级联 = 依赖变更落账时同一提交内重算，结果作为追加 VarChange 记入同段 changes（回溯/重放天然覆盖）；直编从动值无特例——保存后级联自动回归编辑前。

**工程面**：路径引擎合一（`worldStore.applyDeltas` 第二份穿透实现废弃，统一 `varChanges.ts`）；GM deltas 升级显式双根；GM 变量视野 = 占位符自然语言渲染（全知读者）+ 变量模板结构文件（路径知识来源），不再注入原始快照 JSON；SAVE_SCHEMA_VERSION 8→9，旧档拒载；触到 vars 的测试适配（unit/contract/application 清单已盘点）计入本阶段工作量。

出口：装备穿脱级联（union_attach）、直编回归、回溯的 application 层测试全绿。

### P2-3 设计定案：声明式占位符引擎 + 组装管线接入

**存放（档内副本原则扩展到提示词域）**：存档新增第七文件 `prompts.json`（Generation 布局内，lore.json 先例）——会话创建时拷入世界包四份模板（含 gm-incident，顺带补上它不在 AGENT_KINDS 的缺口）+ `prompts/placeholders.json`；装配、校验、运行期 WebUI 编辑全部只动档内副本；世界包 = 出厂基线，"从世界包恢复出厂"为显式操作；无活跃会话时提示词页维持编辑包基线。参与 Generation 原子提交与回溯。动因：变量可运行期魔改，引用新变量的占位符与模板必须随档定义。

**定义 schema**（placeholders.json，单文件全对象共享，通用化）：

- 条目 = {description, source, segments[]}；source = 内容源引用，值域 = 代码投影层清单的封闭枚举（vars/events/lore/working_set/prose/clock/cast/contacts…）。
- 段两类：静态段 `{kind:"static", text}` / 条目段 `{kind:"entry", pass, fail, order?, separator?, merge?}`——pass/fail 各 = {template, branches?}（该侧缺省注入 + "匹配记号集 → 模板"精确匹配分支），order = 前置（默认）/置后。
- 条目段模板写**全路由链路径**（`{character.armor.name}`），遍历结构 = 引擎沿路由链找差异点自动归并（最前差异点规则，编辑期机检），无独立轴声明；遍历序两选项——前置（条目轴独立滚完再进下一条目）/置后（条目轴插到首位轴之后，与同首位轴的置后条目合并为逐实例组；同一占位符内置后条目首位轴必须一致，编辑期机检）。扁平源条目 = 投影层已组装的扁平文本，模板主体 = `{_content}`，伪路径 `{_owner}` 暴露属主 CID。
- 条目状态与分支：放行框的路径调用 = 该条目允许的调用集；放行框全部路径放行 → 放行侧，任一不放行 → 不放行侧；不放行侧框内路径调用照常解析（放行的给值、未放行的给空）。分支键 = 条目匹配记号集（各路径 matched 并集，含归一化类别记号与虚拟挂载，adr/0007）精确匹配，未命中走该侧缺省兜底。
- 渲染后为空 = 模块整条丢弃（沿用，测试已守护）；输出保留 @CID，身份替换 = 组装后处理（GM 事件保持 @ID 原文的现状不动）。

**管线次序**：内容源投影（代码层：事件滑窗/工作集/正文滑窗/lore/变量树路径/派生量——departure_notices、contacts、timers 等纯派生 provider 归位此层）→ TAG 过滤 → 声明式渲染 → 身份替换后处理。

**工作集条目扩展**：条目并集 = 言行条目 | 通知条目。通知条目 = `{author:"system", notice:{type, actor, means?, targets[], …参数}, tags[{name, level}]}`，载荷纯结构化参数、无文本（文案全在占位符模板）；type 封闭枚举随标记/动作种类增长。言行条目 decision 加可见域字段（字段 A/B）+ 条目级 tags（程序自动安插，挂什么 TAG、什么档 = 提示词设计工作，系统侧在标记/动作消费点预留挂载钩子）。工作集条目是临时内容，生命周期随工作集清算（GM 清算即消亡），GM 恒见（强制全知）。

**自动安插两层**：系统性规则代码焊死（发言挂 Aud/Vis、联系挂手段 + 目标 CID——与机制绑定，世界观无权改写）；世界性规则 = 世界包数据（装备 attachtags、环境附加——结构归代码校验，参数归世界作者，incident.json 模式）；世界包不可追加系统级安插。

**远程联系与频道 TAG**：频道变量同时作为 TAG 使用（频道 TAG 名 = 频道编号——角色同一时刻只在一个频道，但同组可并存多个频道各打各的电话；编号仍由频道变量持有，服务生命周期/防重入）。角色有效 TAG 集 = 落盘 ∪ 程序派生（Channel/location 随变量持久安插，工具 AV 程序临时挂载、组装时并入、不常驻变量，防 TAG 池膨胀）。三类在场辨识：异地 / 同地在频道 / 同地不在频道，区分在 location TAG 的值。言行条目可见域字段：字段 A = 挂 (aud/vis, A/V, Channel) → 只对频道内可见；字段 B = 挂 (aud/vis, location) → 只对同地可见；不输出 = 挂 (aud/vis) → 组内全体可见；无频道者经占位符不放行侧分支获得保底渲染（私密性 + 感知完备性）。通讯工具形态 = `{name, methods:{A}|{A,V}, list:{CIDs}}`；频道建立时工具 AV TAG 由程序挂载给发送端同地全体成员（不要求同地人人持有联系方式，只要求邀请者与接收者相互持有）。邀请标记 = 通知条目挂被邀请者 cid 类 TAG，只在被邀请者激活当轮注入，具体方案另行设计。在场性 = 抓取层归属判断（adr/0011），不设在场 TAG。

**迁移**：事件 known_by:CID → cid 类 TAG 挂载（生成/消费两侧代码改写，无存档迁移——版本已在 P2-2 升版，adr/0002 修订为终态）；lore 两消费点接新过滤；现有四份模板迁移为 placeholders.json + 模块引用。

出口：失聪降级、频道三档可见域、标记通知注入的集成测试。

### P2-4 设计定案：对象×功能矩阵 + 输入模式

**矩阵代码形态**（adr/0009）：对象轴 = 代码枚举 {character, gm, prose}（AGENT_KINDS 两处镜像收编一处；新对象 = 新 activation 种类 = 开发行为）；功能轴 = 每对象封闭枚举——character: [decision]，gm: [adjudication, incident]，prose: [render]。映射表 = 单一代码常量（步类型 → 对象×功能组），收编四个 activation 方法里硬编码的模板选择点；模板文件命名 `{object}.{function}.prompt.json`（gm-incident 迁移为 gm.incident）；loadTemplate 校验对照档内 placeholders.json 全表，按对象分注册表的结构拆除。

**输入模式 = 纯提示词层实现**：不新增功能组、不改变玩家直接撰写决策包的行为。主控/上帝/写作指令 = 工作集内容单元，经占位符注入；P2-4 只构筑占位符通道（上帝模式注入占位符可以为空），功能靠模板内容与注入位置调整先行尝试。

**WebUI 两级页面**：一级选对象、二级选功能组（gm-incident 首次可在线编辑）；矩阵结构只读，编辑的只是模板内容。

出口：三指令注入位置的契约测试。

### P2-5 设计定案：数值规则 / 自定义动作

**动作契约**（世界包 `actions.json`；档内副本 = 第八真相文件 `actions.json`，Generation 布局，prompts.json 先例的机械重复——**不进 `world.json` 的 `_sys`**：动作定义不进 GM 视野）：

- 键 = 定义 ID 锚（名称即键纪律）；字段 = {name, description, target: none|character, inputs[], formula, effects[], notice}。
- inputs/effects 路径 = 模板路径选取（与公式依赖同一机制，实例路径不可指定）；`{target}` = 执行期绑定的占位段。
- **formula 表达式串是唯一口径**：骰子 = 公式内 NdM 词法项（DicePort 左到右消费）；加载时预编译 + 变量闭包校验（incident 先例）；WebUI 直编 + 服务端校验回显。图形化编辑器 = 后续纯前端功能更新（编辑自有 AST、序列化回表达式串，不引入 LaTeX/MathML）。
- effects = [{path, op: =|+=|-=, expr?}]（expr 缺省 = $result）；notice = 固定描述模板。
- 无"是否激活角色/GM"勾选——动作纯机械，需要裁决走手动 gm_request。

**执行链**：WS 命令 `perform_action`（contracts/protocol → ws-controller → sessionCoordinator → web/protocol.js 四点机械扩展）→ Coordinator 队列 → 新步 kind：startStep → 校验（相位 + 计次 + 目标合法）→ rollDice 投骰 → 公式求值 → effects VarChange 落账 → 工作集通知条目 → action_used 置位 → finishStep 一次提交。发送即落盘、不经 GM、不消耗回合、不动 acted。

**动作条目**：通知条目 `type:"action"`（author:"system"，参数 = actionId/actor/targets/effects 摘要）；感知 TAG 自动安插；描述由投影层组装扁平文本，占位符渲染注入"当前场景"类别。GM 不见定义/公式/骰点，只见场景层描述（职责零重叠）。

**计次**：角色级系统字段 `action_used`（CHARACTER_VAR_KEYS 扩展，acted 同家族）；提交置位；玩家相位开始维护性清零；非 await_player 相位或已用过即拒。

**WebUI**：动作面板 = 游玩页折叠面板（新组件，web/ 无现成折叠先例）；动作编辑器 = 配置页 CRUD 形态（单表单 + 列表行内编辑），公式直编 + 校验回显。

出口：攻击动作端到端（落盘 + 注入 + GM 转写）。

### P2-6 设计定案：状态栏引擎 + 前端两级隔离

**状态栏引擎**（替换现有 `<pre>` JSON 状态视图）：服务端随 transition/snapshot 附"人类用户状态投影"——逐末端 allowed/denied 标志；全知模式 = 有效 TAG 集挂 {全知， 强制全知}，拟真模式 = 对齐 isPlayer 角色有效 TAG 集（落盘 ∪ 派生），无 isPlayer 角色时拟真置灰。denied 数据照发（模糊条 = 体验机制，不是安全边界）。前端兜底引擎遍历 store 实时变量树：容器 = 多级菜单、无子容器末端 = 卡片，denied = 模糊条（CSS blur + 点击揭示，web/ 无先例、新组件）；变量增删自动反映（遍历实时树，天然成立）。TAG 求值器零移植——前端只消费标志位。与树状变量编辑器（P2-2）读同一份 store。

**可定制区**：档内副本第九文件 `statusbar.json`（世界包出厂模板 → 会话拷入，运行期只动副本）——`{zones:{side, bottom}}`，部件 = {part, bind, condition?, repeat?}，纯 JSON 无脚本能力（第一重隔离 = 结构事实）；前端经新 `/api/` 域端点读取（JSON envelope 先例，不扩 serveStatic）；渲染器属框架区（web/ 代码），模板只能声明 side/bottom 两个**逻辑区域**（非坐标限制——栏内部件可覆盖全页面，全屏特效是栏内组件）。部件库框架内置、全体世界观共享（P2-6 最小集：菜单/卡片/进度条/文本；新部件 = 框架开发行为）。Agent 写路径白名单（第二重隔离）在 P3 落服务端写接口，本阶段只立文件结构骨架。专门模板编辑界面从简，美化定制是 P3 工具 Agent 的空间。CLI 不做任何等价物（WebUI 唯一交互界面）。

出口：变量增删 → 状态栏自动反映；双模式切换测试。

### P2-7 设计定案：测试世界包 + 端到端验证

- **测试包 = 新类 DND 世界观新包**（不动 baitan 做验证包）；包内容由人类主导逐步设计（TAG 挂载方案、变量模板、动作、状态栏模板均为提示词/内容设计工作），AI 不自主生成；系统侧文件形态/装配/校验通道已在 P2-2～P2-6 备齐（`tags.json` / `vars-template.json` / `vars-tags.json` / `actions.json` / `prompts/placeholders.json` / `statusbar.json` + `{object}.{function}.prompt.json` 命名）。
- **baitan 只做机械迁移**（模板改名 + 占位符引用迁移），保住现有测试基线，不做内容扩展。
- 自动化验证走四层套件（各阶段出口）；**真实 LLM 冒烟由人类手动跑**（密钥 + 重启服务 + 新建会话；存档版本不符拒载是设计特性）。

### P2 推迟/未决

- GM 正文滑窗连续判定细粒度：非核心，后续按实际情况调整。
- 邀请系统两段式重构（先记思路，P1 返工成本待定）：拆为"建立会话"（照常触发 GM，确保两组时钟都不抢跑）与"邀请进入会话"（直接激活对应角色，再走接受/拒绝流程）——解决接收端同地成员不应自动获得工具 AV 挂载的问题。

## P3

- **正文输出结构化事件流**（speech/action/state/ui/media），前端纯渲染；限定视角（第一/第二人称）经 known_by 过滤扩展。
- **工具 Agent 完整化**（唯一可称真正 Agent 的角色，具备读写与执行能力，离关键路径）：世界书条目创建/合并（先查重后创建——关键词 + embedding 相似度；类型白名单——地点/物品/次要 NPC 自由创建、主线实体挂起等确认；provenance 溯源标记；每场景新建上限 + 场景外 consolidation）、文风/预设修改、前端配置修改。Lorebook 检索策略分域：lorebook 要准（关键词预筛 + 小模型按 ID 拣选），角色记忆可以糊（embedding 向量检索）。
- **新角色热生成管线**：工具 Agent 生成角色框架 → 工具 Agent 与该角色 agent 数轮相互询问，按年龄分段生成过往经历直到对齐当前时间；公共事件/舆论生成到对应标签的 lorebook 条目（如 `A城：公共`）。创建权限：只有 GM 有权激活创建程序，每次创建必须经玩家确认；严格控制主要角色数量。
- **缓存断点边缘层**：核心输出中性 `[[CACHE_BREAK]]` 式层边界，翻译为 `cache_control` 等模型特定机制（Anthropic 原生 adapter）。
- **降级模式**：单角色小场景 → GM 代演 NPC + GM/正文融合一段式调用，成本逼近 ST 但保留真相层；仅作降级存在，不是架构本体。
- **retcon 工作流深化**：工具 Agent 修改的结构变更与回溯强制绑定。
- **记忆压缩**（P2 移出）：专用压缩模型、每对象独立压缩库（角色各自 + GM 公共）、只追加新条目不改写旧条目、原始事件不删除、RAG 检索兜底（注入时检索相关长期条目而非全量）；压缩激活先手动，自动触发策略待定。
- **角色记忆向量化流水线**（P2 移出）：嵌入服务异步批量向量化 + 注入时按相关性检索（系统侧工序，非角色能力）；记忆整理（Audit 模式）归角色自己。

## P4

- **MCP 工具集**（骰子/生图/TTS）；**ST 资产导入器**（角色卡/世界书/预设，参考 AIRP-MCP-Server 工具集：import_card / apply_lorebook / update_state / seal_volume）；agent manifest 热加载。
- **场景外模式**：Chat（与作者闲聊）/ Audit（记忆整理）/ Diary（第一人称叙事创作）/ IM 接入（共享同一套人设与记忆）；场景结束后 GM 审查归档、润色互动记录为叙事文本。
- **快进模式（timeskip）**：主控长期待机期间 GM 与正文切换第二套提示词——NPC 行为笼统长期化、裁决大步长、叙事编年化；重大事件自动暂停快进回到常速。快进/常速是同一 agent 的模式切换（换模式卡），不是新 agent。

## 悬置的设计问题

- 层间 token 预算分配：待多角色长会话实测调优。
- 记忆压缩的自动触发策略（按轮次/上下文阈值）。
- 快照 JSON → 自然语言渲染器的具体模板。
- 成本埋点看板。
- 多组交替事件对 GM 判断的影响：待实际运行验证。
