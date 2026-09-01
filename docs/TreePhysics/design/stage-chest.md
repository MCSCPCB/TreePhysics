# 阶段 Chest：物理装配体箱子

本阶段在阶段 2 已有的 fragment 箱子方块基础上，为单箱补齐原版实体容器式的存储、拿取、破坏、装配体间转移和 UI。箱子仍是装配体中的一个局部方块，不引入把装配体结算为世界方块的语义（参考 [`stage2.md`](stage2.md)）。

## 1. 箱子存储

### 需要实现的功能有什么

- 每个物理装配体箱子拥有唯一的一份 27 槽库存；库存属于箱子本身，不属于打开它的玩家。
- 多名玩家访问同一箱子时读写同一份库存，不创建玩家专属副本，也不在表单与实体库存之间复制物品。
- 库存及其中物品随世界保存和加载持续存在；装配体运动、休眠和普通视觉重建不得重置库存。
- 存储实体是装配体拥有的持久辅助实体，其生命周期与对应箱子所在装配体一致。fragment、collector、视觉实体和脚本运行时重建时只重新登记、迁移或挂载原存储实体，不删除并重新创建存储实体；装配体分裂时将原实体转交给唯一包含该箱子的子装配体，装配体结算时由同一结算事务掉落库存并结束实体生命周期。
- 普通运行采用 Farmer's Delight 样例已经验证的持久化、普通伤害免疫、无重力、无碰撞和不可推动保护；管理员以 `/kill` 主动杀死存储实体时沿用原生容器实体的死亡与库存掉落语义，不拦截、不重建、不从脚本备份恢复，也不生成空库存实体掩盖结果。
- 箱子的库存身份由“装配体身份 + 箱子局部坐标”确定；同一装配体中的多个箱子互不混用，任何无法唯一确定箱子的情况都应直接暴露为错误。
- 采用样例已经实际使用的原生 27 槽实体库存语义：样例柜子声明 `minecraft:inventory`、`inventory_size: 27` 和 `container_type: minecart_chest`，并以 `minecraft:persistent` 保持实体存在（参考 [`oak_cabinet.json`](../../../sample/Chest/chest-storage/B/entities/block_entities/cabinet/oak_cabinet.json)；同类实现另见 [`basket.json`](../../../sample/Chest/chest-storage/B/entities/block_entities/basket.json)）。

### 具体可行的具体技术链路和对应的技术参考文件目录

1. 新增一个无视觉、无重力、无物理碰撞的 `tree_physics` 箱子库存实体。实体直接声明 `minecraft:persistent` 与 27 槽 `minecraft:inventory`，库存实体中的 `Container` 是物品唯一真值，不再维护脚本表单库存副本。组件依据是 [`oak_cabinet.json`](../../../sample/Chest/chest-storage/B/entities/block_entities/cabinet/oak_cabinet.json) 中已经工作的 `minecraft:persistent`、`minecraft:inventory`、`minecraft:physics` 和 `minecraft:scale` 组合。
2. 放置箱子的事务为新箱子分配稳定的 storage ID，并把该 ID 保存到装配体结构记录的对应局部坐标；库存实体同时用动态属性写入 storage ID、装配体持久化 ID 和局部坐标。样例已经证明“生成实体后写入绑定动态属性，再用绑定属性核对实体”的方法可行（参考 [`BlockWithEntity.ts`](../../../sample/Chest/chest-storage/B/typescripts/lib/BlockWithEntity.ts)），但样例的世界坐标绑定要改为本项目的装配体持久化 ID 与局部坐标绑定。
3. 扩展 `SerializedFallenTree` 的结构数据，为每个箱子局部坐标保存 storage ID；该数据与 `blocks`、`snapshots` 一起进入现有分块动态属性存储，并在装配体恢复后严格重建 storage ID 到库存实体的映射。现有结构/状态分离、分块写入和恢复入口见 [`fallen-tree-lifecycle.ts`](../../../src/TreePhysics/gameplay/fallen-tree-lifecycle.ts) 与 [`dynamic-property-json-store.ts`](../../../src/TreePhysics/persistence/dynamic-property-json-store.ts)。
4. 库存实体不按箱子数量执行逐 tick 位置写入。非交互状态下，同一装配体的库存实体统一挂到按需创建、只接受库存乘客的专用 collector，由 fragment renderer 的既有位姿同步统一携带；它不与 fragment 或 selection 竞争座位。collector 已声明 512 个同位座位（参考 [`physics_fragment_collector.json`](../../../packs/TreePhysics/TreePhysicsBP/entities/tree_physics/physics_fragment_collector.json)），专用 collector 的挂载、原生关系核对和随装配体同步实现见 [`assembly-visual-renderer.ts`](../../../src/TreePhysics/physics/assembly-visual-renderer.ts)。
5. fragment collector 重建、锚点变化、装配体卸载和脚本重载时，先按 storage ID 接管库存实体，再迁移或重新挂载；不得随视觉实体一起删除库存实体。恢复时若 storage ID 缺失、重复，或一个 storage ID 对应多个实体，直接报告一致性错误，不能创建空库存覆盖原库存。现有 fragment 重建会移除辅助乘客，因此这一所有权边界必须显式拆开（参考 [`assembly-visual-renderer.ts`](../../../src/TreePhysics/physics/assembly-visual-renderer.ts) 的 `rebaseVisualAnchor`、`remove` 与乘客完整性检查）。
6. 不为存储实体建立独立于装配体的卸载、恢复或 `/kill` 修复状态机。世界重新加载时按 storage ID 重新登记仍然存在的原实体；装配体正常结算、越出加载区域触发的延迟结算及完整性失败结算都进入同一个装配体结算入口，并在该入口处理对应存储实体的库存掉落和生命周期终止。

## 2. 箱子拿取

### 需要实现的功能有什么

- 玩家能在箱子界面中把整组或部分物品从任意箱子槽取到自身背包，也能在箱子槽位之间移动、交换和堆叠物品。
- 拿取结果直接修改该箱子的共享原生库存；其他同时打开同一箱子的玩家看到并操作同一结果。
- 玩家背包没有可用空间时，不能因脚本侧二次搬运而删除、复制或覆盖物品；未成功移动的物品仍留在原槽位。
- 关闭界面、玩家离开、死亡或切换维度不触发库存回滚，也不需要把表单数据回写到实体，因为整个会话从始至终操作同一个原生 `Container`。
- 样例的普通柜子没有自定义存取脚本；其 27 槽实体使用 `container_type: minecart_chest`，资源包的 `chest_screen` 修改只对烹饪锅标题生效。这证明普通柜子的槽位交互由原生容器完成（参考 [`oak_cabinet.json`](../../../sample/Chest/chest-storage/B/entities/block_entities/cabinet/oak_cabinet.json)、[`chest_screen.json`](../../../sample/Chest/chest-storage/R/ui/chest_screen.json) 与 [`_ui_defs.json`](../../../sample/Chest/chest-storage/R/ui/_ui_defs.json)）。

### 具体可行的具体技术链路和对应的技术参考文件目录

1. 玩家实际交互的是目标箱子的唯一库存实体；原生 `minecart_chest` 界面直接读写该实体的 27 槽 `Container`，因此整组拿取、拆分、交换、堆叠和玩家背包空间判断都留给引擎。实体组件配置依据见 [`oak_cabinet.json`](../../../sample/Chest/chest-storage/B/entities/block_entities/cabinet/oak_cabinet.json)。
2. `playerInteractWithEntity` 只把“玩家、库存实体、装配体、箱子局部坐标”登记为一次打开会话，并驱动共享箱盖视觉；不得在该事件中从箱子逐槽复制物品到玩家背包。样例的普通柜子交互处理同样只更新打开状态而不搬运槽位（参考 [`CabinetBlockEntity.ts`](../../../sample/Chest/chest-storage/B/typescripts/block/CabinetBlockEntity.ts)）。
3. 正常会话期间不缓存槽位快照，不在关闭时执行回写。脚本仅在箱子破坏等必须脱离原生 UI 的事务中通过 `EntityInventoryComponent.container` 读取库存；样例对实体库存的直接访问方式见 [`EntityUtil.ts`](../../../sample/Chest/chest-storage/B/typescripts/lib/EntityUtil.ts)。
4. 同一 storage ID 在运行时只能注册一个库存实体。多个玩家打开同一 storage ID 时复用同一个实体和同一个 `Container`，会话集合只负责箱盖与实体激活期，不拥有物品数据；这样不存在两个容器副本关闭顺序不同导致的覆盖问题。

## 3. 箱子破坏

### 需要实现的功能有什么

- 箱子继续复用现有装配体方块挖掘进度、裂纹、粒子、音效、工具判定、工具耐久、拓扑重建和箱子方块掉落，不增加第二套破坏手势或破坏计时。
- 箱子方块被成功破坏时，其库存中所有非空物品在被破坏箱子的物理世界位置掉落；箱子方块自身的掉落仍由现有方块 loot table 链路生成。
- 库存物品只在装配体结构删除事务成功提交后掉落。事务失败时箱子、库存实体和全部物品保持原状。
- 同一次破坏无论经历脚本重载、视觉重建还是装配体分裂，都不能重复生成库存物品，也不能先删除库存实体再丢失内容。
- 正在打开的箱子被破坏时立即使该箱子的所有打开会话失效；停止继续接受槽位操作，完成库存掉落和清空后移除库存实体。
- 装配体整体结算与单箱破坏使用同一库存掉落操作：结算中的每个箱子都在自己的物理世界位置掉落库存，完成后结束对应存储实体；加载区域边界导致的延迟结算只延迟这项同一操作，不建立箱子专属分支。
- 现有代码已经把 `minecraft:chest` 纳入共享玩家编辑破坏类型，并在成功提交后统一生成方块破坏效果与 loot table 掉落（参考 [`blocks.ts`](../../../src/TreePhysics/tree/blocks.ts)、[`assembly-outline-controller.ts`](../../../src/TreePhysics/gameplay/assembly-outline-controller.ts) 与 [`fallen-tree-lifecycle.ts`](../../../src/TreePhysics/gameplay/fallen-tree-lifecycle.ts)）。

### 具体可行的具体技术链路和对应的技术参考文件目录

1. `breakBlockForPlayerEdit` 在计算拓扑时同时按目标局部坐标取得唯一 storage ID、库存实体和 `Container`；任一项缺失或映射不唯一时，在修改装配体前直接报错。现有破坏事务会先构造完整替换结果并持久化，成功后才删除父装配体，事务边界见 [`fallen-tree-lifecycle.ts`](../../../src/TreePhysics/gameplay/fallen-tree-lifecycle.ts)。
2. 原地编辑时从同一装配体结构记录删除该局部坐标的 storage ID；真实分裂时不把被破坏箱子的 storage ID 分配给任何子装配体。该结构变更与现有 `blocks`、`snapshots` 一起提交，不能在持久化成功前清空库存。
3. 结构提交成功后，使所有关联会话失效，从 collector 脱离同一个库存实体，并把它传送到破坏前保存的 `body.localPointToWorld(localLocation)`。现有代码已经在修改前保存每个 `PlayerEditBreakEffect.position`，并在提交后统一发出效果（参考 [`fallen-tree-lifecycle.ts`](../../../src/TreePhysics/gameplay/fallen-tree-lifecycle.ts) 的 `PlayerEditBreakEffect` 与 `#emitPlayerEditBreakEffects`）。
4. 对库存实体调用原生死亡链路，让 `minecart_chest` 容器自行掉落其中物品并结束实体生命周期；脚本不逐槽复制物品、不清空槽位，也不建立箱子专属 pending-break 恢复状态机。Farmer's Delight 的柜子已经采用相同的原生实体库存组件与伤害免疫边界（参考 [`oak_cabinet.json`](../../../sample/Chest/chest-storage/B/entities/block_entities/cabinet/oak_cabinet.json)）。
5. 箱子方块本身继续走 `generateLootFromBlockPermutation`，库存物品不得再次进入该方块 loot table 链路（参考 [`fallen-tree-lifecycle.ts`](../../../src/TreePhysics/gameplay/fallen-tree-lifecycle.ts) 的 `generatePermutationDrops`）。外部 `/kill` 同样只产生原生实体死亡和库存掉落；`entityRemove` 只注销运行时引用，不恢复实体或创建空库存。

## 4. 箱子装配体间转移

### 需要实现的功能有什么

- 装配体因方块破坏断成多个子装配体时，每个保留下来的箱子连同原 storage ID 和原库存进入唯一包含该箱子局部坐标的子装配体。
- 转移不创建库存副本、不逐槽搬运物品，也不改变箱子内容；只是把同一个库存实体的所有权从父装配体改绑到子装配体。
- 未发生真实分裂的原地编辑继续使用原装配体持久化 ID 和 storage ID，不执行无意义转移。
- 子装配体持久化失败时，父装配体与全部库存绑定保持原状；只有所有子装配体记录成功提交后，才切换库存实体的绑定和乘坐关系。
- 一个箱子必须恰好匹配一个子装配体。零个匹配表示箱子应进入破坏链路；多个匹配表示拓扑或数据损坏，必须报告错误，不能猜测目标。
- 安全且唯一的转移应保持正在打开的共享会话和箱盖状态；箱子不存在、storage ID 不唯一或无法证明唯一映射时，会话失效并关闭视觉状态。
- 当前拓扑组件保留每个方块的局部坐标，替换事务在所有子记录持久化成功后才删除父装配体；现有会话代码也已采用“唯一 replacement 含同一局部箱子”的判定（参考 [`tree-edit-topology.ts`](../../../src/TreePhysics/gameplay/tree-edit-topology.ts)、[`fallen-tree-lifecycle.ts`](../../../src/TreePhysics/gameplay/fallen-tree-lifecycle.ts) 与 [`assembly-container-interaction.ts`](../../../src/TreePhysics/gameplay/assembly-container-interaction.ts)）。

### 具体可行的具体技术链路和对应的技术参考文件目录

1. 在 `createTreeEditTopologyPlan` 产生组件后，以每个组件的局部坐标集合过滤父装配体的箱子 storage 记录；每条记录还必须核对该坐标在组件中确实是 `minecraft:chest`。拓扑组件直接保存原 `PhysicsAssemblyBlock` 及其局部坐标，依据见 [`tree-edit-topology.ts`](../../../src/TreePhysics/gameplay/tree-edit-topology.ts)。
2. 为每个子装配体构造结构记录时写入其筛选后的 `{ localLocation, storageId }`，storage ID 不变。提交前验证：父装配体每个仍存在的箱子恰好分配一次、被破坏箱子分配零次、任何非箱子坐标分配零次；违反任一条件就终止整个编辑事务。
3. 将 storage 分配与现有子装配体的 `blocks`、`snapshots` 一起写入子结构存储。现有实现已经先暂存全部子装配体、写入全部子记录，失败时丢弃未提交子体并恢复父记录（参考 [`fallen-tree-lifecycle.ts`](../../../src/TreePhysics/gameplay/fallen-tree-lifecycle.ts) 的 `stagedTrees`、`#writeSave(childIds)` 与 `#restoreTreeRecordAfterFailedEdit`），storage 分配必须进入同一个提交判定。
4. 子记录提交成功后、调用父 `assembly.remove()` 前，从父 collector 脱离全部要转移的库存实体；随后把实体的 owner 持久化 ID 更新为子记录 ID，并挂到对应子装配体 collector。这个顺序是必要条件，因为当前 renderer 的 `remove()` 会清理其登记的辅助乘客（参考 [`assembly-visual-renderer.ts`](../../../src/TreePhysics/physics/assembly-visual-renderer.ts)）。
5. storage ID 是库存实体的稳定身份，子结构记录是当前所有权真值；实体上的 owner 与局部坐标动态属性用于加载时索引和一致性核对。样例已证明实体动态属性可承载绑定信息（参考 [`BlockWithEntity.ts`](../../../sample/Chest/chest-storage/B/typescripts/lib/BlockWithEntity.ts)），但不得用运行时数值型 `PhysicsAssembly.id` 作为持久身份，因为恢复后装配体会重新创建（参考 [`physics.ts`](../../../src/TreePhysics/physics.ts) 与 [`fallen-tree-lifecycle.ts`](../../../src/TreePhysics/gameplay/fallen-tree-lifecycle.ts)）。
6. 若打开会话对应的 storage ID 被唯一转移，会话改绑到子装配体并对相同局部坐标继续设置打开视觉；否则立即失效。现有 `handleAssemblyReplacement` 已提供该唯一匹配模式及 `main.ts` 回调入口（参考 [`assembly-container-interaction.ts`](../../../src/TreePhysics/gameplay/assembly-container-interaction.ts) 与 [`main.ts`](../../../src/TreePhysics/main.ts)）。

## 5. 箱子 UI

### 需要实现的功能有什么

- 非潜行玩家以原版交互方式打开物理装配体箱子：PC/手柄使用交互键，触屏使用实体容器的原生长按互动。
- 显示原版 27 槽小箱子界面和玩家背包区域，不显示 ActionForm，不实现脚本按钮模拟槽位。
- 箱子互动优先于牵引：PC 交互键和触屏长按命中箱子时不得获取或继续牵引装配体；触屏点击仍按原有站立攻击语义施加冲量。
- 第一个玩家实际打开容器时播放打开效果并将箱盖设为打开；只要仍有玩家打开同一库存实体，箱盖对所有玩家保持打开；最后一个玩家实际关闭时播放关闭效果并合盖。
- 箱子 UI 标题使用可本地化的箱子名称。资源包不覆写原版 `chest_screen`，以保持原版界面以及其他 addon 对原版界面的修改兼容。
- 箱子运动时，当前被预选或正在打开的库存实体跟随对应箱子的物理世界位置；未被预选且无人打开的库存实体回到无碰撞的随装配体库存乘客状态，不按箱子总数逐 tick 更新位置。
- 普通柜子样例使用 `minecart_chest` 原生 UI；其资源包对 `chest_screen` 的修改只在烹饪锅标题匹配时生效，因此普通柜子并不依赖自定义 JSON UI（参考 [`oak_cabinet.json`](../../../sample/Chest/chest-storage/B/entities/block_entities/cabinet/oak_cabinet.json)、[`chest_screen.json`](../../../sample/Chest/chest-storage/R/ui/chest_screen.json) 与 [`_ui_defs.json`](../../../sample/Chest/chest-storage/R/ui/_ui_defs.json)）。

### 具体可行的具体技术链路和对应的技术参考文件目录

1. 用原生库存实体替换当前 `ActionFormData` 空表单。实体沿用样例已验证的 `minecraft:inventory`、`container_type: minecart_chest`、不可受伤、无重力和缩放为零配置；inactive 组件组使用零碰撞箱，active 组件组才启用供玩家命中的交互碰撞箱。样例配置见 [`oak_cabinet.json`](../../../sample/Chest/chest-storage/B/entities/block_entities/cabinet/oak_cabinet.json)，原版 `minecraft:chest_minecart` 的 27 槽配置可对照 [`chest_minecart.json`](../../../sample/vanilla-bds/behavior_packs/vanilla/entities/chest_minecart.json)。
2. 新增不绘制轮廓的“站立箱子预选”。扩展玩家注册表以迭代已登记的有效玩家，给非潜行玩家复用装配体空间候选索引、网格射线和同 tick 射线缓存；命中 `minecraft:chest` 后按局部坐标取得 storage ID，在客户端交互发生前把唯一库存实体切到 active 并定位到 `assembly.body.localPointToWorld(localLocation)` 对应的箱子区域。现有玩家事件驱动注册表见 [`active-player-registry.ts`](../../../src/TreePhysics/gameplay/active-player-registry.ts)，候选索引与整数中心方块射线见 [`assembly-spatial-index.ts`](../../../src/TreePhysics/physics/assembly-spatial-index.ts) 和 [`assembly-grid-raycast.ts`](../../../src/TreePhysics/physics/assembly-grid-raycast.ts)，当前潜行 selection 的缓存方式见 [`assembly-outline-controller.ts`](../../../src/TreePhysics/gameplay/assembly-outline-controller.ts)。
3. 同一库存实体按“至少一个玩家仍预选该箱子，或至少一个玩家仍打开该容器”保持 active。装配体运动时只更新这些 active 实体；没有预选者和打开者后，关闭碰撞箱并重新挂回所属装配体 collector。这样位置写入数量受当前玩家交互数限制，不随装配体箱子总数增长。
4. 订阅 `world.beforeEvents.playerInteractWithEntity` 核对目标实体的 storage ID，但不取消合法事件，让引擎打开原生容器。站立 `itemUse` 使用同一装配体射线确认目标箱子并在牵引获取之前返回，因此 PC 交互键和触屏长按都优先打开箱子；站立攻击挥手不再经过箱子回调，继续施加冲量。现有优先级与站立装配体射线入口见 [`tree-player-interaction.ts`](../../../src/TreePhysics/gameplay/tree-player-interaction.ts)。
5. 以 `world.afterEvents.entityContainerOpened` 和 `entityContainerClosed` 作为 UI 实际打开、关闭的唯一会话事实。两类事件都给出库存实体及 `ContainerAccessSource.entity`，因此按 storage ID 维护 viewers 集合：从 0 变 1 时调用 `setCubeBlockOpenState(localLocation, true)` 并播放打开音效，从 1 变 0 时设为 `false` 并播放关闭音效。当前依赖的 SAPI 类型已明确声明这些事件和访问来源（参考 [`@minecraft/server/index.d.ts`](../../../node_modules/@minecraft/server/index.d.ts)），行为包 manifest 已固定依赖 `@minecraft/server 2.8.0`（参考 [`manifest.json`](../../../packs/TreePhysics/TreePhysicsBP/manifest.json)）。
6. 库存实体 `nameTag` 设置为本项目提供的可本地化箱子标题；样例在创建实体后用 `nameTag` 传递原生容器标题（参考 [`BlockEntityComponent.ts`](../../../sample/Chest/chest-storage/B/typescripts/customComponents/block/BlockEntityComponent.ts)）。删除 [`assembly-container-interaction.ts`](../../../src/TreePhysics/gameplay/assembly-container-interaction.ts) 中 `ActionFormData.show`、pending form Promise 和基于表单完成时机的关闭逻辑。
7. 资源包不新增 `chest_screen.json`、不修改 `_ui_defs.json`。普通箱子的布局、鼠标/手柄/触屏槽位操作均由原生界面提供；本项目只保留现有 fragment 箱盖动画入口 `setCubeBlockOpenState`，其实现位置见 [`physics.ts`](../../../src/TreePhysics/physics.ts) 与 [`assembly-visual-renderer.ts`](../../../src/TreePhysics/physics/assembly-visual-renderer.ts)。
