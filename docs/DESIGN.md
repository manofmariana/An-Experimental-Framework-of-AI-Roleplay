# Ofair 设计文档

> 本文档是架构基准，只记录**当前已实现**的设计。未来规划见 `ROADMAP.md`；术语定义与冲突消解以 `CONTEXT.md` 为准；难逆取舍的理由见 `adr/`；逐文件职责见 `CODEINDEX.md`。
> 定位：用多 Agent 架构取代 SillyTavern 式单上下文结构，实现更好的上下文管理、缓存命中率、多角色认知隔离与即时功能拓展。

---

## 1. 设计哲学

### 1.1 SillyTavern 式结构的病灶

ST 的本质是**单上下文、单人格、全知视角的文本拼接器**：

1. 单体 prompt 组装：角色卡 + 世界书 + 全部历史每轮拼成一个大字符串，一个模型精分所有角色。
2. 缓存杀手：世界书按深度插入、历史尾部增长，前缀缓存每轮被击穿。
3. 无认知隔离：模型天然全知，秘密/谎言/悬疑/戏剧反讽在结构层面不支持。
4. 无状态真相源：聊天文本即真相，改一条历史全靠手动，无一致性校验。
5. 扩展是前端 JS 补丁：前后端强耦合，新能力开发成本高。

### 1.2 本架构的四条哲学

1. **作者退后，角色自治**：角色是独立的人，不知道自己在作品里。主要角色的台词、决策、记忆由角色自己的 agent 全权负责，任何其他 agent（包括 GM）不得替角色行动、感受、思考。
2. **真相层与视图分离**：结构化事件日志 + 变量库 + 知识账本是唯一真相；正文、角色感知、前端画面都只是真相的渲染视图。视图永远不许反向污染真相。
3. **需要判断的才配当 agent，纯工序做成确定性服务**：变量落库、感知投递、计时器、骰子——零 LLM。LLM 调用只花在判断和创作上。
4. **通用优先于特供**：核心保持后端无关，模型特定的优化下沉到边缘层。

---

## 2. 总体架构

```
                        玩家输入（主控意图）
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
  角色 Activation ×N     （次要NPC由GM代演）      主控=玩家本人
  自主决策：台词/行动/         │
  内心/人际关系维护            │
        │  决策包（结构化）    │
        └──────────┬──────────┘
                   ▼
        ┌──────────────────────┐      机械层（零LLM）：
        │  GM Activation       │      调度派生、计时器、
        │  重裁决/世界反应      │      感知过滤、变量落库、
        │  @ID 转写/事件可见性  │      标记执行、组划分
        └──────────┬───────────┘
                   │ 裁决包（events + deltas +
                   │  durations/location + narrativity）
                   ├──────────────► 事件日志（真相层，append-only）
                   │                        │
                   ▼                        ▼
        ┌──────────────────┐     ┌─────────────────┐
        │ 正文 Activation   │     │ 变量应用（确定性） │
        │ 纯渲染器，无工具   │     │                  │
        │ 无权改写角色台词   │     │                  │
        └────────┬─────────┘     └─────────────────┘
                 │ 正文文本
                 ▼
        瘦前端（纯渲染器；CLI + WebUI 双实现）
```

注：角色/GM/正文"agent"是效果与理解上的逻辑概念——底层是**无状态 activation**：每次激活 = 从数据层组装提示词的全新请求，无对话历史、无跨调用缓存、无工具调用能力。

---

## 3. 各 Agent 职责

### 3.1 角色 activation（×N，主要角色）

- **独立私域上下文**：只含该角色能感知的信息。认知隔离由结构保证，不靠"请假装不知道"。
- **无状态**：每次激活 = 从数据层（事件集/角色变量/工作集/正文滑窗）组装提示词的独立请求，连续性靠注入而非对话历史；单一 CharacterActivation 实例服务全部 NPC。
- **唤醒制**（非轮次制）：角色携带 `timer` 变量（**到期时刻**，绝对分钟标量），到期即被调度器弹出；组是程序从角色变量派生的状态。沉睡角色零开销。
- **决策包契约**：`inner` 必填（内心活动与意图）；`action` 与 `dialogue` 至少其一；关系实际变化时追加 `relations`；调度指令追加 `markers`（五标记结构化数组，见 §4.4）；`visibility` 声明可见域（A = 只对同频道 / B = 只对同地，缺省 = 组内全体；条目级 TAG 挂载由程序按焊死映射派生，见 §6.1）。角色不得输出 span——`Span`（**时长**，相对量）仅属于 GM 裁决包的 `durations` 字段。
- **记忆 = 视角化渲染**：角色的记忆是可见事件记录经身份替换的第一人称渲染（自己→我/真名/印象称谓）；人际关系（名字/印象）由角色全权自维护，GM 不参与。
- **isPlayer 变量**：标记该角色当前由玩家操控（缺省 C0）；`await_player` 按 isPlayer 判定而非硬编码 CID——为切换扮演对象、多人操控预留。

### 3.2 GM activation

- 唯一全知者，但**克制**：不替主要角色行动/感受/思考（红线）。引导剧情靠环境旁白吸引注意力，靠 NPC 和世界反应推进。
- 职责：重裁决、次要 NPC 代演、世界反应、为每个行动者给出**时长**（`durations` 的 span，相对量；程序锚定当前世界时钟折算为到期时刻）、设置 location、逐事件挂可见性 TAG（内容侧 `{name, level}` 挂载，常规 = cid 类一级，adr/0002）、**narrativity**（包级，进入正文的权重）。
- **裁决包契约**（唯一输出形式，先写事件、后定 durations/location）：

```json
{
  "events": [{"text": "@C1002 的剑刺中 @C1003 左肩，@C1003 后退撞翻烛台",
              "tags": [{"name": "C1002", "level": 1}, {"name": "C1003", "level": 1}],
              "location": "灯塔顶层"}],
  "narrativity": "full",
  "deltas": [{"path": "world.region.harbor.fog", "op": "=", "value": true}],
  "durations": [{"cid": "C1002", "span": {"min": 30}}],
  "location": [{"cid": "C1003", "location": "灯塔顶层"}]
}
```

- **事件数 = GM 计划的新组划分**：普通周期 = 1 个；组分裂/重组时各新组各一个事件。
- **时长纪律**：span 必非 0；普通周期中 durations 的 CID 集合与本轮行动者精确一致且不重复；中途激活（标记触发）时 durations 必须精确覆盖**全体同步组成员 + 刚从同步组离开的成员**（程序强校验，缺少/越界/重复即拒绝重试——覆盖未行动者是周期补完的前提，见 §4.3）。GM 裁决后存在无到期时刻的角色 → 警告日志。
- **事件 tags 校验**：等级范围由 schema 机检（1-7）；名称对档内注册表类别化口径（注册名 ∪ cid 现存实例 ∪ channel/location 声明，与变量写值同一口径），不合法走解析失败拒绝重试通道；**空数组 = 程序补全本轮全部行动者的 cid 类 TAG 一级**（唯一写入点 = GM 裁决规划器）。
- **事件写作纪律**（提示词协议层约束，不做程序强校验）：**摘要制**——不完整转述台词，做摘要与意义总结；禁人称代词（演员表角色一律 @CID）；保言行顺序、只记已发生；多条目记录事实而非视角、条目间禁止重合；谁实际感知就为谁挂 cid 类 TAG；提示词模板示例禁用真实 CID（用 `<CID_甲>` 抽象占位）。
- **每次激活前的固定判定**：良恶/程度（机械投骰、fortune 占位符注入；常规 GM 用被裁决组的错位度 D，公式见 §4.8）。
- **突发变体**：同一身份的第二种提示词组 `gm-incident` + slim 契约（事件文本 + 可选 deltas，独立轻校验）——突发事件机制见 §4.8。

### 3.3 正文 activation（纯渲染器）

- **无工具、无检索权**。世界知识 = 静态世界基调卡 + 世界设定 + 触发 lore（本轮参与者有效 TAG 集并集按 TAG 求值激活的条目，去重按 ID 排序）。
- 注入顺序：协议（含基调卡）→ 世界设定 → 近期事件（演员表渲染）→ 演员表（CID 与名字）→ 触发 lore → 上一轮正文（行文衔接）→ 本轮各角色台词+内心（inner 含意图，作情绪参考；标记不注入）→ 本轮 GM 事件包。正文不注入 GM 公共长期记忆；台词原文所有权在角色 agent，**无权改写**。
- 渲染范围 = GM 包全部事件（一次 GM 包至多一次正文调用，narrativity 包级，skip 则无正文；多组交替 = 蒙太奇叙事，不做玩家视角过滤）。
- **指称占位符**：正文存带 `[[称呼|@CID]]` 的原文（直接引语豁免），渲染看读者——玩家显示渲称呼、角色注入按 relations 渲染、GM 注入渲"称呼（@CID）"、正文 agent 自身的上一轮正文保持原文（格式学习通道）。与事件的 @CID 存储 + 身份替换同一"存储用 CID、渲染看读者"体系（adr/0003）。
- **防出戏**：① 世界基调卡（元设定，静态进前缀，挡 gross 级出戏）；② 触发 lore 条目（挡场景级出戏；秘密条目访问控制 = 标签，不持有对应标签即结构上不进正文）。
- **防添油加醋**：① 硬约束块（必须且只能覆盖本轮 GM 事件）；② 标签隔离；③ 信道分离——台词与关键动作所有权在角色 agent，正文只写结缔组织（最强的一道，结构性保证）。

### 3.4 变量体系

- **变量应用 = 确定性代码**：GM 输出的 deltas 直接落库，零 LLM、可审计、可回滚——全部变量变更带 `{path, before, after}` 记录。**GM 不允许直编变量**：修改变量统一经约定语法输出、由程序解析为 deltas 落盘（具体语法归 GM 输出契约阶段定案）。
- **变量树存储**：全部变量存为变量树（容器/结构化数组/末端三类节点，末端 = `{value, tags, formula?}` 外壳；树内身份由变量模板声明）。`world.json` 的 world 分支 = `{time, _sys, ...世界变量树}`——`_sys` 是程序分支（模板校验豁免）：档内 TAG 注册表/变量模板/TAG 附加文件三副本 + 程序计数键（cycles_since_gm/gm_trigger 等）；角色 `vars` 同理为变量树；角色顶层字段（name 等与调度字段 acted/group/channel/timer/isPlayer/appearance）物理布局不变（调度器继续消费类型化字段、白名单专用通道），经**系统声明分支投影**呈现为同一棵树的标准末端——系统声明子树为代码持有常量（不进世界包模板文件），模板解析时并入 character 根（与世界作者声明同名 = 拒装），投影值从类型化字段读出（timer/channel null 原样、initiative null = 容器无实例、relations 数组按下标投影）；所有末端（含系统字段）可挂内容侧 tags，系统末端的外壳 tags 存 CharacterState 的 `systemTags` 侧车（只经直编修改，装配/直编时校验 level 1-7 + 注册名集合；GM deltas 拒写系统分支）。tags 只存在于末端外壳——数组节点与数组元素对象自身没有挂载位。
- **双根 deltas 写入**：deltas 的 path 必须 `world.…` 或 `characters.{cid}.…` 开头（角色域只可写 vars 作者子树——vars 下首段命中系统声明分支键即拒，系统字段走白名单专用通道），统一经 varWrite 编排：模板可解析校验（无声明拒绝该条）、valueType/注册名校验（attachtags 纯名集合与 tag_list 挂载表各走各的写值校验）、从动末端拒写（带 formula，由程序维护）。路径支持数组下标语法 `键[数字]`（精确下标，如 `characters.C1001.vars.items[0].name`）；`[*]` 通配只用于从动/附加解析，写路径一律拒。
- **变量模板与 TAG 附加**：变量模板（世界包 `vars-template.json`，档内副本 `_sys.varsTemplate`）= `{world, character, types}` 三棵声明树——容器（`{children}`；子键 = 人类可读名称，禁保留子键 value/tags/formula 与下标括号）/ 结构化数组（`{array: 元素声明}`，元素 = `{type}` 引用 types 结构别名或 `{children}` 内联对象结构；元素根不得又是数组；实例 = 元素对象数组，实例键废弃）/ 末端（`{valueType, formula?}` 或 valueType 字符串简写；valueType = number/string/boolean/string_list/tag_list）；types = 纯结构别名注册表（每类型只能 `{children}`，引用必须可解析且无环，直接与间接递归都拒）。结构编辑与实例写值解耦（只加声明不写值合法；无声明有实例 = 校验拒绝）；character 声明树全体角色共享，根保留名 `attachtags`（固有 TAG 末端 = string_list 纯名集合，GM 挂 TAG 的直写点）+ `tags`（union_attach 从动池 = string_list）。TAG 附加文件（世界包 `vars-tags.json`，档内副本 `_sys.varsTags`）与模板同构：节点 = `{tags?, children?}` 或 `{tags?, array}`（数组整型挂载，array = 元素类型名、内联元素为 `"*"`）；节点级条目扇出到其下全部末端（根节点自身也可挂条目 = 级联到该根全部末端；数组层路径以 `[*]` 占位）、末端级条目只挂该末端，按模板末端位置解析映射实例路径，cid 类条目按实例属主分发（character 根挂 {category:"cid"} = 每角色全部末端挂自身 CID）；附加 TAG 读取期与实例 tags 合并、不物化进实例值（消费在提示词组装层）；状态编辑器把合并结果以只读「附加」chips 并入各末端 chips 区显示（前端镜像 resolveAttachTags：扇出/单挂/`[*]` 按下标通配匹配/cid 按当前 scope 角色分发，world 域无属主遇 cid 条目跳过；只作显示，绝不写进实例值/保存载荷/侧车）。
- **从动级联**：任一变量根（world 域或某角色）写落后，按该根依赖图拓扑序整根全量重算全部从动末端（expr 数值公式 + `union_attach` 内置算子；从动集合小，不做细粒度失效分析），值变则写回并把该末端的 VarChange 追加到同段 changes（回溯/重放天然覆盖）。计划 = 模板声明 formula ∪ 实例携带 formula（实例覆盖同路径模板声明）；结构化数组在计划中按 `*` 通配段展开、重算时对实例根做元素下标枚举（characters 根等 cid 键控记录仍枚举键——两种通配语义按实例形状分派）；数组元素结构内的 formula 以元素结构根为基准声明，并入计划时按挂载路径补齐前缀；expr 依赖末端无实例（取不到值）时该末端跳过重算（保持现值）。依赖成环 = 拒装/拒写（装配/续档/直编共用 `_sys` 严格解析出口，成环闸随解析做一次）。直编替换后两域全量级联——被直编的从动值回归计算值，级联结果并入同一次 commit。程序消费角色 TAG 集只读 `vars.tags` 池（string[] 纯名集合；union_attach 从动末端，走同一级联，无特判路径）。
- 角色自有数据（relations/长期记忆）由角色决策包驱动，经同一确定性通道落账；relations = `{cid, name?, impression?}[]` 数组（消费侧按元素 cid 字段扫描匹配，无实例键）。

### 3.5 TAG 系统（选择层）

- **TAG = 内容可见性的判定通货**：内容侧挂载 `{name, level}`（level ∈ 1-7；同级 = 或、跨级 = 与），判定式 T =（一级组 ∨）∧ … ∧（七级组 ∨），空组无约束，无 TAG = 恒通过（adr/0007）。对象侧 = 纯名称集合，无等级。
- **注册表**：世界包 `tags.json`，档内副本 `_sys.tagRegistry`；名称即键，条目 `{name, description?, condition?, category?, system?}`；category = 封闭枚举 {cid, channel, location}（有类别按类别登记，实例合法性程序判定、实例值不登记）；system 条目 = 程序化只读参考，加载校验与代码常量（aud/vis/A/V/fappear/全知/强制全知 + cid/channel/location 三类别同名条目）双向一致——三个开放类别各有一条同名 system 类别条目（system + category 同现），缺一条即拒装；非 system 条目 = 求值真实数据源。
- **写值校验类别化**：三条 TAG 写通道（末端外壳 tags / attachtags 纯名集合 / 系统末端 tags 侧车；GM deltas 与直编同口径）名称合法 = 注册表条目名 ∪（cid 类别已声明 ∧ 名 ∈ 现存角色 CID 集合，实例集由调用方注入）∪（channel/location 已声明即放行——实例集运行期派生，不做写时校验）；CID 形态名（C+数字）按 cid 类别判定，未知 CID 拒绝（防手误）。
- **求值契约**（`evaluateTagFilter`，纯逻辑零 IO）：逐末端返回 `{status: pass/fail, content, matched}`——matched = 双侧共同持有记号集（扁平交集去重，含虚拟挂载；cid/channel/location 命中归一化为类别记号）。对象有效 TAG 集（角色 = `vars.tags` 池 name 集 ∪ 程序派生）由调用方注入；**全知 = 全知权重**（角色系统字段 `omniscience`，0-6，唯一语义来源——权重 N 虚拟覆盖 ≤N 级非空组）+ **强制全知**（只覆盖七级组、仅 GM 持有；GM/正文 = 权重 6 + 持强制全知）；全知打破 = 内容挂 N+1 级 TAG。condition（注册表可选比对内容）经注入 varReader 按读者变量树求真，fail-closed，被虚拟挂载覆盖的组跳过求值。
- **GM 挂 TAG = 普通变量写**：deltas 直写 `characters.{cid}.vars.attachtags`（string_list 纯名数组全量替换；注册表名称校验，非法拒绝该条）；tags 池由 union_attach 级联自动维护（§3.4）。
- **三源过滤已接入**：事件（内容侧 {name, level} 挂载，cid 类为主，空数组程序补全本轮行动者 cid 一级，adr/0002）/ lore（逐条目求值，无挂载 = 广播恒过）/ vars（末端级过滤 + 在场性 fappear 虚拟挂载）——求值器、注册表、名称校验同一口径；管线接线见 §7.1。

---

## 4. 时间与调度：连续时间轴 DES

### 4.1 时钟与计时器

- **连续时间**（硬性要求，不做时间量子化）。世界时间落盘唯一表示为 `world.time={y,m,d,h,min}`；逻辑 clock 以 y=365d、m=30d 派生绝对分钟；最小单元 1 分钟。自然语言时间头（"第N日·时段"）经世界包 `time.json` 时段映射表机械渲染，LLM 不自由生成。
- **timer 是角色变量**（到期时刻，绝对分钟标量），只能由 GM 裁决派生：GM 输出时长 span，程序锚定当前世界时钟折算 `timer = clock + toMinutes(span)`，钳制 span ≥ 0（`{min:0}` = 立即到期）。角色决策不含 span。**行动耗时概念不存在**——时长是唯一时间跨度设置单元（adr/0001）。
- **调度 = 投影**：扫描全体角色 timer 取最近到期者激活，时钟跳转到该到期时刻——时间轴无独立存储；组、行动顺序、游标、phase 全部从角色变量 + archive seq 序列派生，回溯零特例。
- **时钟模型**：时钟只在弹出最近 timer 时跳转——组运行期间（无论多少行动周期）时钟冻结在当前到期时刻，无"对话期间世界暂停"特例。

### 4.2 同步组（派生状态）

**组不是实体、不持有任何变量——它是程序从角色变量派生的状态。**

- **Group 变量 = {组编号， 组位置}**：`组编号=0` = 单人组（恒有值），`[1,n)` = 多人组编号；**组位置总绑定先攻最高者的 CID**（= 其 location；领头者变更则重绑，同值取最小 CID）。
- **成组 = timer 一致 + location 一致（自动）**；邀请可跨地点并入（§4.5）。**GM 不设组，只设各角色的 location/timer**——组划分表面自动、实际由 GM 决定（划分判据都是 GM 写的）。
- **入组劣后**：角色入组时自身位置 ≠ 组位置 → 先攻 -1（远程参与的代价）。
- **单活跃组不变量**：任意时刻只有一个组在前台行动（DES 串行弹出）；同一到期时刻弹出多组 → 逐组串行（按组内最高先攻值降序，同值比该成员 CID 升序），每组跑至 GM 结算为止（GM 给出的时长必非 0，成员推入未来后本组自然让位）。后台判定纯按 timer——前台组成员结构上不可被联系。
- **组 id 指派并保稳**：成员集精确匹配 → 保留原 id；纯增员/纯减员 → 继承原 id（分裂取最大子集，并列取最小 CID）；合组 = 人少并入人多。不由 hash(location+timer) 派生——连续轮每圈重设 timer 都会换 id，连续场景判定即垮。
- `location` 是结构化变量 `{name, level}`：name 是 GM 裁决时赋予的自由文本（以世界包为参考、提示词管理），同地判定按 name；level 供突发事件错位度 D 使用（§4.8）。
- 感知隔离按同步组执行：密室私谈、分头行动在结构上成立；跨地点私密性归未来的顶层 TAG 过滤（ROADMAP）。

### 4.3 行动周期与先攻

- **行动周期** = 连续场景内所有成员各行动一次，纯回合制；后行动者经 #当前场景 注入先行动者言行。
- **先攻（initiative）= d20 + reaction**：代码侧确定性投掷，**总值同值即"同时"**——同值者同批激活、互不注入（同时性的迷雾）；意图冲突由 GM 对抗检定叙述。结果写入角色变量，结构为 **{先攻值， 组编号}**——组编号变化即重置（归 0 除外：保留旧值供召回复用）；入组时组编号对上 → 复用，否则单独补投插入既有顺序（补投不波及全组）。reaction 是可成长变量，开场全员同值。
- **行动顺序表**：顺序 = 派生（initiative 变量现排，只有前台组用）；**已行动位 = 角色 acted 变量**（快照落盘、随 changes 落账可回溯）；**周期计数 X = 世界变量**（完成 +1、GM 激活清零、达 N 周期末强制 GM）。acted 变化有且仅有四种：行动后 → 已行动；全组已行动 → 全员重置、X+1；组结算进后台 → 全员重置、X 归 0；组减员至单人 → 幸存者重置、X 归 0（新独奏节奏起点）。
- **周期补完**：前台组不变 ⇒ 已行动状态不变、未行动者继续直至全员行动完（中途 GM 不动已行动位，无特例）；人少并入人多的组变动发生在补完之后。

### 4.4 无判定轮与标记

**无判定是周期的默认形态，GM 激活是例外。** 一个行动周期内无人立 GM 请求标记，整个周期即无判定——角色照常输出台词与行为（二者有其一即可），GM 不激活。

- **GM 激活两种触发**：
  1. **标记触发**——周期内有人立 GM 请求标记（或联系标记，见 §4.5）→ **立即激活**（不等周期末——判定不能等，否则其他角色会基于未裁决状态继续行动；但**同先攻批必须全员行动完才激活**，批内同时性不被裁决撕裂）；
  2. **硬保险**——距上次 GM 激活满 N 个行动周期（N = `settings.json` 的 `gmIntervalCycles`，设置页可编辑）→ 周期末激活；**前台仅 1 人时阈值恒为 1**（单人连续行动不成立，每动必结算）。玩家输入计入周期计数。
- **标记（Marker）**：DecisionPackage 的可选 `markers` 数组，每条 `{type, ...params}`——`gm_request` / `leave`（二者互斥）/ `recall{target}` / `contact{channel, targets[]}` / `confirm`。程序只读结构化字段、不做行内文本解析。标记本身即抛、不直入工作集——解析后只有即时程序作用；**注入镜像 = 程序在消费点生成的系统通知条目**（gm_request/leave/recall/contact；confirm 是应答本身不生成），随工作集清算消亡（条目结构/挂载见 §6.1，取舍见 adr/0013）。
- **离开标记**：离场**不触发 GM**——程序当场将其组编号归 0、timer 置 null（无计时器，调度不再弹出；所有角色含玩家统一程序化）；结算（离场事件、新时长）推迟到下一次 GM 激活。离场者的过去言行继续注入原组直到 GM 清算；后续角色经 `{{departure_notices}}` 占位符获知离场与召回方式。提示词层约束独处时不立此标记——全员离场意味着全员无计时器，调度死锁停等。
- **召回标记**：把已离开且未结算者拉回——timer 归当前时钟（= 组原到期时刻）、按进组规则归组，**先攻不变、发言顺序保持**。跨周期有效（离开 → GM 结算前均为"未结算"）。
- **软保险**（防无判定轮无止境）：提示词层的退出期望管理。

### 4.5 邀请与频道

- 由**联系标记**发起（途径字段：电话/视频/远程开门…… + 对象列表）。**目标至少含一个异组角色**（异组 = location 不同，或 location 相同但 timer > 0）；目标只能是**后台角色**（前台组成员结构上不可被联系）。**同组目标默认同意**、无需应答激活，单纯赋予频道变量；异组目标按常规顺序应答。
- **延迟生效**（防时钟抢跑）：联系标记**触发 GM 立即结算**（标记本身不进任何注入；其通知条目进工作集、GM 恒见），邀请在**邀请者所在组下一次回到前台时**才激活异组受邀者（timer 置当前时钟、立即到期弹出应答）；若其他组 timer 更早，他们先行动。
- **拒绝**（输出理由、不立确认标记）→ timer **自动还原**为被邀请前的值，不调用 GM，失去频道变量。**接受**（确认标记 + 首轮回复）→ timer 归当前时钟（立即到期）直到 GM 重设，并入发起者所在组（位置 ≠ 组位置 → 先攻 -1），**首轮回复计入本周期已行动**。
- **频道变量（channel）**：联系标记生效即分配给邀请者与全部对象（同一 id）；拒绝者失去；退组自动清除。职责三合一：**防重入**（频道持有者不进任何联系人列表注入，持有者自身也看不到名单——占位符整体置空）+ **生命周期**（任意两个持有者 location 不同 → 跨场景存在；全同地 → 全清，仍非组位置的持有者离场等结算）+ **频道 TAG**（编号 = channel 开放类别实例，字段 A 言行条目挂 `频道@2` 只对同频道可见；手段 TAG A/V 由程序临时挂载给频道持有者及其同地成员——组装时并入、不常驻变量）。
- **回归原组不需要专门机制**：远程成员 location 未变，GM 依其行为（如挂断电话）把 timer 对齐回原组到期时刻，同地同时自动成组即回归（组 id 保稳延续原组身份）。

### 4.6 防时间脱同步

1. **交互强制对齐**：A 对 B 说话的那一刻，B 的时钟快进到交互时刻。时间偏斜只允许存在于互不感知的区间——而互不感知时偏斜本不可观测，无害。
2. **事件即同步点**：广域可感知事件落地时，感知半径内所有角色被同时唤醒——同步由事件天然完成，无需任何宣告。
3. **感知过滤**：唤醒时从事件日志取 `time ≤ 唤醒时刻 ∧ TAG 过滤放行` 的事件（读者有效 TAG 集 = 落盘池 ∪ 自身 cid，adr/0002）；绝对时间只在真相层，提示词中的时间/地点经占位符注入。

### 4.7 玩家同构

- **主控是时间轴上的一等实体**：与其他角色变量结构完全一致，行动同样由 GM 订立 timer；绝大多数玩家行动是瞬时的，世界体验上"等玩家"。
- **玩家输入格式与 NPC 输出统一**：输入框三块（台词/行动/内心（含意图））+ 标记按钮 + relations 记录按钮，前端组装为与 NPC 同构的 DecisionPackage；流区卡片与 NPC 决策卡片同构渲染；玩家轮与 NPC 轮同样可编辑（编辑对象 = 组装的决策包 JSON）。
- **暂停选项**：自动继续 / 每轮暂停 / GM 前暂停 / GM 后暂停 / 正文后暂停——前两项各自与其他互斥，后三项自由组合；服务端按会话持有，前端 localStorage 持久化。

### 4.8 突发事件（Incident）

**目的 = 激活长期休眠的组**——让角色不长期待在与自身 level 数量级错位过大的位置。

- **命中评估** = 每次常规 GM 步结束后的标准动作（narrativity≠skip 召唤正文时等正文步结束后），incident 步后不评估：对全体 timer 在未来的组（单人组同算；本次裁决 durations 覆盖的组整组跳过）按组算单次命中概率，多组命中只激活 p 最高者。
- **公式**（结构参考如下；**公式结构与参数唯一出处均为世界包 `incident.json`**，逐世界观可调——求值器 = `src/shared/formula.ts`，各公式可用变量面 = `src/scheduler/incident.ts` 文件头契约。D 双算法已实现：log_ratio 在用、absolute_diff 备用留档，配置选择）：

  ```
  D      = κ·ln((L_loc+c)/(L̄+c))        错位度（log_ratio；L̄ = 组内 level 几何平均；level 无上限）
  f(D)   = (base+amp·tanh²((D−shift)/densityScale)) · (floor+(1−floor)·σ((D−shift)/compressScale))
  g(T)   = σ(a·ln T分钟 − b)             T = timer − clock（剩余休眠分钟）
  p_命中 = f(D)·g(T)                     单次评估概率；实际打断率 = 1−(1−p)^评估次数（复利）
  p_恶性 = clamp(D + malignOffset, 0, 100)
  程度   = f(D)·sevScale + sevOffset + (2d20−2) − (d20−1)
  σ(x)   = 1/(1+e^(−x))
  ```

- **良恶/程度 = 所有 GM 激活前的固定判定**（常规 GM 用被裁决组的 D，突发 GM 用命中组的 D）：现投现算、经 fortune 占位符机械渲染注入、重跑自然重投。
- **突发 GM**：身份 = GM（同一预设、同一全知视野），专用提示词组 `gm-incident`（"同一身份 × 不同功能 = 不同提示词组"首个实例）；**slim 契约** = 事件文本 + 可选 deltas，独立轻校验，不复用 durations 覆盖校验。
- **incident 步**（归档 kind=`incident`，**调度透明步**：不是裁决边界、不触发正文衔接）：deltas 落库 + **目标组全员 timer 对齐世界时钟立即到期**（可逆 VarChange）。kind 是管线语义轴、身份是模型预设轴，二者不对齐是设计（adr/0006）。
- **突发内容不落 Event**：作为未裁决素材存于 incident 步 result（地位同工作集），经派生注入目标组角色的 #当前场景 开头与常规 GM 的 ##当前场景 开头（同一派生：该组上次 GM 结算边界之后的 incident 步）；GM 结算覆盖该组时由 GM 转写为真正 Event，注入自动消解。无突发正文步——narrativity 由后续常规结算照常决定。
- **投骰纪律**：命中判定归档进 incident 步 result（roll 快照：D/T/p/良恶/程度），重跑不重投；回溯过 incident 步 → 沉睡组原样复活（timer 经 VarChange 反向还原）。incident 步同 GM 步语义可编辑（编辑 = 该步的一次新输出：反转旧 effects 后按编辑包重放——deltas 重落库 + 目标组 timer 重新对齐时钟；target/roll 命中快照是投骰凭据不随编辑改变；被停止的突发步无快照不可编辑，回溯即重评重投）。**变量消费重算纪律**：凡消费变量的运算，变量被步外修改后必须支持按新变量重算——命中评估的自变量是地点 level/角色 level/timer，执行钩子又只随步运行触发，因此**编辑常规 GM 步或正文步、回溯落点为结算轮终点（skip GM 步/正文步）、直编变量，三者一律重挂命中评估**，下次续跑/玩家输入前重投（召唤正文的 GM 步不挂——正文步会重跑或已成为 current，由正文钩子负责）。**挂起期间派生相位是盲的**（投骰不进派生层，await_player 可能是假相位）：pipelineInfo 出 `pending_incident` 标志，前端据此屏蔽输入、显示「继续」引导结算。

---

## 5. 真相层与存档

### 5.1 事件记录体系

**单一事件库，@CID 占位，渲染时身份替换。**

- **只有 GM 可以添加新事件**；所有角色（包括玩家）的言行不直接入事件库——未裁决的言行进入**当前轮工作集**，按结构组装后直接注入，直到 GM 裁决时才被转写为事件。
- 记录格式用占位符：`@C1002 对 @C0 做了某事`（**玩家固定为 C0**，角色 ID 为 C+编号）。渲染给某个读者时代码做身份替换：自己 → "我"；认识的人 → 真名；不认识的人 → 人际关系库中的印象称谓。
- **事件侧 tags = 内容侧 TAG 挂载 `{name, level}[]`**（与 Lorebook 同一套体系）：常规 = cid 类一级（谁实际感知挂谁），空数组程序补全本轮全部行动者；感知过滤 = 按读者有效 TAG 集求值，无地点成分。私密事件 = 只挂自身 cid。
- **事件头**：事件存结构化 clock 值与 location 文本；自然语言时间头在注入/显示时经 `time.json` 机械渲染。跨场景对话事件 location 置空（感知不靠它）。
- 真相是第三人称的，**呈现是第一人称的**：编译给角色的内容经身份替换转写为角色本人的认知。

### 5.2 变量库

- `world.json`：`{schema_version, world:{time:{y,m,d,h,min}, _sys:{tagRegistry, varsTemplate, varsTags, cycles_since_gm, gm_trigger, gm_trigger_batch}, ...世界变量树}, pipeline:{seq, working_set, current}}`。clock 由 world.time 派生不落盘；pipeline 永不进入 agent 的 world 快照；`_sys` = 程序分支（档内注册表/模板/附加文件三副本 + 程序计数键，模板校验豁免，deltas 拒写）。
- `characters.json`：`{schema_version, characters:{cid: CharacterState}}` 单文件，C0 与 NPC 同构——name/gender/age/personality/reaction/location/timer/group/initiative/level/omniscience/isPlayer/appearance/relations/long_term_memory/vars（appearance = 在场位（程序维护，vars 源在场性过滤的输入）；relations = `{cid, name?, impression?}[]` 数组；vars = 变量树：末端 `{value, tags, formula?}` 外壳；角色根保留名 attachtags = 固有 TAG 末端、tags = union_attach 从动池）。角色只注入自己的完整快照，GM 注入全部角色快照。

### 5.3 存档（Generation 布局，统一 schema_version）

- 路径 `data/users/{username}/save/{runId}/`：`CURRENT`（文本 = 6 位零填充 revision）+ `generations/{revision}/`（world/characters/events/archive/lore/time/prompts 七真相文件，均带同一 `schema_version`，版本不符即拒绝加载且不迁移）。`prompts.json` = 档内提示词模板副本：新会话把世界包 `prompts/` 四份模板（character/gm/prose/gm-incident）校验后拷入存档（缺文件/校验失败即拒装），运行期编辑只动副本。
- **步边界整代提交**：七个 Store 是纯内存容器，唯一写盘出口 = `generationRepository.ts`，唯一提交入口 = `commitExecutor.ts`（CommitPlan = transactionId/baseRevision/reason/changes，plan 不落盘）。原子提交：临时目录 → 重读校验 → rename → CURRENT 切换；保留 current+previous，加载遇损坏回退上一代（灾备）。
- 步变化分段 `changes={setup, effects}`（轮首 setup 段 + 本步 effects 段）。
- **旁路产物**留 run 根不进 Generation：`meta.json`（世界包选择）/ `save-meta.json`（别名）/ `cache-stats.jsonl` / `llm-recent/{agent}.json`（每对象亲身参与的最近 5 轮 `{seq, messages, reasoning}` 滚动窗）。
- **恒冻结**：loadGeneration 返回前 + 每次 commit/adopt 后递归 deepFreeze，查询出口只读，越界写入测试期立刻爆炸。

### 5.4 回溯、编辑与直编

- **draft 机制**：编辑/回滚/直编 = cloneTruth → draft 变异 → commitTruth 一次提交 → adoptTruth（Store 身份不变），失败零副作用。
- **回溯**：`rollbackTo(targetSeq)` = 回到第 targetSeq 步刚完成的位置——倒序反向执行变量变更（before 写回）；archive 截断、events 按 seq 截断、lore 按 changelog 反向回滚；回滚后变量与目标步结束时逐字节一致。回溯丢弃不留底。
- **编辑** = 该步的一次新输出：setup 段保留、`changes.effects` 整段反向后经**同一效果规划器**（`src/application/`）重放（relations/邀请应答/标记/GM 效应无手工复制）；GM 步编辑 = 旧效应整体反向 + 事件按 seq 截断后按编辑包重新提交；正文步只改记录（participants/scenes 原样保留）。interrupted 步（停止后）拒绝继续，必须回溯或编辑。
- **重 roll** = Coordinator 的 `rollback_and_continue` 复合命令（同一队列任务内 rollback→continue，不可插队），只有最新一轮可用。
- **状态直编**（Web 状态栏）：world/characters/events 三域校验后整体替换（任一失败整体还原），LLM 在途拒绝；变量域经 varDiff 净额并入当前步 changes.effects（archive 记跨步净变更，手动编辑不是独立变更记录），事件域按 seq 截断口径；提交前跑一次组派生（rederiveGroups，幂等保稳，组未变则零变更）——直编对齐 timer/location 立即反映到编组；派生现算无缓存，编辑即时生效。直编 modal =「变量 / 事件」两标签页（一次只显示一个）：变量页 = 树状**状态编辑器**（世界/角色切换；`_sys` 不显示；系统只读 = {acted, group, channel, timer, isPlayer, appearance}，其余角色顶层字段按内置声明表可编辑——omniscience 前端钳制 0-6、initiative 为 null 时两值齐全整体写回、relations 条目增删（按 cid 追加/按下标摘除）、long_term_memory 行编辑；状态操作 = 末端写值 / 外壳 tags 与 tag_list chip 编辑（条目名称取自档内注册表）/ 结构化数组元素增删（按元素结构物化空白、只动实例不动模板）；从动末端值只读、formula 只读标注；保存载荷不含模板修改——`_sys.varsTemplate` 原样随 world 副本上送；直编后两域全量级联，从动值回归计算值），事件页 = raw JSON。modal UX：整树重渲保持滚动容器 scrollTop 不跳顶；保存成功不关窗（行内「已保存」短提示 + baseRevision 用保存后新 revision 推进，失败 400/409 行为不变）；取消/点遮罩在有未保存修改时先 confirm 确认。**变量结构编辑归世界页，双模式**：打开时探 GET /api/session/state/sys——有活跃会话 = **档内模式**（数据源 = 会话 `world._sys` 的 varsTemplate/varsTags/tagRegistry + baseRevision；保存 = PUT /api/session/state 带 `sys: {varsTemplate, varsTags}` + baseRevision 乐观闸，服务端取当前 world 替换 `_sys` 对应键后走同一直编通道——`_sys` 严格解析 + normalize + 从动级联沿用，结构不合法 400 零落盘，409 提示重取；保存后立即生效，TAG 附加注册表数据源 = 档内 `_sys.tagRegistry`），无活跃会话（404 NO_ACTIVE_SESSION）= **包基线模式**（vars-template.json / vars-tags.json，PUT 经 parseVarsTemplate / parseVarsTags 对拍校验、失败 400 零落盘、markStale 新会话生效；缺文件 GET 回缺省空结构、PUT 创建；注册表 = 包 tags.json）；模式指示行常显，编辑器本体两模式复用。编辑器本体：变量模板子区 = 声明树结构编辑（扁平末端五 valueType/结构体/结构化数组（引用类型或内联元素结构）新增、声明删除、类型新建/逐字段定义/删除（被数组元素 {type} 引用类型拒删）、末端 formula 声明编辑/清空（expr + binds / union_attach paths），character 域 = 全体角色共享模板、根保留名 attachtags/tags 保护、**character 根显示并入系统声明分支**（系统节点带徽记、全部结构操作禁用——只是显示注入，绝不写回保存载荷；与系统键同名的新增拒绝；formula 校验按并入后根解析，作者公式可绑系统 number 末端）），TAG 附加子区 = 声明树节点挂附加条目（{name/category, level}，名称下拉自当前模式注册表；character 根投影同样并入系统声明分支，系统节点可挂附加条目——与服务端 parseVarsTags 按并入后根校验口径一致；结构化数组整型 {tags, array} 挂载，扇出到元素结构全部末端）。

### 5.5 认知层

- **记忆 = 可见事件记录的视角化渲染** + relations 人际关系自维护。
- **长期记忆**：各角色 `long_term_memory`（开局 = 世界包角色文件的记忆种子）。
- 记忆压缩与检索：未实现，见 ROADMAP。

---

## 6. 注入与正文

### 6.1 三级记忆注入结构

```
[长期记忆]   压缩/种子条目——各对象从自己的库调取
[近期记忆]   近期具体事件——角色从公共事件库经 TAG 过滤拉取可见集 + 身份替换渲染；GM 拉取全部
[当前场景]   最近 N 轮正文（注入条件见 §6.2）+ 当前连续轮中已决策角色的言行（工作集，未落库直接组装）
```

- 角色也注入正文：防止细节丢失与出戏（已确认的权衡）。正文**不进事件日志**（避免双份真相），但作为注入素材承担"第四级存储"职能。
- 正文滑窗大小可配置：`settings.json` 的 `proseWindowTurns`（默认 5）——最近 N 轮注入正文、更早只注入事件。
- 工作集落盘于 `world.json` 的 `pipeline.working_set`，随 GM 裁决清算（通知条目同灭）；GM 恒见（权重 6 恒过）。条目并集 = 言行条目 | 系统通知条目：
  - **言行条目** = `{cid, input?, decision?}`（decision 引用与落账/投影同形，逐字节还原）。可见域 = decision 的 `visibility` 字段（缺省 = 组内全体 / A = 只对同频道 / B = 只对同地）；条目级 TAG 挂载**不落条目**，渲染时按焊死映射从当前真相派生——发言（dialogue 非空）= `{aud@1, vis@1}`（同级取或：听到或看到皆可）、行为（无言）= `{vis@1}`；字段 A 追加 `频道编号@2` + 手段 `{A@3, V@3}`（同级取或，工具双向对称），字段 B 追加 `地点名@2`。等级方案 = 感知（1) → 归属（2) → 手段（3)，代码焊死、世界观无权改写（世界性安插预留入口 = 派生函数的可选挂载参数，现无世界包内容）。
  - **通知条目** = `{id, author:"system", notice:{type, actor, means?, targets[]}, tags}`：gm_request/leave/recall/contact 四标记的注入镜像，载荷纯结构化参数、无文本（文案 = 投影层机械组装 + 占位符模板）；id 同 type 固定复用（`notice:{type}`，后来者居上）；tags 生成时按焊死映射安插（contact = 感知 `{aud@1, vis@1}` + 目标 cid@2 + 手段 `{A@3, V@3}`，其余 = `{vis@1}`），纯函数保证投影重建（回滚/GM 编辑切片）与落账逐字节一致。
  - **角色读者注入** = 抓取层同值批隔离（保留）+ 逐条目 TAG 过滤（条目挂载过求值器，过滤结果随扁平条目供给引擎；放行/不放行两侧与 matched 精确匹配分支归占位符模板——失聪读者对发言条目 OR 放行、matched=[vis] 命中降级分支；无频道者对字段 A 条目 = 不放行侧保底渲染）；自己的言行条目恒可见。读者有效 TAG 集 = tags 池纯名集 ∪ 程序派生（自身 cid、当前地点名、当前频道编号（若持有）、工具 AV 临时挂载——频道持有者及其同地成员持 {A, V}，组装时并入、不常驻变量）；开放类别实例集 = cid/channel/location 三类（命中归一化类别记号）。

### 6.2 连续场景判定（正文注入条件）

**连续场景 = 同一个同步组（同一组编号存续期间）的全部轮次。** 组解散/重组即场景断点。

- **正文归档元数据**：每个正文结果记录 `participants: string[]` 与 `scenes: Record<CID, 组编号>`（取该轮行动时、GM 改组前的组编号）。
- **角色**：`participants` 含该角色 CID ∧ 归档 `scenes[CID]` 与其当前组编号相同 → 取最近 N 段，禁止跨角色或跨组正文进入角色上下文。
- **GM**：本轮行动者中至少一人满足上述条件 → 只注入与当前轮连续的正文。
- **正文 activation 永远全量注入**（近期正文不断档，保证文风稳定）。

### 6.3 正文只能被 GM 激活

- 无判定轮内玩家直接看角色卡片言行流（零正文成本）；GM 激活后，正文 activation 把 GM 事件包 + 各角色台词内心一次性渲染成小说段落。
- 正文渲染范围 = GM 包全部事件（蒙太奇叙事，不做玩家视角过滤）；narrativity 为包级，skip 则整段无正文。

---

## 7. 上下文编译与缓存策略

### 7.1 模块化模板与声明式占位符组装

- **模板** = 档内第七真相文件 `prompts.json` 的 `templates` 键（出厂基线 = 世界包 `data/assets/{setId}/prompts/{agent}.prompt.json`，新会话拷入存档，此后只动档内副本）：完整四份（character/gm/prose + gm-incident 突发变体，无兜底）；有序模块数组，模块 = `{key, role: system|user|assistant, content}`，content 内 `{{placeholder}}` 占位；Web 可编辑（「提示词」页签）：有活跃会话时读写档内副本——保存后下一轮激活即生效，无会话时读写包基线（`?set=` 定位包）——新会话生效。
- **占位符全声明式、定义读者无关**（`prompts.json` 的 `placeholders` 键；出厂基线 = 世界包 `prompts/placeholders.json`，缺文件/校验失败拒装）：条目 = `{description, source, segments[]}`，source = 内容源封闭枚举（投影层清单）；段 = 静态段（原样输出）/ 条目段（`{pass, fail?, order?, separator?, merge?}`——pass/fail 各为缺省注入模板 + "匹配记号集 → 模板"精确匹配分支，未命中走该侧缺省兜底；fail 缺省 = 空模板）。扁平源条目 = 投影层已组装的扁平文本（`{_content}`，伪路径 `{_owner}` = 属主 CID）；vars 源条目段写全路由链路径（`{characters[*].items[*].name}`），遍历结构 = 引擎沿路由链找差异点自动归并（公共前缀共享、`[*]` 差异点产子循环，无独立轴声明）。遍历序前置（默认，条目轴独立滚完）/ 置后（同首位轴的置后条目融合为逐实例组；同占位符内置后条目首位轴必须一致）。编辑期机检（装配/续档与包基线校验同一函数）：路径必须解析到末端（tag_list 原子即止）、多路径路由链最前差异点兼容、置后同轴、分支记号 ∈ TAG 注册表条目名。未知占位符在模板加载/保存时报错（合法键集 = 目录键集）。Web 可编辑（「提示词」页「占位符」页签结构化编辑器，双模式与生效口径同模板编辑）：整份提交（PUT /api/prompts/placeholders）过 parse + 编辑期机检——机检上下文按模式供给（档内 = 档内 `_sys` 模板与注册表，包基线 = 该包变量体系文件），失败 400 零落盘。
- **管线次序 = 内容源投影 → TAG 过滤 → 声明式渲染 → 身份替换后处理**：投影层（`src/application/activationContexts.ts`，RenderHost 实现）按读者限定取数范围（角色事件/lore 经 TAG 过滤取可见集、working_set 经同值批隔离 + 逐条目 TAG 过滤（§6.1）——读者有效 TAG 集 = tags 池纯名集 ∪ 程序派生（自身 cid/当前地点名/当前频道编号/工具 AV 临时挂载）+ 全知权重；GM/正文 = 全量（权重 6 恒过）；cast 现建、lore 逐调用渲染档内副本，全部从最新真相逐调用现算）→ vars 源全量遍历（一切读者同一取数范围，无专门抓取）逐末端过 TAG 求值器——**在场性 = appearance 系统布尔 + 虚拟挂载**：对 `appearance=false` 角色的全部末端虚拟挂载 `{fappear, 6 级}`（不落盘、等级代码焊死；权重 6 全知恒见，权重 0-5 读者须持 fappear 纯名方可见后台；自豁免：属主 = 读者的子树不挂载——邀请应答时受邀者仍在后台，是后台读者的唯一场景）；程序维护时点 = 组弹出前台置 true（轮首 setup 段）、结算进后台置 false（GM 裁决）、入组置 true（远程按组籍/召回）、离组置 false（leave/频道清理），全部走 writeRaw 随 changes 落账；放行框全部路径放行 → 放行侧，任一不放行 → 不放行侧，不放行侧路径照常解析、未放行的给空）→ 引擎（`src/compile/render.ts`）渲染（懒求值：未引用占位符不取数；渲染后空模块整条丢弃）→ 身份替换统一后处理（引擎输出保留 @CID 原文：角色 = renderForReader/renderRefsForReader；GM = 事件保持 @ID 原文、指称渲染"称呼（@CID）"；正文 = renderForGm 演员表、指称保持原文）。
- **角色模板不注入演员表**（演员表带真名会让角色不劳而获地知道陌生人名字，污染人际关系库——名字必须靠剧情获得、由角色自己登记 relations）；cast 源供 GM/正文用。#当前场景一律用 `##@CID` 标注。
- **缓存友好 = 编辑约定**：动态内容（近期事件/正文滑窗/#当前场景）放尾部模块，由改模板的人自控——DeepSeek 前缀缓存跨消息边界生效，动态置尾则前缀命中。

### 7.2 各 Agent 缓存画像

| Agent | 稳定部分 | 每轮变动 | 主要开销 | 缓存要点 |
|---|---|---|---|---|
| 角色 ×N | 人设 + 标签 lore + 长期记忆种子 | 近期事件（身份替换）+ 正文滑窗 + #当前场景（@CID） | 小 | 占位符现取、动态置尾（编辑约定） |
| GM | 世界设定 + lore 全文 + 演员表 | 事件流 + 工作集 + 状态快照 + 正文滑窗 | **主输入** | 同上 |
| 正文 | 基调卡 + 世界 lore + 演员表 | 触发 lore + 近期事件 + 上一轮正文 + 本轮 GM 事件包 | **主输出** | 占位符现取、动态置尾（编辑约定） |
| 变量 | —（确定性代码） | deltas | ~零 | 不适用 |

### 7.3 缓存断点

核心只输出后端无关的中性层边界；翻译为 `cache_control` 等模型特定机制是边缘层的活。当前 DeepSeek 纯前缀缓存，无需显式断点，缓存工作 = 前缀稳定纪律，命中经 `prompt_cache_hit_tokens/miss_tokens` 埋点验证。

---

## 8. Lorebook 治理

- **触发制**：GM 不为正文激活/禁知条目；正文 lore = 本轮参与者有效 TAG 集（各角色 tags 池 ∪ 自身 cid）并集按 TAG 求值激活的条目（去重、按 ID 排序）；秘密条目访问控制 = 标签（如 `灯塔：秘密` 只随持该标签的角色进正文）；无挂载条目 = 广播恒过。GM 自身注入 lore 全文（id+tags+content，按 ID 排序）作自用参考。角色 lore = 自身有效 TAG 集求值激活。
- **档内副本**：新会话把世界 lorebook 拷入存档 `lore.json`，运行期增删改只动副本，不污染 `data/assets/` 原始世界包；changelog 逐条记录严格可逆变更（回溯按 changelog 反向回滚）。
- 角色固定携带标签（出身/职业等），**GM 可在游戏中授予/摘除标签**（转职、获得知识、状态变化），属于 GM 转写职责的一部分。

---

## 9. 运行时架构

- **无状态 activation**：构造只持 ChatPort + 档内 PromptsStore（每轮激活读档内模板副本）；全量上下文逐调用传入，实例零跨调用缓存。
- **统一效果规划器**（`src/application/`）：正常输出与编辑重放同一入口——`planActorDecision`（玩家/NPC/编辑统一：工作集/relations/acted/邀请应答/五标记）/ `planGmAdjudication`（deltas/durations/location/复位/组派生/事件 commit/工作集清算）/ `applyScheduleSetup`（轮首 setup 段落账）。只变异 draft 并返回 changes，永不直接持久化。
- **SessionCoordinator = 单一命令协调器**：唯一串行 mutation 入口（含 new/load）——SessionCommand 分发 + 串行队列 + busy 闸 + baseRevision 乐观并发校验（409）+ rollback_and_continue 复合命令 + stop 队列外中止 + 配置热应用转发；会话切换 = dispose 旧会话 + epoch 递增，旧会话晚到结果丢弃。
- **状态同步**：onCommit → transition 单条增量广播（引用比较求差）；snapshot 用于重连单播/会话切换广播。WS 入站协议唯一权威 = `src/contracts/protocol.ts`，前端唯一适配器 = `web/protocol.js`（契约测试对拍）。
- **配置事务**（`src/application/configService.ts`）：用户三资源（secrets/api-presets/settings）的全部修改走 baseConfigRevision 乐观并发闸 → 草稿 → 解析三 activation（失败零落盘）→ 原子保存 → 同一份 resolved 热应用运行中会话（原地更新 adapter 与滑窗/GM 间隔；失败回滚资源文件）。world/character 域新会话生效。
- **接入边界**：HTTP 与 WS upgrade 统一过 `src/server/accessControl.ts` 纯判定（Host 白名单——loopback 默认放行；WS Origin 须匹配 Host；ipWhitelist 非空必命中），拒绝 → 403。
- **双前端**：CLI 与 WebUI 各是 Display 接口的一个实现，同经 Coordinator 发命令，GameSession 不感知前端。

---

## 10. 成本模型

- 单事件窗口成本 ≈ N×角色（小输入小输出，且唤醒制下多数沉睡）+ 0~1×GM（大缓存前缀+结构化输出，按需激活）+ 0~1×正文（中缓存前缀+长输出，仅 GM 激活后）。
- 对比 ST 单次巨长无缓存调用：长会话下本架构**可能更便宜**——多出的调用次数被缓存命中率覆盖；无判定轮使 GM 调用频率从"每圈一次"降为按需。

---

## 11. 参考

- 参考思路.txt（类脑社区"独立角色"实践）：角色自治哲学、第一人称认知改写、GM 克制红线、记忆三层、Audit/Diary/Chat 模式、涌现实证。
- [GhostXia/AIRP-MCP-Server](https://github.com/GhostXia/AIRP-MCP-Server)：数据层/推理层分离铁律、决策提示而非强制工作流、通用优先于特供、缓存下沉边缘（[prompt-caching.md](https://github.com/GhostXia/AIRP-MCP-Server/blob/main/docs/prompt-caching.md)）、skill vs MCP 分工（[skills-vs-mcp.md](https://github.com/GhostXia/AIRP-MCP-Server/blob/main/docs/skills-vs-mcp.md)）、隔离 activation 治"死人化"、token 纪律细节。
- [ST-ClaudeCacheGateway](https://github.com/shanye5593/ST-ClaudeCacheGateway)（AIRP 引用）：`[[CACHE_BREAK]]` 中性标记 → 边缘翻译的思路。
