# Tree Physics Performance Remediation

## Scope

This document records the implementation that followed the 2026-07-17 performance audit. The
changes preserve log and attachment physics, current-tick world-block authority, tree selection,
damage, interaction, rendering and the per-block visual fallback. Leaf contact may be grouped by the
quality profile selected at assembly construction, with complete leaf coverage within 20 ticks.

## Implemented Packages

### Trigger-only leaf representation

- Assembly leaves no longer create Cannon compound shapes.
- Logs and attachments retain their existing colliders and material response.
- Logical leaf mass, center of mass, inertia, visual blocks and decay remain present.
- Every profile uses a fixed contact budget selected at assembly construction. The budget is at
  least `ceil(leafCount / 20)`, so all remaining leaves are checked within 20 ticks.
- Exact quality still means one break group and buoyancy point per leaf. Lower profiles preserve
  connected break groups and aggregate leaf buoyancy by volume-weighted centers.
- The previous sensor-box construction and sensor-count fallback to exact were removed.

### Logical environment coverage

- Each body now keeps a separate environment collider. Cannon simulation uses the reduced solid
  collider, while sleep verification, nearby wake events, AABB consumers and cross-domain safety
  retain the complete logical tree range.
- Sleeping environment signatures scan the sparse union of logical shapes instead of the complete
  expanded tree AABB.
- Support checks use `(step + bodyId) % interval`, preventing sleeping trees from checking support
  on the same tick.
- Every scheduled verification still calls `Dimension.getBlock()`. No cross-tick coordinate-content
  cache, voxel string set or collider string-signature shortcut was introduced.

### Partitioned persistence

- Persistence stores one immutable/mutation-time structure record and one small dynamic state
  record per tree, plus a small tree-ID manifest. Unpublished whole-save data is not migrated.
- Active and sleeping trees write on a body-ID-staggered schedule with a maximum 20-tick delay.
- Structure data is rewritten only for registration or an actual assembly block change.
- Additions publish records before the manifest; deletions leave the manifest before record cleanup.
- Multi-tree lifecycle ticks perform one manifest decision rather than a save inside each tree loop.

### Mutation and settlement

- Unsupported-leaf discovery starts from components adjacent to the current removal instead of
  traversing every remaining leaf from every log.
- Leaf-only mutation does not call `setCollider()` on the Cannon body. It still refreshes logical
  environment coverage, mass, center of mass, inertia and buoyancy.
- Final settlement records `pendingSettlement` and a cursor before work starts. `system.runJob()`
  spreads block drops and bee spawning across at most 20 ticks, with synchronous fallback if jobs
  are unavailable.
- Spawned settlement items and bees receive deterministic tags. Recovery checks those tags before
  replaying an incompletely checkpointed operation.

Bedrock does not provide a transaction spanning dynamic properties, item entities and player
inventories. If the server crashes after a tagged item is picked up but before its cursor is saved,
strict mathematical exactly-once delivery is impossible. Normal execution and recovery while the
tagged entity still exists are deduplicated.

## Benchmark Results

Node/Vitest measurements establish relative algorithmic cost; they are not direct Bedrock TPS.

| Scenario | Audit baseline | Remediated result |
| --- | ---: | ---: |
| 408-block production tree shapes | 76 | 13 |
| 408-block active world queries | 2009 | 669 |
| 408-block grounded physics mean | 0.6645 ms former sensor run | 0.1047 ms production |
| 408-block water physics mean | 0.9170 ms former sensor run | 0.2035 ms production |
| 980-block sleeping tree maximum queries | 5577 | 2996 |
| 10 sleeping 980-block trees maximum queries | 8967 | 2996 |
| 10 active 980-block lifecycle P99 | 15.23 ms | 1.10 ms |

The production high-quality leaf path is approximately 6.3 times faster than the former sensor
grounded fixture and 4.5 times faster in the water fixture. Fragment visual synchronization remains
outside the server bottleneck identified by the supplied game trace.

## Remaining Work

No further broad optimization is justified before a new Bedrock profiler capture. Possible work is
limited to profiler-driven constant-factor tuning:

- reusable numeric buffers in active world scanning;
- stable static-collider body reuse if collider rebuild time remains material;
- giant-tree selection creation spikes;
- long-session pruning of impact and artificial-tree registries.

These must not replace live `getBlock()` reads, reduce log/attachment physics, change tree ownership,
or reintroduce a feature-shape rejection path.

## In-Game Validation

Use a release build and disable debug drawing for the performance pass:

```text
/scriptevent tree_physics:tree_perf_debug on
/scriptevent tree_physics:lifecycle_perf on
/script profiler start
```

Capture one, five and ten active trees; include one fancy oak, one water case, sleep, wake, a large
leaf-break batch and final settlement. The expected fancy-oak assembly line should report a high or
lower fixed profile and a shape count close to the log/attachment collider count, not the old leaf
sensor count.
