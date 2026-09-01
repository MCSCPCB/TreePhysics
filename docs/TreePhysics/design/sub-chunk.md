
接下来请你再帮我构思另外一个功能的实现，你帮我看看我的想法如何：我计划增加一个破坏/放置方块的交互功能，首先当玩家准星对准装配体上的某个方块时，我们会简单计算一下玩家的准星偏向然后通过实体或者粒子绘制一个选择框（和原版选中方块的那种框类似），我希望这个框能模仿原版破坏/放置方块的机制，比如说当玩家准星指向装配体上的一个方块时，假如玩家距离比较远或者某种比较合理的判定条件，则我们的选择框就作为“放置框‘，它会根据准星位置计算出玩家现在计划放置方块的地方，然后当玩家手持一个可放置方块右键（手机上是点一下，我暂时不确定脚本能否区分设备工作，但我暂时这样设计），就会播放原版玩家放置方块的手臂动画并且在这个位置上给装配体”放置对应的方块“，而如果玩家准星对准一个方块但距离比较近或者其他某种比较合理的判定条件，则此时选择框作为破坏框，玩家左键（手机上是长按）则把这个方块从装配体上”破坏’。这些被装在树木装配体上的“方块”不会像树叶或者树木附着物之类的破碎，而且这个被放置了新方块的树木装配体也会暂停原先的破碎结算计时器，直到玩家以某种方式让这个装配体结算或者超出一定范围后被现有的自动结算机制结算处理。你看看这个方案如何，适不适合在当前项目情况下实现这个功能（主要担心是会造成额外性能负担以及可能影响现有的左键击打右键牵引机制，但我初步计划可能可以通过潜行之类的方式来决定，暂时不确定），如果你觉得合适，请直接把具体的修改发案告诉我，具体到可以直接遵照的思路和链路即可，并且后续要有能力适配原版大部分甚至全部的方块（这样是为了减少帽因为手持物品的一方块一实体方案造成的开销）。我的方案就是以上这些

你的方案总体上适合当前项目，但需要调整两个核心前提：

不要把“远近”作为放置/破坏模式的主要判定条件。
不要一开始就实现“任意原版方块动态低实体渲染”。
更可靠的设计是：使用“明确的编辑模式 + 潜行作为编辑修饰键 + 统一射线目标”，先完成规则方块的增删和生命周期一致性，再扩展通用视觉注册表。

当前项目已经具备比较重要的基础：

tree-player-interaction.ts 已经有装配体射线检测。
physics.ts 已经有 PhysicsAssembly.raycast()。
PhysicsAssembly 已有完整的方块移除和物理表示重建流程。
现有 playerSwingStart 可以捕获攻击动作。
现有 beforeEvents.itemUse 可以捕获使用动作。
现有 fragment renderer 可以作为低实体视觉协议的基础。
但目前还缺少：

装配体方块的稳定“选择目标”状态。
装配体方块的添加事务。
编辑后的生命周期和持久化版本。
通用方块视觉描述和 fallback renderer。
当前拖拽、攻击、原版放置之间的输入优先级。
一、推荐的玩家交互模型
不建议用距离自动决定放置或破坏
距离只能作为有效性限制，不能同时承担模式选择。否则会出现这些问题：

玩家想破坏远处方块，却被判定成放置模式。
玩家想在近处放置，却被判定成破坏模式。
装配体旋转、倾斜后，世界距离和局部方块距离产生不同语义。
移动端玩家很难理解为什么同一个准星在不同距离下改变功能。
玩家靠近树干时可能误触发破坏，远离树木时可能误放置。
推荐使用明确的编辑模式：

状态	默认动作
普通模式	保持现有攻击冲量、拖拽和原版交互
潜行 + 对准装配体	进入装配体编辑上下文
潜行 + 攻击	破坏选中的装配体方块
潜行 + 使用可放置方块	放置到选中的相邻格
非潜行	完全保持现有树木交互
这样可以最大限度降低对现有左键击打和右键牵引的影响。

推荐输入优先级
建议明确写成固定状态机：


玩家非潜行
  -> 现有树木砍击
  -> 现有拖拽/释放
  -> 原版物品使用

玩家潜行且没有编辑目标
  -> 不触发树木冲量
  -> 不获取拖拽
  -> 原版行为优先

玩家潜行且准星命中装配体方块
  -> 显示编辑选择框
  -> 攻击 = 删除该方块
  -> 使用可放置方块 = 放置相邻方块
不要直接复用现有拖拽 toggle 逻辑。当前 tree-player-interaction.ts 中，任意 itemUse 都可能获取或释放拖拽；如果编辑功能直接插入该路径，容易产生：

放置动作被误判成拖拽释放。
玩家在拖拽时无法正常使用方块。
攻击同时产生冲量和破坏操作。
物品使用事件被错误取消。
推荐把当前控制器拆成两个层次：


TreePlayerInteractionController
  ├── FallenTreeDragController
  ├── FallenTreePunchController
  └── AssemblyBlockEditController
然后由最外层统一仲裁：


resolveInteractionIntent({
  isSneaking,
  hasEditTarget,
  hasDragSession,
  attackEvent,
  itemUseEvent
});
二、选择目标和选择框
1. 射线目标必须返回局部坐标和面信息
当前 PhysicsAssembly.raycast() 已经能返回：


interface PhysicsAssemblyRaycastHit {
  block: PhysicsAssemblyBlock;
  distance: number;
  location: Vector3;
  localLocation: Vector3;
}
编辑功能需要将其扩展为：


interface AssemblyBlockTarget {
  assembly: PhysicsAssembly;
  block: PhysicsAssemblyBlock;
  localLocation: Vector3;
  localNormal: Vector3;
  worldLocation: Vector3;
  worldNormal: Vector3;
  distance: number;
  face: "down" | "up" | "north" | "south" | "west" | "east";
}
其中 localNormal 不应该只使用射线方向反向估算，而应该根据方块 AABB 的实际命中面计算。这样放置位置才能稳定：


命中方块局部坐标
+ 命中面法向量
= 放置方块局部坐标
放置目标需要先量化到整数装配体网格：


const targetLocal = {
  x: hit.block.localLocation.x + hit.localNormal.x,
  y: hit.block.localLocation.y + hit.localNormal.y,
  z: hit.block.localLocation.z + hit.localNormal.z
};
实际项目中要注意：

装配体方块的局部位置可能不是整数中心。
坐标需要以装配体的 block origin 约定为准。
对倾斜装配体，射线命中法向量先转换到局部空间。
目标位置必须检查重复 key。
放置方块不能与已有方块占用相同局部坐标。
需要检查新方块是否越过允许的编辑边界。
2. 选择框刷新频率
不要每 tick 对所有装配体进行昂贵完整射线检测。建议：

仅为当前玩家建立编辑选择状态。
玩家视角、位置或目标装配体变化时刷新。
最多每 2 tick 刷新一次。
先做装配体 AABB broad phase，再做 block raycast。
射线长度固定为 5，与现有交互范围一致。
使用世界实心方块遮挡检查，避免隔着墙选到装配体。
没有命中时立即隐藏选择框。
伪代码：


interface AssemblyEditCursor {
  playerId: string;
  assembly: PhysicsAssembly;
  target?: AssemblyBlockTarget;
  mode: "none" | "break" | "place";
  lastRefreshTick: number;
  lastOrigin?: Vector3;
  lastDirection?: Vector3;
}
3. 选择框的显示方式
第一阶段推荐使用单个专用选择框实体，而不是粒子。

原因：

粒子边线在移动端表现不稳定。
粒子数量会随着玩家数和刷新频率增长。
粒子难以精确匹配旋转后的装配体方块。
实体可以直接设置位置、尺寸和颜色。
选择框只需要每个玩家一个，不需要每个装配体一个。
可以设计一个专用实体：


tree_physics:assembly_edit_cursor
它只负责：

线框几何。
位置。
长宽高。
颜色或模式状态。
可见性。
选择框属性建议：


cursor_x
cursor_y
cursor_z
cursor_width
cursor_height
cursor_depth
cursor_mode
cursor_visible
其中：


cursor_mode = 0 -> hidden
cursor_mode = 1 -> break
cursor_mode = 2 -> place
如果装配体允许倾斜，选择框也需要跟随装配体旋转；如果第一阶段只支持方块局部轴对齐但装配体可能旋转，则需要将选择框实体作为装配体的独立可旋转视觉实体，而不是简单世界轴对齐盒。

三、破坏模式
推荐触发方式

潜行 + 准星命中装配体方块 + playerSwingStart Attack/Mine
不要使用 playerBreakBlock 作为唯一入口，因为装配体方块并不是世界中的真实方块，原版事件不会为它们生成正常的 Block 破坏事件。

当前现有攻击事件在：


world.afterEvents.playerSwingStart
中处理。应在 #applyAttackImpulse() 前增加编辑优先级：


if (player.isSneaking) {
  const editTarget = this.#getCurrentEditTarget(player);
  if (editTarget) {
    this.#breakAssemblyBlock(player, editTarget);
    return;
  }
}
this.#applyAttackImpulse(player);
这样：

潜行编辑时不会同时给装配体施加冲量。
非潜行仍保持现有攻击冲量。
移动端长按产生的连续攻击事件可以复用同一路径。
不需要判断设备类型。
破坏有效性检查
破坏前应再次重新射线检测，不要直接使用上一帧选择结果：


1. 玩家仍有效。
2. 玩家仍潜行。
3. 玩家仍在 5 格内。
4. 当前装配体仍有效。
5. 当前命中仍是同一个 assembly id + local block key。
6. 世界中没有更近的实心方块。
7. 装配体未处于 pending settlement。
8. 当前编辑权限允许修改。
避免出现玩家转身后攻击仍删除旧目标的情况。

破坏数据流
新增一个事务入口：


assembly.removeBlockForPlayerEdit(localLocation)
不要直接从控制器调用当前的：


removeBlocksAtLocalLocations()
推荐由 PhysicsAssembly 暴露编辑专用方法：


removeBlockForEdit(localLocation: Vector3): PhysicsAssemblyEditResult
结果至少包含：


interface PhysicsAssemblyEditResult {
  changed: boolean;
  removed?: PhysicsAssemblyBlock;
  assemblyStillValid: boolean;
  colliderChanged: boolean;
  visualChanged: boolean;
}
内部仍然可以复用现有删除逻辑，但要保留：

原始 block permutation。
原始 block typeId。
原始 localLocation。
原始 mass。
原始 buoyancy volume。
原始 collider shape。
原始 material。
原始 visual descriptor。
然后由 lifecycle 层接收结构变化通知：


fallenTrees.markPlayerEdit(assembly);
方块掉落
默认行为应该与原版一致：

破坏成功后掉落该方块对应的 item。
Silk Touch、工具等级、方块状态和 loot table 需要由统一掉落解析器决定。
第一阶段可以先只支持稳定的 block-to-item 映射。
对复杂方块，必须保留原始 permutation state。
不要直接用 new ItemStack(block.typeId) 覆盖所有情况，因为很多 block ID 不是合法 item ID，或者方块状态无法通过简单 ItemStack 表达。
推荐抽象：


interface AssemblyBlockDropResolver {
  resolve(block: PhysicsAssemblyBlock, player: Player): readonly ItemStack[];
}
以后可接入：


vanilla loot resolver
custom block loot resolver
fallback item resolver
四、放置模式
1. 使用动作入口
建议使用：


world.beforeEvents.itemUse
但必须注意当前拖拽逻辑也订阅了同一个事件。因此放置编辑应排在拖拽逻辑之前：


if (player.isSneaking) {
  const target = getCurrentEditTarget(player);
  if (target && isPlaceableAssemblyItem(event.itemStack)) {
    event.cancel = true;
    queueAssemblyPlacement(player, target, event.itemStack);
    return;
  }
}
handleExistingDragItemUse(event);
使用动作有效性：


1. 玩家潜行。
2. 当前准星命中装配体方块。
3. 命中面提供有效放置格。
4. 手持物品属于可放置方块。
5. 玩家距离命中点不超过 5 格。
6. 目标局部坐标没有已有方块。
7. 新方块不超出最大装配体 block 数。
8. 方块状态可以被 capture。
9. 装配体仍未进入 pending settlement。
2. “放置框”的判定
不建议使用“远处 = 放置、近处 = 破坏”。

建议显示两个明确状态之一：


准星指向已有方块：
  潜行 + 攻击 -> 破坏框

准星指向已有方块的某一面，并且手持可放置方块：
  潜行 + 使用 -> 放置框
可以根据当前输入动态显示：


当前潜行、手持可放置方块、面外目标合法
  -> place cursor

当前潜行、目标方块可破坏
  -> break cursor
也可以使用按键状态：

攻击按钮按下时显示 break。
使用按钮按下或手持方块时显示 place。
两者都不满足时显示默认 break 预览。
不要根据距离改变显示语义。

3. 放置坐标
放置位置应由命中面决定：


const localPlacement = add(
  hit.block.localLocation,
  hit.localNormal
);
随后检查：


isIntegerGridLocation(localPlacement)
!assembly.hasBlockAtLocalLocation(localPlacement)
withinEditBounds(localPlacement)
再将其转换到世界位置执行视觉和声音反馈。

4. 原版放置动画
Bedrock 脚本可以调用：


player.playAnimation("animation.player.swing", ...)
但这不是所有版本、所有客户端和所有原版动作的稳定等价替代。建议：

第一阶段使用 player.playAnimation() 作为尽力而为的本地反馈。
不把动画成功作为放置事务成功条件。
放置成功后再播放。
如果 API 在目标版本上没有合适的 player animation，使用短粒子/音效作为 fallback。
不要创建一个方块实体来伪造玩家手臂动作。
五、装配体增块的核心架构
这是整个功能最重要的部分。

当前 PhysicsAssembly 只有移除流程：


removeBlocksAtLocalLocations()
直接添加一个元素到 #blocks 不够，因为下面这些都必须同步：


#blocks
#blocksByKey
#blockOrderByKey
AssemblyColliderIndex
logicalColliderIndex
Cannon body shapes
mass
center of mass
inertia
buoyancy points
visual renderer
collision proxy
runtime leaf state
persistence snapshots
fallen-tree lifecycle indexes
推荐新增统一事务
在 physics.ts 中新增：


addBlocksAtLocalLocations(
  additions: readonly PhysicsAssemblyBlockAddition[]
): PhysicsAssemblyBlock[] 
但不要让它只接收 block 对象后直接修改数组。推荐设计成事务：


interface PhysicsAssemblyBlockAddition {
  block: PhysicsAssemblyBlock;
  visual?: PhysicsAssemblyVisualDescriptor;
  runtimeKind?: "log" | "leaf" | "attachment" | "solid";
}

interface PhysicsAssemblyEditTransaction {
  add: readonly PhysicsAssemblyBlockAddition[];
  remove: readonly Vector3[];
  expectedRevision: number;
}
流程：


1. 检查 assembly 有效。
2. 检查 expectedRevision。
3. 标准化 localLocation。
4. 检查所有 key 不重复。
5. 检查 add/remove 不互相冲突。
6. 复制到临时 block/index 结构。
7. 构建下一版 collider index。
8. 构建下一版质量、质心和惯性。
9. 构建下一版 runtime representation。
10. 构建下一版视觉 assignment。
11. 所有步骤成功后一次性提交。
12. 提交后递增 assembly revision。
13. 发出结构变化事件。
推荐使用 copy-on-write，而不是先修改再尝试回滚。

物理计算
添加方块后至少需要更新：


总质量
质量矩
质心
惯性张量
碰撞形状
环境碰撞器
世界传感器区域
浮力采样点
材质
方块索引
质心更新公式：


newMass = oldMass + addedMass;

newCenter = {
  x: (oldCenter.x * oldMass + addedLocation.x * addedMass) / newMass,
  y: (oldCenter.y * oldMass + addedLocation.y * addedMass) / newMass,
  z: (oldCenter.z * oldMass + addedLocation.z * addedMass) / newMass
};
但当前 Cannon body 的位置是相对于质心管理的，所以提交顺序必须是：


1. 记录旧 body 世界位置。
2. 计算新质心。
3. 更新 assembly 本地 block 数据。
4. 更新 collider。
5. 更新 body 质心。
6. 将 body 位置修正为保持原来的世界参考点。
7. 更新惯性。
8. 唤醒 body。
9. 刷新视觉和碰撞代理。
否则方块添加后整棵树会产生视觉跳动或突然位移。

物理质量建议
对于玩家编辑添加的方块，不能只用默认质量和默认碰撞体。应复用现有 block physics registry：


resolvePhysicsBlockProperties(block)
resolveBlockCollisionShape(block)
resolveVanillaBlockSound(block)
方块状态也要参与：


typeId + permutation states
这样不同方向的楼梯、活板门、门、红石组件能得到对应的碰撞形状。

六、叶片和附着物分类
新增方块不能一律当作普通 solid block。

建议先建立分类器：


type AssemblyEditBlockKind =
  | "solid"
  | "log"
  | "leaf"
  | "fragile-attachment"
  | "unsupported";
第一阶段建议允许：


solid
log
leaf
暂时拒绝：


door
trapdoor
redstone component
container
block entity
fluid
command block
特殊可交互方块
原因是这些方块涉及：

方块实体状态。
邻接更新。
流体传播。
原版交互逻辑。
方块朝向和碰撞状态。
容器内容。
红石网络。
如果第一版硬塞进树装配体，后续容易出现玩家看到“方块”但无法正常交互的状态。

七、视觉渲染的正确路线
不能依赖运行时自动渲染任意原版方块
脚本运行时通常只能可靠取得：


typeId
permutation states
location
但不能动态读取并加载：


原版 blockstate model
terrain atlas UV
每个面的纹理路径
tint 规则
render layer
复杂模型拓扑
因此下面这种目标不可作为基础假设：


玩家手持任意方块
-> 运行时读取 typeId
-> 一个通用实体自动显示对应原版方块
资源包必须预先知道模型和纹理。

推荐分层 renderer

已注册规则体素
  -> Packed Voxel Fragment

已注册复杂 blockstate 模型
  -> Packed Model Fragment

未注册但有可靠物品模型
  -> Item Batch

仍未支持
  -> Per-block fallback
第一阶段 renderer
先支持最容易验证的方块：

完整立方体。
原木和柱体。
树叶。
草方块、泥土、灰化土、沙、砂砾、石头。
简单花草和交叉平面植物。
雪层、地毯。
用一个新的逻辑描述层：


interface BlockVisualDescriptor {
  typeId: string;
  stateKey: string;
  family: "cube" | "column" | "cross" | "unknown";
  variant: number;
  material: number;
  tint: number;
  localLocation: Vector3;
  localRotation: Vector3;
}
然后：


PhysicsAssemblyBlock
  -> BlockVisualDescriptor
  -> VisualRegistry.lookup()
  -> fragment slot assignment
不要直接把逻辑方块 ID 塞进当前 fragment 属性协议。

registry 必须按 blockstate 建立
只按 typeId 不够。例如：


minecraft:oak_log + axis=x
minecraft:oak_log + axis=y
minecraft:oak_log + axis=z
minecraft:oak_stairs + facing=north + half=top
minecraft:oak_stairs + facing=east + half=bottom
推荐 key：


type BlockVisualKey = `${typeId}|${sortedRelevantStates}`;
registry 内容至少包括：


model family
model variant
material class
texture class
tint rule
rotation rule
collision family
support category
entity 数量策略
不要直接把所有不同方块混在一个 fragment 中。应按模型家族和材质家族分箱：


fragment key = modelFamily + materialFamily + tintFamily
这样可以避免一个超大的混合 geometry 带来：

bone 数膨胀。
大量空 slot。
render controller 分支爆炸。
客户端 Molang 解析增加。
目标函数不应该只看实体数量，还要同时考虑：


实体数
geometry bone 数
可见 slot 数
property 写入次数
稀疏 slot 浪费
八、生命周期和暂停结算
玩家放置新方块后，应该暂停：

自动 sleep settlement。
叶片 decay。
自动 log breakage 计时。
编辑期间积累的旧 impact damage。
但不应该暂停：

区块未加载安全结算。
碰撞代理完整性失败。
视觉实体完整性失败。
熔岩终止。
显式 settlement。
资源或实体无法恢复时的终止处理。
在 fallen-tree-lifecycle.ts 的 FallenTreeState 增加：


playerEditPauseDepth: number;
playerEditRevision: number;
playerEditPauseSinceTick?: number;
playerEditDirty: boolean;
对外提供：


beginPlayerEdit(assembly): boolean;
markPlayerEdit(assembly): boolean;
endPlayerEdit(assembly): boolean;
settleExplicitly(assembly): ExplicitSettlementResult;
推荐状态

active
  -> player-edit-paused
  -> pending-settlement
  -> deleted
禁止：


player-edit-paused
  -> 因自动计时直接结算

pending-settlement
  -> 恢复成可编辑 assembly
结构编辑后的必要刷新
每次添加或删除方块后，必须更新：


assembly.blocks
snapshots
logs
leaves
fragileAttachments
leafPhysics
logBreakagePlan
probe keys
probe cursors
world mesh references
persistence revision
尤其是当前生命周期中：


tree.logs
tree.leaves
tree.fragileAttachments
tree.logBreakagePlan
并不会自动从 PhysicsAssembly 的 block 列表重新推导。只更新 assembly 会留下悬空的生命周期索引。

推荐统一走：


lifecycle.beginPlayerEdit(assembly);
assembly.applyEditTransaction(...);
lifecycle.markPlayerEdit(assembly);
lifecycle.endPlayerEdit(assembly);
如果一次交互只修改一个方块，也要使用同一个事务接口，而不是分别直接改数组。

九、持久化
编辑后的装配体必须保存：


新增/删除后的 blocks
block permutation states
assembly revision
playerEditRevision
sleep timer reset state
decay state
logBreakage state
visual descriptor state
必须同步更新：

SerializedFallenTree
SerializedFallenTreeState
serializeTree()
restoreState()
updateSerializedTreeState()
createTreePersistenceSignature()
如果只保存当前视觉实体而不保存方块状态，重启后会出现：

物理结构和视觉结构不一致。
重新加载时方块回退。
碰撞代理残留。
树叶探测索引引用旧坐标。
编辑暂停状态丢失后瞬间结算。
十、建议的开发阶段
阶段 0：先改善输入隔离
只实现：

潜行时禁止现有树木冲量。
潜行时不获取或释放拖拽。
潜行 + 装配体命中时显示选择框。
不修改方块。
先验证移动端、桌面端和控制器上的输入一致性。

阶段 1：选择框和删除
只实现：

装配体射线选块。
单玩家选择框。
潜行攻击删除。
复用现有 remove 流程。
掉落。
生命周期暂停和持久化。
此阶段不实现放置，先验证目标和破坏流程。

阶段 2：规则方块放置
只允许：


full cube
log
leaf
simple plant
实现：

addBlocks 事务。
质量、质心、惯性刷新。
collider 增量/重建。
fragment visual descriptor。
persistence。
explicit settlement。
阶段 3：通用视觉 registry
建立：


block ID + permutation state
-> visual descriptor
-> renderer family
加入原版规则方块注册表。

阶段 4：复杂 blockstate
支持：

stairs。
slabs。
walls。
fences。
doors/trapdoors。
redstone 组件。
这些方块应进入独立 model fragment，而不是硬塞入 cube fragment。

阶段 5：兼容 fallback
按顺序：


packed voxel fragment
-> packed model fragment
-> item batch
-> per-block entity
如果完全不希望出现一方块一实体，就要接受“未注册方块暂时不能放置”或者使用低精度视觉 fallback。二者不能同时保证：


任意方块
+ 完全原版视觉
+ 零新增单方块实体
+ 不预生成资源
最终判断
这个功能适合实现，但不建议把它作为一个直接挂在现有交互控制器上的小补丁。它实际上是一个新的“装配体编辑子系统”，需要独立处理：

目标选择。
输入仲裁。
增块/删块事务。
物理重建。
视觉 registry。
生命周期暂停。
持久化和恢复。
最稳妥的最终交互约定是：


潜行 + 准星对准装配体方块
  攻击 -> 破坏
  使用方块 -> 放置
非潜行
  保持原有击打和拖拽
这比按距离自动切换模式更容易理解，也更不容易破坏当前左键击打和右键牵引机制。