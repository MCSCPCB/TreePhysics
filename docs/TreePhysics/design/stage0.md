

**要实现的功能**

1. 非潜行交互完全保持现状：
   - 攻击物理结构仍会施加冲量。
   - 使用物品仍可获取或释放拖拽。
   - 不执行轮廓检测。

2. 潜行时进入预览交互状态：
   - 攻击不施加冲量。
   - 不能获取或维持拖拽。
   - 已存在的拖拽沿原链路结束。
   - 潜行攻击和使用会立即刷新一次射线，并临时通过 `console.error` 输出动作、装配体 ID、目标格、命中面或未命中结果。
   - Stage 0 不破坏、不放置、不消耗物品、不修改装配体。

3. 玩家连续命中同一装配体 1 次后显示整体轮廓：
   - 包含原木和附着物。
   - 不包含树叶。
   - 优先显示消除内部边后的精确外轮廓，也就是edgerender里的剪影渲染，包含渐入渐出，渐变时长0.25秒。
   - 精确轮廓是否可用只取决于合并后能否编码进 28 条边，不额外设置 128 格限制。
   - 超出容量时根据准星附近的实际装配体拓扑选择局部轮廓。
   - 准星附近能形成实心长方体时显示局部 AABB，否则显示不超过 28 条边的局部精确轮廓。

4. 整体轮廓激活后，如果玩家准星没动，则持续命中同一方块 2.5 秒后自动切换为方块预览，而如果玩家视角角度发生变化且仍然射中装配体上的方块，则立刻切换方块预览：
   - 首次进入单方块模式需要 2.5 秒稳定确认。
   - 进入后，准星移动到同一装配体的其他方块时立即更新，不再重复等待。
   - 整体轮廓排除叶片，单方块射线与方块预览不排除叶片。
   - 手持不可放置物品时显示目标方块框。
   - 手持可放置方块且相邻格为空时，显示包围“目标格 + 预计放置格”的整体长方体轮廓。
   - 预计放置格由命中方块局部坐标加实际命中面法线得到。

5. 实体管理安全：
   - 命中另一个装配体时，仍需连续确认 1 次才切换。
   - 退出潜行、死亡、离开、重生、切维度或装配体失效时进入淡出或立即执行必要清理。

**实体与显示方案**

- 一个被选中的装配体最多对应一个轮廓实体。
- 多名玩家选择同一装配体时共享实体，通过玩家私有属性 `setPropertyOverrideForEntity()` 覆盖显示各自的模式和目标。
- 每名正在潜行预览的玩家维护一个临时 `tree_interaction_proxy` 方块，作为触屏和 PC 共用的原生交互目标，并在预览结束后恢复原方块或流体。
- `physics_block_break` 实体只渲染玩家私有的挖掘裂纹，碰撞箱恒为零，并且仅在挖掘进度存在时生成。
- 保留约 0.25 秒淡入和淡出。
- 轮廓功能只支持 fragment 视觉链路；一方块一实体装配体不进入 Stage 0 预览链路。
- 轮廓挂在装配体现有 fragment collector 上，位置由骑乘关系自然跟随，不为轮廓增加 `teleport`。
- collector 为轮廓保留一个座位，避免视觉乘客占满后无法挂载。
- 方块是否进入整体轮廓由树木部位语义决定，不再通过 renderer 类型推断。

**淡出与野实体安全**

淡出期间实体仍保存在控制器的活动记录中。淡出结束后固定执行：

```text
清除玩家私有覆盖
-> 从 collector 卸载
-> 删除轮廓实体
-> 删除活动记录和缓存
```

装配体在淡出期间失效时按现有 fragment 处理链路清理。脚本重新加载后，在允许创建新轮廓和裂纹实体前主动扫描并删除已加载维度中的旧实体；`entityLoad` 同时负责清理之后意外加载的未登记实体，代理方块则由自定义 tick 恢复。

**性能方案**

- 非潜行玩家不执行射线，只有现有事件中的一次布尔判断。
- 不建立额外的每 tick 调度器，轮廓状态接入现有物理 step。
- 同一玩家同一 tick 的攻击、使用和轮廓检测共享正命中或负命中结果。
- 装配体内部射线使用局部网格 DDA，不遍历全部方块。
- 局部 AABB 直接查询目标半径内的哈希网格，不遍历整棵树。
- 完整轮廓只在首次创建或装配体内容版本变化时计算并缓存。
- 休眠装配体且内容和目标不变时，不产生代理 `teleport` 或属性写入。
- 轮廓实体只为当前正在潜行预览的 fragment 装配体创建，并由选择同一装配体的玩家共享；交互代理最多每名玩家一个。

**实施顺序**
1. 实现并测试局部 DDA、面法线、轮廓边合并和编码。
2. 给装配体方块补充原木、树叶、附着物语义。
3. 重写输入隔离、公共射线缓存和玩家确认状态机。
4. 接入 fragment collector 和每玩家交互代理，并明确拒绝一方块一实体链路。
5. 参考 EdgeRender 的边判定和穿墙自发光材质，手写单实体轮廓资源。注意edgerender的剪影效果可以直接照搬
6. 实现淡入、淡出、多人共享和孤立实体清理。

**技术实施约束**

- 输入仲裁必须具有固定顺序：已有拖拽会话先沿原链路释放，再进入潜行预览分支；潜行但没有有效预览动作时不得取消原版物品使用；攻击事件在交互控制器内部判断潜行并阻止冲量，同时保留为后续编辑阶段的动作入口。
- 轮廓控制器作为独立的装配体交互子系统维护目标、确认状态、共享轮廓、每玩家代理和淡出生命周期；现有玩家交互控制器只负责统一仲裁攻击、使用、拖拽和轮廓意图，避免把状态分散到多个事件回调。
- 装配体射线命中结果统一返回装配体、方块、距离、世界/局部命中点、世界/局部法线和命中面。`localNormal` 必须来自局部方块 AABB 的实际入射面，不能用射线反方向估算。
- 预计放置格固定为 `hit.block.localLocation + hit.localNormal`。计算时遵守现有 block origin 约定，并验证结果位于整数局部网格且没有被现有装配体方块占用；倾斜装配体的命中法线必须正确转换到局部空间。
- 射线有效距离固定为 5 格。先进行装配体世界 AABB broad phase，再进行局部网格 DDA；同时比较世界实心方块命中距离，禁止隔墙选中装配体。
- 只为潜行且可能进入预览的玩家维护射线状态。每 tick 比较玩家视角角度，角度变化时立即刷新；整体轮廓下视角不变时每 2 tick 刷新运动装配体目标，方块预览则每 tick 刷新以保证准星响应。同一 tick 的攻击、使用与预览共享正/负命中结果。
- 潜行攻击或使用发生时必须立即重做一次射线并重新验证玩家状态、潜行状态、5 格距离、装配体有效性、`assembly id + local block key` 以及世界方块遮挡，不能直接消费上一物理 step 的目标。Stage 0 验证通过后只执行 `console.error`，不进入任何编辑事务。
- 轮廓使用随装配体局部坐标系旋转的专用实体，不使用粒子拼边。完整或局部装配体轮廓的边数据参考 EdgeRender，通过限定玩家的 `playAnimation()` 一次性写入客户端变量；频繁移动的单格 AABB 仅覆盖目标格坐标和相邻放置方向，由客户端生成固定 12 条边，不逐边传输轮廓数据。
- Stage 0 的边界是输入隔离、目标检测与视觉反馈。方块增删、物品消耗、掉落、物理重建、持久化、结算暂停和通用方块视觉注册表均留到后续阶段，不在当前实现中预埋兼容分支。

以下内容作为技术来源的目录参考，不作为设计依据

- 早期装配体编辑构想中的输入优先级、命中数据契约、真实入射面法线、射线 broad phase、世界方块遮挡、专用轮廓实体和阶段边界；仅作为技术证据，文中的旧交互与实体数量方案不沿用：
  - `docs/TreePhysics/design/sub-chunk.md`
- Script API 能力与当前依赖版本：
  - `package.json`
  - `node_modules/@minecraft/server/index.d.ts`：`Player.setPropertyOverrideForEntity()`、`clearPropertyOverridesForEntity()`、`removePropertyOverrideForEntity()`、`WorldAfterEvents.playerButtonInput`、`playerSwingStart`、`EntityRideableComponent`。
- 现有玩家交互与射线入口：
  - `src/TreePhysics/gameplay/tree-player-interaction.ts`
  - `src/TreePhysics/physics.ts`
  - `src/TreePhysics/physics/types.ts`
- 现有物理 step、装配体局部格索引与局部范围查询：
  - `src/TreePhysics/physics.ts`
  - `src/TreePhysics/physics/assembly-collider-index.ts`
- 树木部位语义从捕获到装配体方块的传递路径：
  - `src/TreePhysics/tree/blocks.ts`
  - `src/TreePhysics/tree/assembly-block.ts`
  - `src/TreePhysics/tree/assembly-visual.ts`
  - `src/TreePhysics/tree/fragment-layout.ts`
- fragment 与一方块一实体视觉链路、稳定视觉锚点、休眠写入抑制和 collector 容量：
  - `src/TreePhysics/physics/assembly-visual-renderer.ts`
  - `src/TreePhysics/physics.ts`
  - `packs/TreePhysics/TreePhysicsBP/entities/tree_physics/physics_block_collector.json`
  - `packs/TreePhysics/TreePhysicsBP/entities/tree_physics/physics_fragment_collector.json`
- 现有视觉实体登记、`entityLoad` 清理和有界残留实体校正链路：
  - `src/TreePhysics/main.ts`
  - `src/TreePhysics/gameplay/fallen-tree-lifecycle.ts`
  - `src/TreePhysics/physics/assembly-visual-renderer.ts`
- 现有客户端属性打包、旋转同步与资源生成模式：
  - `packs/TreePhysics/TreePhysicsBP/entities/tree_physics/tree_log_fragment.json`
  - `packs/TreePhysics/TreePhysicsRP/entity/tree_physics/tree_log_fragment.json`
  - `scripts/TreePhysics/generators/tree-fragments.mjs`
  - `scripts/TreePhysics/build.mjs`
- EdgeRender 的剪影边判定、12 边几何、玩家定向显示和穿墙自发光材质：
  - `sample/EdgeRender-main/src/behavior_pack/scripts/main.ts`
  - `sample/EdgeRender-main/src/behavior_pack/entities/edge_render_selected.json`
  - `sample/EdgeRender-main/src/resource_pack/entity/edge_render_selected.entity.json`
  - `sample/EdgeRender-main/src/resource_pack/models/entity/edge_render_selected.geo.json`
  - `sample/EdgeRender-main/src/resource_pack/render_controllers/edge_render_selected.render_controllers.json`
  - `sample/EdgeRender-main/src/resource_pack/materials/entity.material`
- 客户端生命周期透明度和混合材质参考：
  - `sample/entity-tint/rp0/render_controllers/oreville/entity/checkpoint.json`
  - `sample/entity-tint/rp0/render_controllers/oreville/entity/spawn_chunk_glow.json`
  - `sample/entity-tint/rp0/materials/entity.material`
  - `packs/TreePhysics/TreePhysicsRP/materials/entity.material`

# 阶段 0：潜行交互与装配体轮廓
