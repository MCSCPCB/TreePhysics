# Tree Physics Full Performance Regression Audit

> Pre-remediation baseline. The P0/P1 packages identified here were implemented on 2026-07-18;
> see `performance-remediation-2026-07-18.md` for the current design and results.

## Status

- Audit date: 2026-07-17.
- Source baseline: commit `6855b2964ed83375babd914cf3d7066510544225` plus the current
  fragment, leaf-quality and diagnostic worktree changes.
- Host: Intel Core i7-12700H, Node 22.14.0, Vitest 4.1.9, Windows x64.
- Game evidence: the supplied Bedrock fancy-oak trace from assembly creation through sleep.
- Code evidence: paired `cannon-es-physics-2` benchmarks, current project benchmarks, new
  large-tree hotpath benchmarks, source-level API-call and complexity audit.

This audit does not treat Node time as Bedrock TPS. Node benchmarks establish relative algorithmic
cost and scaling. The supplied in-game timing is authoritative for Bedrock host/API cost.

## Executive Conclusion

The general Cannon backend has not suffered a large regression. In a paired run, the current
1/10/32-body primitive scenarios were about 5-6% slower than archived `cannon-es-physics-2`, with
the 32-body current P99 still only 3.35 ms. This is not the cause of the fancy-oak TPS drop.

The tree-specific path still contains four large, worthwhile optimization packages:

1. trigger-only leaf sensors and exact leaf buoyancy still expand the Cannon/world-scan workload;
2. sleeping environment verification scans the whole body AABB and can query thousands of blocks;
3. persistence rewrites large duplicated whole-tree JSON records every 20 ticks;
4. leaf breaking, final settlement and world-fragile drops still perform synchronous rebuild/loot
   bursts, and the planned recoverable `runJob` path is not implemented.

Therefore the project has not reached the point where only small constant-factor optimizations
remain. Fragment rendering is already converged; the remaining large gains are in physics and
lifecycle data flow.

## Non-Negotiable Audit Boundaries

- Log and attachment collider, mass, center of mass, inertia, buoyancy, interaction, damage and
  loot semantics must not degrade.
- Active world collision continues to use current-tick `getBlock()` as the source of truth.
- No cross-tick world-coordinate cache may become the correctness source.
- Leaf quality may be fixed at assembly construction and may trade leaf contact latency/grouping,
  with a strict maximum coverage delay of 20 ticks.
- Persistence and deferred settlement must remain recoverable and exactly-once.
- The per-block renderer remains unchanged for unregistered content.
- Target long-running game performance remains approximately 15-20 TPS.

## Evidence Summary

### In-game fancy oak

The measured 408-block tree used 10 fragment entities but 77 initial physics shapes and selected
`p=exact`.

| Phase | Physics ms | World scan ms | Cannon ms | Visual ms | Queries | Shapes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| First active sample | 148 | 40 | 108 | 0 | 2091 | 75 |
| Active range | 53-112 | 18-46 | 25-72 | 0-1 | 983-1942 | 30-68 |
| Sleeping sample | 12 | 11 | 1 | 0 | 331 | 30 |

This proves:

- fragment transform synchronization is not the server TPS bottleneck;
- active world scanning is a major hotspot;
- Cannon contact/narrowphase work is an equal or larger hotspot;
- supplemental buoyancy queries were zero in this land test;
- sleep removes the continuous hotspot, but its periodic scan still costs 11 ms for this reduced
  68-block remainder.

The reported `ms` ends before `FallenTreeLifecycle.tick()`, so lifecycle probes, block deletion,
loot, persistence and settlement add further unreported game-tick cost.

### Paired archived-kernel comparison

The paired run loaded current and archived primitive benchmarks in the same process.

| Scenario | Archived mean | Current mean | Mean delta | Archived P99 | Current P99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 body / 1 shape | 0.0473 ms | 0.0498 ms | +5.3% | 0.0996 ms | 0.1095 ms |
| 10 bodies / 13 shapes | 0.6675 ms | 0.7078 ms | +6.0% | 1.1193 ms | 1.1739 ms |
| 32 bodies / 44 shapes | 2.4625 ms | 2.6203 ms | +6.4% | 3.3268 ms | 3.3534 ms |

The small delta is compatible with the added collision events, fluid support and diagnostics. It
does not justify reducing core solver quality and is far below the 50 ms budget.

### New 408-block hotpath benchmark

The synthetic fixture intentionally matches the measured fancy oak at 408 total blocks and 24 logs.
It produces 384 leaves, 63 exact leaf boxes and 76 total current shapes. The automatic quality plan
returns `exact`, reproducing the same fallback class as the game trace.

| Grounded candidate | Shapes | Queries | Mean | Relative to current |
| --- | ---: | ---: | ---: | ---: |
| Current exact leaf sensors | 76 | 2009 | 0.4618 ms | 1.00x |
| No leaf Cannon shapes, exact leaf buoyancy | 13 | 844 | 0.1977 ms | 2.34x faster |
| No leaf Cannon shapes, aggregated leaf buoyancy | 13 | 652 | 0.0659 ms | 7.01x faster |

The last candidate is an upper bound because the final implementation must add fixed-budget leaf
contact probes. Even after adding those probes, it removes 63 Cannon sensor shapes, most predicted
scan coverage, and per-tick traversal of hundreds of exact leaf buoyancy points.

The equivalent water benchmark changed from 76 shapes / 2005 queries / 0.5239 ms to 13 shapes /
727 queries / 0.1191 ms, a 4.48x Node improvement. This confirms that exact leaf buoyancy is a
separate large-tree cost once fluid surfaces exist.

### Construction, selection and mutation

| Operation | Mean | P99 | Direct world calls represented by fixture |
| --- | ---: | ---: | ---: |
| Fancy-scale selection | 7.84 ms | 8.95 ms | 1056 `getBlock()` |
| Giant-scale selection, 980 blocks | 19.41 ms | 20.40 ms | 1980 `getBlock()` |
| 80 connected trees ownership scan | 2.26 ms | 3.20 ms | 1714 `getBlock()` |
| Fancy collider mesh | 2.83 ms | 3.75 ms | no Bedrock API |
| Fancy fragment packing | 0.32 ms | 1.07 ms | no Bedrock API |
| Fancy leaf-quality plan | 1.08 ms | 1.61 ms | no Bedrock API |
| Create/remove fancy assembly | 4.48 ms | 5.97 ms | mocked entity API |
| Create and batch-remove 64 fancy leaves | 8.33 ms | 9.39 ms | mocked entity API |
| Integrated register/tick fancy lifecycle | 10.65 ms | 19.18 ms | empty mocked loot |
| Integrated register/break 64 leaves/tick | 17.06 ms | 21.93 ms | empty mocked loot |
| Create/remove giant assembly | 7.86 ms | 8.81 ms | mocked entity API |
| Create and batch-remove 256 giant leaves | 13.08 ms | 18.46 ms | mocked entity API |

Selection is synchronous in `beforeEvents.playerBreakBlock`. Assembly removal then validates each
selected block once and calls `setType("minecraft:air")` once per live block. These are one-tick
creation spikes rather than continuous TPS costs, but a giant tree can already consume about 19 ms
of Node CPU before real Bedrock block access, block mutation, entity spawning and persistence.

### Sleeping verification

The 980-block synthetic giant tree has only 57 active shapes, but its sleeping environment check
uses the whole expanded body AABB.

| Scenario | Maximum queries in a sampled tick | Node mean | Node P99 |
| --- | ---: | ---: | ---: |
| 1 large sleeping tree | 5577 | 0.032 ms | 0.42 ms |
| 10 large sleeping trees | 8967 | 0.285 ms | 1.45 ms |

Node `getBlock()` is a local mock, so the query count is the meaningful metric. The supplied game
trace needed 11 ms for only 331 sleeping queries. A large tree that retains its canopy can therefore
produce a severe periodic Bedrock spike even though average Node time looks small.

Environment scans are offset by body ID every 20 ticks. Support scans run for every sleeping body
on the same 10-tick phase and should be staggered as well.

### Lifecycle and persistence

Current serialized records duplicate block runtime data, captured snapshots and leaf metadata.

| Active saved trees | Stored payload | Lifecycle P99 | Maximum observed Node sample |
| --- | ---: | ---: | ---: |
| 1 x 408 blocks | 126 KB | 0.56 ms | 3.63 ms |
| 10 x 408 blocks | 1.26 MB | 5.91 ms | 8.66 ms |
| 1 x 980 blocks | 302 KB | 1.43 ms | 10.73 ms |
| 10 x 980 blocks | 3.02 MB | 13.29 ms | 20.09 ms |

These numbers use an in-memory dynamic-property mock. A 3.02 MB save uses about 101 30KB chunks.
Replacing one generation can perform about 101 new chunk writes, one manifest write and 101 old
chunk deletions. Real Bedrock dynamic-property calls will cost more than the mock.

The general 10-tree lifecycle without large payloads remains small (about 0.15-0.16 ms mean and
0.63 ms P99). Entity candidate processing is not a Node CPU hotspot. Real `Dimension.getEntities()`
cost remains host-dependent.

## Findings by Priority

### P0: leaf quality controls the wrong backend representation

The current quality selector first tries a lower profile, but returns to exact whenever grouped
sensor boxes are not fewer than the globally meshed exact boxes. Both the measured fancy oak and
the 980-block benchmark therefore remain exact. This guard correctly prevents the old
"fewer groups, more boxes" regression, but it also makes the quality ladder ineffective for common
sparse/dense large canopies.

Shape count alone is not the real cost. The model omits swept scan volume, buoyancy-point traversal,
world collider count, contact events and three Cannon substeps.

Required correction:

- remove trigger-only assembly leaves from the Cannon compound collider;
- keep every logical leaf in rendering, mass, center-of-mass and inertia accounting;
- preserve exact log/attachment colliders;
- make the fixed construction profile control leaf contact groups, probe rate and leaf buoyancy
  points;
- select from estimated scan/probe work, not only sensor box count;
- keep total leaf-group coverage at or below 20 ticks.

This single change attacks both measured `ws` and `cs`. It is higher value than tuning current
profile thresholds.

### P0: active tree work is queried twice through different mechanisms

An exact tree uses Cannon leaf sensors and also runs lifecycle fallback probes. Per active tree the
current upper bounds are:

- 64 assembly fragile-point `getBlock()` probes;
- 64 world-fragile probes with current and predicted positions, up to 128 `getBlock()` calls;
- one merged `Dimension.getEntities()` damage query per disjoint active cluster;
- cross-domain chunk readability probes.

These calls occur after the reported physics `ms` and are not included in `q`. The leaf-sensor
redesign should make one fixed-budget probe system authoritative instead of paying for both Cannon
sensors and fallback sampling.

### P1: sleeping AABB scans have large sparse-volume amplification

`scanSleepingEnvironment()` iterates the whole expanded Cannon AABB. A 57-shape giant tree reached
5577 queries in one sleeping tick. A shape/logical-group sparse coverage can preserve the 20-tick
environment-change guarantee without scanning canopy holes.

When leaf shapes leave Cannon, sleep/wake and cross-domain bounds must continue to use a separate
logical assembly bound. It is not correct to let the body collider AABB silently become the tree's
gameplay bound.

Required correction:

- retain logical tree bounds independent of the solid Cannon collider;
- verify sleeping collision/probe coverage rather than the full hull;
- offset support scans with `(step + bodyId) % interval`;
- continue reading current world blocks on every scheduled verification.

### P1: persistence is whole-save rather than per-tree/delta based

The current global save serializes all saved trees and writes a new generation. `sleepTicks` changes
every sleeping tick, so sleeping trees remain dirty at every 20-tick checkpoint. Registration,
settlement, deferral and restoration can also call `#writeSave()` repeatedly inside multi-tree loops.

Required correction without weakening recovery:

- store immutable tree structure separately from frequently changing pose/timer state;
- use atomic per-tree generations plus a small manifest;
- update only dirty tree records;
- stagger dirty-tree writes while keeping the current maximum 20-tick persistence delay;
- batch one manifest/save commit after multi-tree settlement rather than once per tree.

### P1: break and settlement work still forms synchronous bursts

Every leaf break batch performs a whole-tree unsupported-leaf traversal and rebuilds the visual
representation, collider, mass, center of mass, inertia and buoyancy data. Batching already prevents
multiple rebuilds within one tree tick, but the support graph is still recomputed over all remaining
leaves.

Final settlement loops every remaining block and synchronously calls LootTable generation and item
spawn. World-fragile blocks also schedule one callback, loot operation, mutation and sound per
block. No production `system.runJob()` call exists.

Required correction:

- maintain incremental leaf/attachment support adjacency;
- leaf-only removal must not rebuild a Cannon leaf collider after sensors are removed;
- maintain incremental mass sums while preserving the exact logical inertia result;
- batch world-break sounds;
- implement the documented recoverable pending settlement/drop queue;
- complete all deferred work within 20 ticks and fall back synchronously at the boundary;
- write persistence once after a settlement batch.

### P2: active world scan still allocates heavily

The scan creates bounds, clusters, coverage rows, location objects, maps, sets, dense mesher arrays
and sorted collider layouts every active tick. A full-block mesher allocates dense voxel and group
arrays for each encountered material over the cluster AABB, even for sparse coverage. Neighbor-
dependent block shapes can issue extra `dimension.getBlock()` calls that are not included in `q`.

After removing leaf coverage, reassess this path before changing it. Safe candidates are reusable
numeric buffers/location objects, counted neighbor queries and stable per-cluster collider-body
reuse. Cross-tick block-content caching and string coordinate/signature sets remain prohibited.

### P2: synchronous tree creation can exceed one tick on giant trees

The giant selection fixture costs 19.18 ms in Node and 1980 `getBlock()` calls. The after-event then
validates and removes up to 980 blocks, builds the assembly, writes fragment properties and saves a
roughly 302 KB record. This is likely a visible one-tick hitch in Bedrock.

The scan cannot simply move to `runJob()` because the before/after break transaction needs an
immediate decision. Optimize data structures and avoid duplicate derived work first. Do not re-add
feature-shape rejection rules that can prevent valid original trees from assembling.

### P3: bounded or accepted costs

- Fragment rendering: 408-block packing is about 0.30 ms in Node; the game trace reports 0-1 ms
  transform sync for 8-10 entities. No large server optimization remains here.
- General Cannon kernel: the paired regression is only 5-6% and remains far under budget.
- Player punch/drag: raycasts are event-driven; sustained drag is proportional only to active drag
  sessions and runs one force update per substep.
- Artificial-tree persistence: placement-time chunk-set serialization can grow, but it has no
  per-tick cost. It is a lower priority than physics/persistence hotpaths.
- Per-block visual fallback: it can be expensive for large unregistered custom trees, but preserving
  it unchanged is an explicit compatibility requirement and original registered trees do not use it.
- Debug draw: the measured trace had `d=0`; release output disables it.

## Minor Long-Session Risks

- `lastImpactTickByBody` in `main.ts` is not pruned when assemblies are removed; it can grow with the
  number of trees processed during a long server session.
- `ArtificialTreeRegistry` retains every loaded chunk record, including empty sets, for the session.
- Empty configured physics dimensions remain scheduled after their last assembly is removed. There
  are normally only three vanilla dimensions, so this is not a meaningful TPS issue.

These are cleanup tasks, not large performance work.

## Recommended Implementation Order

1. Replace Cannon leaf sensors with fixed-budget leaf contact probes and aggregate leaf buoyancy.
2. Add independent logical bounds and sparse/staggered sleeping verification.
3. Split persistence into immutable structure plus per-tree dynamic records and batch commits.
4. Add incremental support/mass bookkeeping and the recoverable 20-tick drop/settlement queue.
5. Re-run the in-game 1/5/10 tree matrix, then optimize world-scan allocations/collider reuse only
   where the profiler still shows material gain.
6. Revisit synchronous selection/creation only after continuous physics and lifecycle stay within
   the 15-20 TPS target.

After these packages, a new profiler pass can legitimately determine whether the remaining work is
only small constant-factor tuning or unavoidable Bedrock/Cannon cost. The current version does not
meet that completion condition.

## Reproduction

```text
npm test
npm run bench:physics -- --reporter=verbose
```

Paired archived kernel comparison:

```text
npx vitest bench --run tests/primitive-collider.bench.ts --reporter=verbose
```

Game diagnostics:

```text
/scriptevent tree_physics:tree_perf_debug on
/scriptevent tree_physics:lifecycle_perf on
/script profiler start
```

Disable all diagnostics after capture. The default-off diagnostic paths are not part of normal
runtime cost beyond their existing boolean checks and metric counters.
