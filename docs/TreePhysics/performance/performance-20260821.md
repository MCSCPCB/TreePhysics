性能回归分析报告：HEAD (2e019b1) vs 基线 52f0d093
总体结论
基线之后的 50+ 提交引入了四大新功能：装配体方块编辑（挖掘/放置）、箱子存储（一方块一实体）、描边/交互预览、奔跑/摔落粒子。经 7 个分析代理 + 4 个对抗校验代理逐条核实调用链后，确认的性能回归集中在 2 条 high、5 条 medium；初始分析中约三分之一的指控被驳回或大幅降级（很多子系统改动实际是优化，见文末）。最严重的问题不在每 tick 热路径，而在编辑事件链路：每破坏一个方块就对整个装配体做全量拓扑重算 + 全量序列化落盘。

一、按情景列举的性能下降及原因
情景 1：连续挖掘/编辑倒下的树（最严重，high×2）
表现：对大型装配体（上限 6144 方块）连续拆树叶时，每次挥击卡顿；装配体越大越明显。树叶硬度换算后一次挥击即完成破坏，即该成本以每秒 2-5 次的频率触发。

原因 1 — 全量拓扑重算（基线无编辑功能，成本为零）：

fallen-tree-lifecycle.ts:1029-1032 每次完成破坏先 assembly.blocks.filter 复制全部剩余方块（每块两次字符串 key 分配），再调 createTreeEditTopologyPlan。
tree-edit-topology.ts:62-199 每次从零构建全量 Map/Set，原木 6 邻域 BFS + 树叶 26 邻域多源遍历 + 附着物/普通方块岛扫描，约 26N 次 Map 探测。
removeBlocksAtLocalLocations 内部另有 O(N) filter/splice（fallen-tree-lifecycle.ts:1386-1394）。
原因 2 — 全量同步持久化（基线仅有 20 tick 分片慢路径）：

fallen-tree-lifecycle.ts:1288 每次编辑调用 #serializeTree（2619-2678：克隆全部 blocks、chestStorages、leaves、snapshots），1336 同步 #writeSave。
#writeSave → splitSerializedTree → DynamicPropertyJsonStore：整棵树 JSON.stringify，按 30000 字符分块逐条 setDynamicProperty，再删除旧代全部分块。6144 方块的树 structure JSON 约 1-2MB，单次破坏 = 40-80 次动态属性写 + 同量删除，全部落在同一 tick。
修复方案：

增量拓扑索引：在 FallenTreeState 挂持久 TopologyIndex（编辑时增量维护，可直接消费 PhysicsAssembly 已有的 #blocksByPackedKey 而非重建 Map）。破坏时先做有界双向局部 BFS：检查被拆块 6 邻域是否仍互连。局部检查只能在严格证明现有原木、树叶、附件和非树方块连接语义下不会分裂时早退；无法完成证明时必须运行现有全量 plan，保证所有应有拆分准确发生。落点：tree-edit-topology.ts 新增局部连通检查，breakBlockForPlayerEdit 前置早退。
编辑日志式持久化：每次编辑同步只写一条小型 delta 记录（removed/added keys + revision），全量 structure 写入降级到现有 PERSISTENCE_INTERVAL_TICKS 慢路径/卸载时合并重写。改 #writeSave 增加 journal store，保持现有 generation/manifest 原子提交语义不变；journal 必须在游戏退出、区块卸载、脚本中断和重新加载后准确重放到最新装配体状态，不能丢失编辑、回退结构或破坏箱子绑定。
顺手删除调试日志：assembly-outline-controller.ts:824-854 的 #logAction/#logMiningAction 在每次挥击/未命中/放置时无条件拼字符串写 console.error（stage0/stage1 标记表明是调试脚手架），直接删除或加常量开关。
情景 2：世界中存在箱子装配体 + 多人在线（medium，多人时接近 high）
表现：只要任何一个物理装配体上有箱子（含未加载的存档树），所有在线玩家每 tick 进入射线轮询；玩家越多、箱子装配体存活越久，基底 tick 成本越高。

原因（基线的射线只由 itemUse/挥击事件触发，无任何每 tick 轮询）：

main.ts:254-256 物理 step 每 tick 新增 playerInteraction.tick。
assembly-container-interaction.ts:156-158 hasSyncTargets() 是全局布尔——一个箱子记录就开启全服轮询，不分维度、距离。
tree-player-interaction.ts:650-668 每 tick 遍历全部玩家，对每个"所在维度有装配体"的非潜行玩家做一次 DDA 射线（≤23 步，assembly-grid-raycast.ts:60），命中装配体再调原生 getBlockFromViewDirection；718 缓存仅限同 tick，静止玩家无法复用。
校验代理确认有廉价退出（维度无装配体时近零、未命中短路），故降为 medium 而非 high。
修复方案（按收益排序）：

先修 revision 基础设施：#assemblyRaycastRevision（physics.ts:1078）目前只在创建/删除时递增，物理模拟驱动的移动不递增——直接做跨 tick 缓存会返回陈旧结果。在 dimension.step() 空间索引更新处（physics.ts:1209-1211）当任一装配体空间变化时递增一次。
跨 tick 射线缓存：放宽 tree-player-interaction.ts:717-725 的缓存条件为"玩家头部/视线未变 且 revision 未变"——静止玩家 + 装配体全休眠时降为零射线。
按维度箱子索引：AssemblyContainerInteractionController 维护 per-dimension 记录计数，暴露 hasSyncTargets(dimensionId)；同步循环先按维度过滤（注意保留：持有 preview 的玩家仍需收到 syncTarget(undefined) 以释放预览）。
低优先：tick() 加 #activeRecords Set 只遍历激活记录（当前 O(C) 布尔扫描已很廉价）；#tryPlayerStandingInteraction 开头加 hasSyncTargets 守卫消除 itemUse 的多余箱子射线（不要重排拖拽释放顺序——会改变"拖拽中点击箱子"的语义）。
情景 3：潜行查看/预览装配体方块（medium）
表现：潜行玩家瞄准装配体时，每玩家每 tick 一次射线 + 命中时一次原生世界射线；装配体在动时还叠加代理方块的覆盖重算。

原因（基线无描边功能）：

assembly-outline-controller.ts:985-991 shouldRefreshOutlineRay 对 block 模式无条件返回 true（20 次/秒/玩家）；且 977-983 任意视线变化就进入 block 模式，所以瞄准装配体的潜行玩家大部分时间处于每 tick 刷新状态。
每次刷新触发代理方块同步：tree-interaction-proxy-block.ts:201-212 缓存用浮点完全相等比较，装配体任何微动即失效，随后最多 27 格 × 64 采样 ≈ 1728 次标量运算 + 1-3 次 getBlock（纯 CPU，不写方块，同格早退正常）。
修复方案：

shouldRefreshOutlineRay 增加"目标装配体在动"输入（assembly.body.isActive 或情景 2 的运动 revision），block 模式改为 viewChanged || assemblyMoving 才刷新——装配体休眠且视线不动时描边本就不需要更新，语义无损。
proxySyncStatesEqual 改为对 frame 中心/轴按 ~1e-3 量化后比较（最终选格是整数格，微小漂移不改变结果），消除慢速漂移下的每 tick 全量重采样。不建议降采样密度（改变平局判定），也不要把触发面收窄到 block 模式（assembly 模式同样依赖代理方块承接原生交互）。
可选：assembly-outline-geometry.ts:62-67 首看即算完整边集（超 28 条也白算完）、262 BFS 每接受前缀重调 createMergedVoxelOutline（最坏 O(P²)）——改为增量维护边集（每接受一格只更新 3×3×3 邻域）+ capacity 早停 + shapeCache 加小 LRU（≈32）。此项有 revision 缓存约束，属编辑后首次瞄准的单次尖峰。
情景 4：玩家在倒树上奔跑（low~medium）
表现：站在装配体上冲刺的每个玩家，每 tick 一次 spawnParticle（20 次/秒），每次新建 MolangVariableMap 并写 19 个变量。

原因（基线只有脚步声，无 surfaceParticle 信号）：physics.ts:1258-1311 冲刺接触每 tick 无条件发事件 → fallen-tree-lifecycle.ts:5555-5627 构造 Molang + spawnParticle。摔落 burst 只在新接触时一次调用（96 是发射器粒子数，不是 96 次调用），无需处理。场景限定为"站在树上冲刺"，故非 high。

修复方案：在 FootstepState 增加 lastSprintParticleTick（或复用现成的 distance 步距累计），#emitSprintingParticle 每 3 tick 或每移动 ~0.4 格发射一次，particleCount 提到 2-3 补偿视觉密度，可减 60-70% 调用。注意 5623-5627 的 spawnParticle 异常被 catch 静默吞掉，会掩盖粒子资源配错——建议至少记一次性告警（健壮性问题，顺手修）。

情景 5：含非树方块的树在滚动/受击（medium，条件性）
表现：放过箱子/普通方块的树在运动中发生脆弱块（树叶等）碰撞破碎时，每个破碎批次跑一次全量拓扑 + 全量序列化，运动期成簇出现。

原因：fallen-tree-lifecycle.ts:3744-3763 #breakAssemblyBlocks 尾部对含非树方块的树调 createTreeEditTopologyPlan(全部 blocks)；且 3783-3786 所有树每批次都 #refreshTreeSnapshot(structureChanged=true) 触发全量重序列化（归入情景 1 的原因 2）。

修复方案：与情景 1 共用增量拓扑索引即可覆盖；短期可按 contentRevision 缓存 plan（同批次内 revision 未变直接复用），改动仅在 #breakAssemblyBlocks 内。序列化部分由编辑日志方案一并解决。

情景 6：长期游玩后编辑树在基地附近累积（medium）
表现：被编辑过的树（automaticLifecyclePaused=true，fallen-tree-lifecycle.ts:744、963）不走睡眠超时结算（2015-2023），在玩家驻留区域内无限期保持：碎片视觉实体 + 碰撞代理 + collector + 存储实体常驻，每 tick 若干次区块可读性 getBlock 探测，每 20 tick 一次完整性扫描。基线普通树 sleepTimeoutTicks 后结算归零。

校验修正：这不是全局泄漏——cross-domain/熔岩/完整性失败路径仍会结算，活跃集合被"玩家附近"约束；睡眠树的每 tick 脚本成本实测很小（fragile 探测、decay、视觉同步都有门控短路），实体常驻比脚本 CPU 更实质。

修复方案：

低风险：1726-1732 对 body.isSleeping && automaticLifecyclePaused 的树把 #tickCrossDomain 可读性探测降频到每 10-20 tick（睡眠树不会移出区块）。
不实施 dormant 世界方块固化：装配体不能还原为真实世界方块，结算语义仍然只表示装配体破碎。长期累积问题仅通过不改变装配体生命周期和结算语义的低风险降频处理。
二、被驳回或无需担心的项（初始分析的误报）
"表面速度计算扩大" — 驳回：昂贵路径门槛与基线完全相同，新增的 getSurfaceVelocity 是微秒级纯 JS 且结果必被消费。
"射线触发重复全表清理" — 驳回：基线同构且更贵（基线是整表拷贝 + 全量 AABB 测试，HEAD 用空间索引反而更便宜）。
"挖掘阶段粒子/音效" — 驳回：仅 stage 变化触发（每方块 ≤10 次），树叶一击碎完全不触发，不高于原版反馈频率。
"一箱一常驻实体" — 降为 low：inactive 实体是无 AI、零碰撞箱的骑乘实体，挂在 511 容量 collector 上，移动只 teleport collector；20 tick getRiders 检查是基线既有机制。不建议改架构（脚本 API 无法把 ItemStack 序列化进动态属性，原生背包正是为此选的方案）。唯一真实长期成本已并入情景 6 的固化方案。
空间索引每 tick 维护 — low：getAabb 是纯 JS O(shapes) 运算，且索引使交互射线从基线的"遍历全部装配体"缩到邻近候选，整体是净收益。
裂纹实体 — low：数量 ≈ 正在挖掘的玩家数（个位数），写入全部有 epsilon/stage 门控。
箱子布局穷举（144 布局 / 4584 次 shift） — 数字属实但单次亚毫秒且仅编辑事件触发，low；可选修复是 packCubeBlocks 加 blocks.length === 1 快路径。
IncrementalVoxelMesh.add 全量重网格 — 现状 low（Stage2 只能放箱子，mesh 只含箱子），但属潜伏问题：未来支持放置实体方块时会变 medium，建议届时改局部重网格。
以下文件的改动全部是净优化（校验代理逐文件复核确认）：artificial-tree-registry（chunk memo）、tree/blocks（判定函数 Map 记忆化）、tree-selection（claims 分桶）、tree-item-drop-batching（typeId 分桶消除二次方）、assembly-contact-query（SAT 预计算）、world-block-probe-batch、block-sound（O(1) 查表，生成文件仅 +3.5% 字节）。
三、修复优先级清单
#	修复	恢复的情景	工作量
1	增量拓扑索引 + 局部连通早退	连续挖掘、滚动破碎	中
2	编辑日志式持久化（delta + 慢路径合并）	连续挖掘、滚动破碎	中
3	step() 内运动 revision + 跨 tick 射线缓存	箱子轮询、描边	小
4	per-dimension 箱子索引（hasSyncTargets(dimensionId)）	箱子轮询	小
5	block 模式按 viewChanged || assemblyMoving 刷新	潜行预览	小
6	冲刺粒子 3 tick/步距节流	树上奔跑	很小
7	代理方块量化比较	潜行预览（动树）	很小
8	删除编辑链路调试 console.error	连续挖掘	很小
9	paused 睡眠树探测降频	长期累积	小
做完 1-5 后，各情景的每 tick/每事件成本即可恢复到接近基线水平（基线这些功能不存在、成本为零，功能保留的前提下无法做到严格等于零，但上述方案把常驻成本压到"仅在玩家实际交互的窗口内付费"）。
