# 项目结构与开发约定

## 运行时边界

`src/main.ts` 是玩法入口，负责 Bedrock 事件接线、树木识别、生命周期、交互和外部效果。
`src/physics.ts` 是独立物理入口，负责 Cannon 求解、碰撞、装配体状态和视觉同步。构建后分别
生成 `packs/TreePhysics/BP/scripts/main.js` 与 `packs/TreePhysics/BP/scripts/physics.js`。

`main.ts` 必须通过 `./physics.js` 使用物理入口。这个显式相对导入是 Bedrock 运行时的真实
模块边界，不应改成 `@src` 别名，也不应把 Cannon 内核重新打入 `main.js`。其余源码与测试
统一使用 `@src/*`，避免目录调整形成多层相对路径。

## 目录职责

```text
src/
  main.ts                 玩法包入口
  physics.ts              独立物理包入口
  gameplay/               事件驱动玩法、交互、外力与生命周期
  physics/                求解、碰撞、网格化和视觉同步
  tree/                   树块模型、fragment、叶片质量与染色
  data/                   运行时数据访问
    generated/            生成数据，禁止手工修改
  persistence/            动态属性存储与事务基础设施
scripts/
  build.mjs               双入口构建
  generators/             资源和数据生成器
  packaging/              最终包命名映射
  verification/           构建产物边界验证
tests/
  benchmarks/             性能基准
  data|gameplay|physics|persistence|resources|tree/
docs/
  acceptance|design|development|history|implementation|performance/
packs/
  TreePhysics/BP|RP/      最终行为包与资源包
sample/                   外部参考资料与子模块，不参与构建
archive/                  已冻结历史实现，不参与当前开发
```

`src/` 与生成器模板仍使用 `physics_api` 作为内部源码标识；`npm run finalize:pack` 只在
`packs/TreePhysics` 内将其映射为最终的 `tree_physics` 命名。最终包路径和内容禁止出现
`physics_api`，源码目录则不能反向混入最终包命名。项目尚未发布，不保留旧动态属性格式。

## 生成文件

`src/data/generated/` 中的 TypeScript 文件以及 `packs/` 内标记为生成结果的资源都应由
`scripts/generators/` 更新。日常构建会运行 `npm run generate:data`；较大的碰撞参考表固定到
指定上游 commit 和 SHA-256，仅在来源升级时运行 `npm run generate:collision-data`。

生成文件中的来源名（例如 Sable）表示算法或标定数据的可追溯来源，不是当前系统模块名。
生产接口使用职责名称，例如 `BLOCK_PHYSICS_PROPERTIES`。

## 常用命令

```powershell
npm run check
npm test
npm run build
npm run bench:physics
npm run generate:collision-data
```

提交前至少运行 `npm test`。它会重新生成日常数据、执行 TypeScript 检查和 Vitest，并验证
正式构建产物边界。性能相关改动还应运行 `npm run bench:physics`，实机 FPS/TPS
结果按 `docs/acceptance/first-version.md` 验收。
