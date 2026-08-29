# 指令条目：上帝/写作指令 = 工作集第三条目种类 + 当轮一次性生命周期

**决定**：

- **输入模式（主控/上帝/写作）= 纯提示词层实现，不开功能组**：主控 = 玩家直接撰写决策包的现状通道（player_input → 工作集言行条目 → 经 working_set 源注入 GM/正文），不动。上帝/写作两条指令通道 = 工作集新条目种类——**指令条目** `{id, author, directive:{mode:"god"|"writing", text}, tags}`：id 同 mode 固定复用（`directive:{mode}`，先摘后附、后来者居上，appendNotices 先例的平行函数 appendDirectives），author = 主控角色 cid（协调层现取），tags 创建时挂 `{强制全知, 7 级}`（FORCE_OMNISCIENT_TAG 现成常量）。
- **当轮一次性生命周期，指令条目豁免 GM 清算**：工作集条目随 GM 裁决清算，但 narrativity ≠ skip 时指令条目保留（其余清空）——正文读者的场景文本不走工作集（从归档步 renderSpeech 现取），写作指令必须活到 prose 步；narrativity = skip（无正文步）时全清（指令含在内）；正文步提交（含被停止后的编辑补全）清除残留指令条目。
- **供给走读者轴而非 TAG 求值**：组装源新增 `god_directive` / `writing_directive` 两值；投影层按读者供给——god_directive 仅 GM 读者（工作集里 mode=god 的指令条目逐条供给，owner = author）、writing_directive 仅正文读者同理，角色读者恒空。读者轴供给本身就是第四面墙（角色恒不见），条目不再过 TAG 求值（恒放行缺省）；指令文本原样透传（出厂基线条目段 `identity:false`，不做身份替换后处理）。
- **指令不进场景/台词文本**：renderScene/renderSpeech/renderEntryLines 一律跳过指令条目（上帝指令只经 god_directive 源进 GM，不许泄进 sceneText）；行动者派生（roundCids/pending 计数/编辑重放摘除）全部按"非言行条目"处理（指令条目无 cid）。
- **输入通道 = WS `directive {mode, text}` 命令**（mutation 口径：requestId/runId/baseRevision；.strict() 分支与 web/protocol.js 字段白名单对称）→ Coordinator 裸队列（与 direct_edit 同闸：串行队列即空闲闸，不置 busy——GameSession.submitDirective 见 llmBusy 即拒）→ 指令条目并入工作集（同 mode 复用）→ 一次提交（revision 前移 + transition 广播），不产生 archive 步。受理窗口 = 有活跃会话（不自动建会话）且 LLM 不在途；不校验 phase/interrupted——指令是工作集内容单元，等玩家位与暂停态均可提交。
- **gm.incident 不注入指令**：突发在轮收尾后触发，指令已清算——接受此限制。

**为什么**：

- **不开通知条目 type**：通知载荷的约定是"纯结构化参数、无文本"（adr/0013——文案由投影层机械组装 + 占位符模板渲染）；指令的本质是玩家自由文本，塞通知载荷会破该约定，且通知条目 author 焊死 "system" 与指令的"主控角色所发"语义不符。新开条目种类让两种约定各自保持封闭。
- **豁免 GM 清算**：工作集清算的语义是"言行已转写为事件、素材到期"，但正文读者的场景文本从归档步现取、不读工作集——若指令随 GM 清算，写作指令永远到不了 prose 步。豁免窗口精确到"narrativity ≠ skip"：skip 无正文步，指令失去最后一站，一并全清不挂账。
- **读者轴供给而非 TAG 过滤**：第四面墙是读者维度（"角色不知道自己是角色"），不是内容属性维度——TAG 过滤回答"这条内容谁能感知"，而指令条目根本不是场景内的可感知事实。按读者轴在投影层直接供给（GM/正文各取所mode、角色恒空）让隔离语义显式化，tags 上的强制全知 7 级只是结构就位（与通知条目"挂载随条目携带"同形），不参与求值。
- **同 mode 固定 ID 复用**：指令是当轮一次性的临时内容，同 mode 多条只有最新一条有意义（两次上帝指令只需服从最新一次）；固定 ID 让复用语义显式化，且无需任何分配器状态。
- **裸队列 + llmBusy 闸（不置 busy）**：指令落账不调 LLM，串行队列本身即空闲闸；置 busy 会自锁（direct_edit 先例）。不走 runOnSession 另一原因：player_input 的 runOnSession 包装含相位校验与自动建会话，指令两者都不要。

**代价**：

- 回溯重建丢弃指令条目：工作集投影（回滚/GM 编辑切片）从步骤序列再生，指令条目无 archive 步凭据（设计即不产生步），回溯越过提交点后指令消失——当轮一次性语义下可接受（adr/0013 通知条目可由 markers 再生，指令无此凭据是刻意取舍）。
- LLM 在途提交的指令一律被拒（SESSION_BUSY），即便它对本步已来不及生效——受理窗口简单化的代价，前端错误行可见。
- GM 恒见上帝指令（含与裁决协议冲突的指令）——服从语义归模板文案（"与裁决协议冲突时协议优先"），是提示词契约不是程序闸。
