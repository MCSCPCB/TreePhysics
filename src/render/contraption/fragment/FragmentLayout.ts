import type { Vector3 } from "@minecraft/server";
import { blockKey } from "@src/utils/BlockKey";
import type { PhysicsContraptionBlock } from "@src/physics/core/Types";
import {
  TREE_ATTACHMENT_FRAGMENT_FAMILIES,
  TREE_FRAGMENT_FAMILIES
} from "@src/render/contraption/fragment/FragmentVisual";

export const LOG_FRAGMENT_ENTITY_TYPE_ID = "treephysics:log_fragment";
export const TALL_LOG_FRAGMENT_ENTITY_TYPE_ID = "treephysics:tall_log_fragment";
export const LEAF_FRAGMENT_ENTITY_TYPE_ID = "treephysics:leaf_fragment";
export const COMPACT_LEAF_FRAGMENT_ENTITY_TYPE_ID =
  "treephysics:compact_leaf_fragment";
export const ATTACHMENT_FRAGMENT_ENTITY_TYPE_ID = "treephysics:attachment_fragment";
export const CUBE_FRAGMENT_ENTITY_TYPE_ID = "treephysics:cube_fragment_0";
// Dense cube slots reserve one bit for runtime state such as an open chest lid.
// Twenty-five 24-bit words therefore carry six 4-bit slots each.
export const CUBE_BLOCK_FRAGMENT_SLOT_COUNT = 150;
// Sparse cube fragments spend one whole entity property word per slot; 26 slot
// words plus the six shared pose/mode properties fill the 32-property budget.
export const CUBE_BLOCK_SPARSE_FRAGMENT_SLOT_COUNT = 26;
export const CUBE_BLOCK_SPARSE_FRAGMENT_SIZE = 64;
export const CUBE_BLOCK_FRAGMENT_STATE_BITS = 4;
export const CUBE_BLOCK_FRAGMENT_SLOTS_PER_WORD = 6;
export const TREE_FRAGMENT_WIDTH = 7;
export const TREE_FRAGMENT_HEIGHT = 4;
export const TREE_FRAGMENT_DEPTH = 7;
export const TREE_FRAGMENT_SLOT_COUNT =
  TREE_FRAGMENT_WIDTH * TREE_FRAGMENT_HEIGHT * TREE_FRAGMENT_DEPTH;
export const TREE_FRAGMENT_STATE_BITS = 3;
export const TREE_FRAGMENT_SLOTS_PER_WORD = 8;
export const CUBE_BLOCK_FRAGMENT_WORD_COUNT = Math.ceil(
  CUBE_BLOCK_FRAGMENT_SLOT_COUNT / CUBE_BLOCK_FRAGMENT_SLOTS_PER_WORD
);
export const CUBE_BLOCK_FRAGMENT_PROPERTY_WORD_COUNT = Math.max(
  CUBE_BLOCK_FRAGMENT_WORD_COUNT,
  CUBE_BLOCK_SPARSE_FRAGMENT_SLOT_COUNT
);
export const TREE_FRAGMENT_WORD_COUNT = Math.ceil(
  TREE_FRAGMENT_SLOT_COUNT / TREE_FRAGMENT_SLOTS_PER_WORD
);
export const TREE_TALL_FRAGMENT_WIDTH = 5;
export const TREE_TALL_FRAGMENT_HEIGHT = 10;
export const TREE_TALL_FRAGMENT_DEPTH = 4;
export const TREE_TALL_FRAGMENT_SLOT_COUNT =
  TREE_TALL_FRAGMENT_WIDTH * TREE_TALL_FRAGMENT_HEIGHT * TREE_TALL_FRAGMENT_DEPTH;
export const TREE_TALL_FRAGMENT_WORD_COUNT = Math.ceil(
  TREE_TALL_FRAGMENT_SLOT_COUNT / TREE_FRAGMENT_SLOTS_PER_WORD
);
export const TREE_LEAF_FRAGMENT_WIDTH = 7;
export const TREE_LEAF_FRAGMENT_HEIGHT = 5;
export const TREE_LEAF_FRAGMENT_DEPTH = 7;
export const TREE_LEAF_FRAGMENT_SLOT_COUNT =
  TREE_LEAF_FRAGMENT_WIDTH * TREE_LEAF_FRAGMENT_HEIGHT * TREE_LEAF_FRAGMENT_DEPTH;
export const TREE_LEAF_FRAGMENT_STATE_BITS = 1;
export const TREE_LEAF_FRAGMENT_SLOTS_PER_WORD = 24;
export const TREE_LEAF_FRAGMENT_WORD_COUNT = Math.ceil(
  TREE_LEAF_FRAGMENT_SLOT_COUNT / TREE_LEAF_FRAGMENT_SLOTS_PER_WORD
);
export const TREE_COMPACT_LEAF_FRAGMENT_WIDTH = 6;
export const TREE_COMPACT_LEAF_FRAGMENT_HEIGHT = 5;
export const TREE_COMPACT_LEAF_FRAGMENT_DEPTH = 6;
export const TREE_COMPACT_LEAF_FRAGMENT_SLOT_COUNT =
  TREE_COMPACT_LEAF_FRAGMENT_WIDTH
  * TREE_COMPACT_LEAF_FRAGMENT_HEIGHT
  * TREE_COMPACT_LEAF_FRAGMENT_DEPTH;
export const TREE_COMPACT_LEAF_FRAGMENT_WORD_COUNT = Math.ceil(
  TREE_COMPACT_LEAF_FRAGMENT_SLOT_COUNT / TREE_LEAF_FRAGMENT_SLOTS_PER_WORD
);
// One descriptor word per attachment slot; 26 slot words plus the six shared
// pose/tint properties fill the 32-entity-property budget.
export const TREE_ATTACHMENT_FRAGMENT_SLOT_COUNT = 26;
export const TREE_FRAGMENT_ORIGIN_BIAS = 1024;
export const TREE_FRAGMENT_ORIGIN_SIZE = 2048;
// packAttachmentOriginY stacks one occupancy bit per attachment family above
// the packed origin, so anything packed higher starts at 2 ** family-count.
export const ATTACHMENT_FAMILY_MASK_SIZE =
  2 ** TREE_ATTACHMENT_FRAGMENT_FAMILIES.length; // = 2 ** 9 = 512

export interface FragmentSlotAssignment {
  bitCount: number;
  blockKey: string;
  shift: number;
  slot: number;
  word: number;
}

export interface PackedFragment {
  allBark: boolean;
  anchorLocalLocation: Vector3;
  assignments: readonly FragmentSlotAssignment[];
  blockCount: number;
  entityTypeId:
    | typeof LOG_FRAGMENT_ENTITY_TYPE_ID
    | typeof TALL_LOG_FRAGMENT_ENTITY_TYPE_ID
    | typeof LEAF_FRAGMENT_ENTITY_TYPE_ID
    | typeof COMPACT_LEAF_FRAGMENT_ENTITY_TYPE_ID
    | typeof ATTACHMENT_FRAGMENT_ENTITY_TYPE_ID
    | typeof CUBE_FRAGMENT_ENTITY_TYPE_ID;
  family: number;
  cubeLayout?: CubeBlockFragmentLayout;
  words: readonly number[];
}

export interface CubeBlockFragmentLayout {
  readonly depth: number;
  readonly format: "dense" | "sparse";
  readonly height: number;
  readonly width: number;
}

export interface CubeBlockFragmentSlot {
  readonly assignment: FragmentSlotAssignment;
  readonly state: number;
}

export function packFragments(
  blocks: readonly PhysicsContraptionBlock[]
): PackedFragment[] | undefined {
  if (blocks.length === 0 || blocks.some(block => !isSupportedVisual(block))) return undefined;

  const voxelGroups = new Map<string, PhysicsContraptionBlock[]>();
  const leafGroups = new Map<string, PhysicsContraptionBlock[]>();
  const attachmentBlocks: PhysicsContraptionBlock[] = [];
  const cubeBlocks: PhysicsContraptionBlock[] = [];
  const result: PackedFragment[] = [];
  for (const block of blocks) {
    const visual = block.visual!;
    if (visual.renderer === "attachment_fragment") {
      attachmentBlocks.push(block);
      continue;
    }
    if (visual.renderer === "cube_block_fragment") {
      cubeBlocks.push(block);
      continue;
    }
    if (visual.renderer === "leaf_fragment") {
      const groupKey = String(visual.family);
      const group = leafGroups.get(groupKey);
      if (group) group.push(block);
      else leafGroups.set(groupKey, [block]);
      continue;
    }
    const groupKey = `${visual.family}:${visual.allBark}`;
    const group = voxelGroups.get(groupKey);
    if (group) group.push(block);
    else voxelGroups.set(groupKey, [block]);
  }

  for (const group of voxelGroups.values()) result.push(...packLogVoxelGroup(group));
  for (const group of leafGroups.values()) result.push(...packLeafVoxelGroup(group));
  result.push(...packAttachmentBlocks(attachmentBlocks));
  result.push(...packCubeBlocks(cubeBlocks));
  if (result.some(fragment => !isEncodableOrigin(fragment.anchorLocalLocation))) return undefined;
  result.sort(compareFragments);
  return result;
}

function packCubeBlocks(blocks: readonly PhysicsContraptionBlock[]): PackedFragment[] {
  if (blocks.length === 0) return [];
  const dense = bestPackedCubeLayout(blocks);
  const sparse = packSparseCubeBlocks(blocks);
  if (sparse.length < dense.length) return sparse;
  return dense;
}

const CUBE_DENSE_LAYOUTS: readonly CubeBlockFragmentLayout[] = createCubeDenseLayouts();

function createCubeDenseLayouts(): readonly CubeBlockFragmentLayout[] {
  const layouts: CubeBlockFragmentLayout[] = [];
  for (let width = 1; width <= CUBE_BLOCK_FRAGMENT_SLOT_COUNT; width++) {
    for (
      let height = 1;
      width * height <= CUBE_BLOCK_FRAGMENT_SLOT_COUNT;
      height++
    ) {
      const depth = Math.floor(CUBE_BLOCK_FRAGMENT_SLOT_COUNT / (width * height));
      // A smaller box is never useful when one axis can grow without exceeding
      // the same fixed geometry. Retain every non-dominated integer box, including
      // non-tree shapes such as 10x5x3 that a fixed candidate list would miss.
      if (
        (width + 1) * height * depth <= CUBE_BLOCK_FRAGMENT_SLOT_COUNT
        || width * (height + 1) * depth <= CUBE_BLOCK_FRAGMENT_SLOT_COUNT
      ) continue;
      layouts.push({ depth, format: "dense", height, width });
    }
  }
  return layouts;
}

function bestPackedCubeLayout(
  blocks: readonly PhysicsContraptionBlock[]
): PackedFragment[] {
  let best: PackedFragment[] | undefined;
  let bestExtent = Number.POSITIVE_INFINITY;
  let bestVolume = 0;
  for (const layout of CUBE_DENSE_LAYOUTS) {
    const packed = packDenseCubeBlocks(blocks, layout);
    const extent = Math.max(layout.width, layout.height, layout.depth);
    const volume = layout.width * layout.height * layout.depth;
    if (
      !best
      || packed.length < best.length
      || (packed.length === best.length && extent < bestExtent)
      || (
        packed.length === best.length
        && extent === bestExtent
        && volume > bestVolume
      )
    ) {
      best = packed;
      bestExtent = extent;
      bestVolume = volume;
    }
  }
  if (!best) throw new Error("Cube fragment layouts are not configured.");
  return best;
}

function packDenseCubeBlocks(
  blocks: readonly PhysicsContraptionBlock[],
  layout: CubeBlockFragmentLayout
): PackedFragment[] {
  const origin = {
    x: chooseCenteredAxisOrigin(blocks, "x", layout.width),
    y: chooseCenteredAxisOrigin(blocks, "y", layout.height),
    z: chooseCenteredAxisOrigin(blocks, "z", layout.depth)
  };
  const result: PackedFragment[] = [];
  for (const [anchorLocalLocation, bucket] of bucketBlocksByOrigin(
    blocks,
    origin,
    layout.width,
    layout.height,
    layout.depth
  )) {
    const words = new Array<number>(CUBE_BLOCK_FRAGMENT_WORD_COUNT).fill(0);
    const assignments: FragmentSlotAssignment[] = [];
    for (const block of bucket) {
      const packed = tryCreateCubeBlockFragmentSlot(
        block,
        anchorLocalLocation,
        layout,
        words
      );
      if (!packed) {
        throw new RangeError("Cube block was assigned outside its fragment bucket.");
      }
      const { assignment, state } = packed;
      words[assignment.word] = words[assignment.word]
        | (state * (2 ** assignment.shift));
      assignments.push(assignment);
    }
    assignments.sort((left, right) => left.slot - right.slot);
    result.push({
      allBark: false,
      anchorLocalLocation,
      assignments,
      blockCount: bucket.length,
      entityTypeId: CUBE_FRAGMENT_ENTITY_TYPE_ID,
      family: 0,
      cubeLayout: layout,
      words
    });
  }
  return result;
}

function packSparseCubeBlocks(
  blocks: readonly PhysicsContraptionBlock[]
): PackedFragment[] {
  const size = CUBE_BLOCK_SPARSE_FRAGMENT_SIZE;
  const origin = {
    x: chooseCenteredAxisOrigin(blocks, "x", size),
    y: chooseCenteredAxisOrigin(blocks, "y", size),
    z: chooseCenteredAxisOrigin(blocks, "z", size)
  };
  const layout: CubeBlockFragmentLayout = {
    depth: size,
    format: "sparse",
    height: size,
    width: size
  };
  const result: PackedFragment[] = [];
  for (const [anchorLocalLocation, bucket] of bucketBlocksByOrigin(
    blocks,
    origin,
    size,
    size,
    size
  )) {
    for (let start = 0; start < bucket.length; start += CUBE_BLOCK_SPARSE_FRAGMENT_SLOT_COUNT) {
      const words = new Array<number>(CUBE_BLOCK_SPARSE_FRAGMENT_SLOT_COUNT).fill(0);
      const assignments: FragmentSlotAssignment[] = [];
      const chunk = bucket.slice(start, start + CUBE_BLOCK_SPARSE_FRAGMENT_SLOT_COUNT);
      for (const block of chunk) {
        const packed = tryCreateCubeBlockFragmentSlot(
          block,
          anchorLocalLocation,
          layout,
          words
        );
        if (!packed) throw new RangeError("Sparse cube block was assigned outside its fragment.");
        words[packed.assignment.word] = packed.state;
        assignments.push(packed.assignment);
      }
      result.push({
        allBark: false,
        anchorLocalLocation,
        assignments,
        blockCount: chunk.length,
        cubeLayout: layout,
        entityTypeId: CUBE_FRAGMENT_ENTITY_TYPE_ID,
        family: 0,
        words
      });
    }
  }
  return result;
}

/** Resolve one ordinary cube block into an existing dense or sparse fragment. */
export function tryCreateCubeBlockFragmentSlot(
  block: PhysicsContraptionBlock,
  anchorLocalLocation: Vector3,
  layout: CubeBlockFragmentLayout,
  words: readonly number[],
  reservedSlots?: ReadonlySet<number>
): CubeBlockFragmentSlot | undefined {
  const visual = block.visual;
  if (visual?.renderer !== "cube_block_fragment") return undefined;
  const x = block.localLocation.x - anchorLocalLocation.x;
  const y = block.localLocation.y - anchorLocalLocation.y;
  const z = block.localLocation.z - anchorLocalLocation.z;
  if (
    !Number.isInteger(x) || x < 0 || x >= layout.width
    || !Number.isInteger(y) || y < 0 || y >= layout.height
    || !Number.isInteger(z) || z < 0 || z >= layout.depth
  ) return undefined;
  if (layout.format === "sparse") {
    const slot = words.findIndex((word, index) => (
      word === 0 && !reservedSlots?.has(index)
    ));
    if (slot < 0 || slot >= CUBE_BLOCK_SPARSE_FRAGMENT_SLOT_COUNT) return undefined;
    return {
      assignment: {
        bitCount: 24,
        blockKey: blockKey(block.localLocation),
        shift: 0,
        slot,
        word: slot
      },
      // Six state bits leave six bits for each coordinate inside the 64-cube region.
      state: visual.state + 1 + x * 64 + y * 4096 + z * 262144
    };
  }
  const slot = y * layout.width * layout.depth + z * layout.width + x;
  const word = Math.floor(slot / CUBE_BLOCK_FRAGMENT_SLOTS_PER_WORD);
  const shift = (slot % CUBE_BLOCK_FRAGMENT_SLOTS_PER_WORD) * CUBE_BLOCK_FRAGMENT_STATE_BITS;
  return {
    assignment: {
      bitCount: CUBE_BLOCK_FRAGMENT_STATE_BITS,
      blockKey: blockKey(block.localLocation),
      shift,
      slot,
      word
    },
    // Zero remains the empty-slot sentinel; the four directions occupy 1-4.
    state: visual.state + 1
  };
}

export function readCubeBlockFragmentSlot(
  words: readonly number[],
  assignment: FragmentSlotAssignment
): number {
  if (assignment.bitCount === 24) return (words[assignment.word] ?? 0) % 64;
  const place = 2 ** assignment.shift;
  return Math.floor((words[assignment.word] ?? 0) / place) % (2 ** assignment.bitCount);
}

function packAttachmentBlocks(blocks: readonly PhysicsContraptionBlock[]): PackedFragment[] {
  if (blocks.length === 0) return [];
  const origin = {
    x: chooseAxisOrigin(blocks, "x", TREE_FRAGMENT_WIDTH),
    y: chooseAxisOrigin(blocks, "y", TREE_FRAGMENT_HEIGHT),
    z: chooseAxisOrigin(blocks, "z", TREE_FRAGMENT_DEPTH)
  };
  const result: PackedFragment[] = [];
  for (const [anchorLocalLocation, bucket] of bucketBlocksByOrigin(
    blocks,
    origin,
    TREE_FRAGMENT_WIDTH,
    TREE_FRAGMENT_HEIGHT,
    TREE_FRAGMENT_DEPTH
  )) {
    bucket.sort(compareBlocks);
    for (let start = 0; start < bucket.length; start += TREE_ATTACHMENT_FRAGMENT_SLOT_COUNT) {
      const chunk = bucket.slice(start, start + TREE_ATTACHMENT_FRAGMENT_SLOT_COUNT);
      const words = new Array<number>(TREE_ATTACHMENT_FRAGMENT_SLOT_COUNT).fill(0);
      const assignments: FragmentSlotAssignment[] = [];
      for (let slot = 0; slot < chunk.length; slot++) {
        const block = chunk[slot]!;
        words[slot] = encodeAttachmentDescriptor(block, anchorLocalLocation);
        assignments.push({
          bitCount: ATTACHMENT_DESCRIPTOR_BITS,
          blockKey: blockKey(block.localLocation),
          shift: 0,
          slot,
          word: slot
        });
      }
      result.push({
        allBark: false,
        anchorLocalLocation,
        assignments,
        blockCount: chunk.length,
        entityTypeId: ATTACHMENT_FRAGMENT_ENTITY_TYPE_ID,
        family: 0,
        words
      });
    }
  }
  return result;
}

function packLeafVoxelGroup(blocks: readonly PhysicsContraptionBlock[]): PackedFragment[] {
  const standard = packLeafVoxelGroupWithLayout(blocks, {
    depth: TREE_LEAF_FRAGMENT_DEPTH,
    entityTypeId: LEAF_FRAGMENT_ENTITY_TYPE_ID,
    height: TREE_LEAF_FRAGMENT_HEIGHT,
    width: TREE_LEAF_FRAGMENT_WIDTH,
    wordCount: TREE_LEAF_FRAGMENT_WORD_COUNT
  });
  const compact = packLeafVoxelGroupWithLayout(blocks, {
    depth: TREE_COMPACT_LEAF_FRAGMENT_DEPTH,
    entityTypeId: COMPACT_LEAF_FRAGMENT_ENTITY_TYPE_ID,
    height: TREE_COMPACT_LEAF_FRAGMENT_HEIGHT,
    width: TREE_COMPACT_LEAF_FRAGMENT_WIDTH,
    wordCount: TREE_COMPACT_LEAF_FRAGMENT_WORD_COUNT
  });
  if (compact.length > standard.length) return standard;
  return compact.length * TREE_COMPACT_LEAF_FRAGMENT_SLOT_COUNT
      < standard.length * TREE_LEAF_FRAGMENT_SLOT_COUNT
    ? compact
    : standard;
}

function packLeafVoxelGroupWithLayout(
  blocks: readonly PhysicsContraptionBlock[],
  layout: {
    readonly depth: number;
    readonly entityTypeId:
      | typeof LEAF_FRAGMENT_ENTITY_TYPE_ID
      | typeof COMPACT_LEAF_FRAGMENT_ENTITY_TYPE_ID;
    readonly height: number;
    readonly width: number;
    readonly wordCount: number;
  }
): PackedFragment[] {
  return packVoxelGroupWithLayout(blocks, layout, {
    allBark: false,
    family: blocks[0]!.visual!.family,
    slotsPerWord: TREE_LEAF_FRAGMENT_SLOTS_PER_WORD,
    stateBits: TREE_LEAF_FRAGMENT_STATE_BITS,
    // A leaf slot is a single occupancy bit.
    stateOf: () => 1
  });
}

// Attachment slot descriptor, one 17-bit word per slot: bits 0-2 carry x,
// 3-4 y, 5-7 z, 8-11 the family index, 12-15 the family state, and bit 16
// marks the slot occupied (attachmentFamilyMask decodes these fields).
const ATTACHMENT_DESCRIPTOR_Y_PLACE = 0x8;
const ATTACHMENT_DESCRIPTOR_Z_PLACE = 0x20;
export const ATTACHMENT_DESCRIPTOR_FAMILY_PLACE = 0x100;
export const ATTACHMENT_DESCRIPTOR_FAMILY_SPAN = 0x10; // 4-bit family field
const ATTACHMENT_DESCRIPTOR_STATE_PLACE = 0x1000;
export const ATTACHMENT_DESCRIPTOR_OCCUPIED_PLACE = 0x10000;
const ATTACHMENT_DESCRIPTOR_BITS = 17;

/** Replaces only the four runtime state bits of an occupied attachment slot. */
export function replaceAttachmentDescriptorState(
  descriptor: number,
  state: number
): number {
  if (
    !Number.isInteger(descriptor)
    || descriptor < ATTACHMENT_DESCRIPTOR_OCCUPIED_PLACE
    || descriptor >= 2 ** ATTACHMENT_DESCRIPTOR_BITS
  ) throw new RangeError(`Invalid attachment descriptor ${descriptor}.`);
  if (!Number.isInteger(state) || state < 0 || state > 15) {
    throw new RangeError(`Invalid attachment fragment state ${state}.`);
  }
  const currentState = Math.floor(descriptor / ATTACHMENT_DESCRIPTOR_STATE_PLACE) % 16;
  return descriptor + (state - currentState) * ATTACHMENT_DESCRIPTOR_STATE_PLACE;
}

function encodeAttachmentDescriptor(
  block: PhysicsContraptionBlock,
  origin: Vector3
): number {
  const visual = block.visual!;
  const x = block.localLocation.x - origin.x;
  const y = block.localLocation.y - origin.y;
  const z = block.localLocation.z - origin.z;
  return ATTACHMENT_DESCRIPTOR_OCCUPIED_PLACE
    + x
    + y * ATTACHMENT_DESCRIPTOR_Y_PLACE
    + z * ATTACHMENT_DESCRIPTOR_Z_PLACE
    + visual.family * ATTACHMENT_DESCRIPTOR_FAMILY_PLACE
    + visual.state * ATTACHMENT_DESCRIPTOR_STATE_PLACE;
}

function packLogVoxelGroup(blocks: readonly PhysicsContraptionBlock[]): PackedFragment[] {
  const standard = packLogVoxelGroupWithLayout(blocks, {
    depth: TREE_FRAGMENT_DEPTH,
    entityTypeId: LOG_FRAGMENT_ENTITY_TYPE_ID,
    height: TREE_FRAGMENT_HEIGHT,
    width: TREE_FRAGMENT_WIDTH,
    wordCount: TREE_FRAGMENT_WORD_COUNT
  });
  const tall = packLogVoxelGroupWithLayout(blocks, {
    depth: TREE_TALL_FRAGMENT_DEPTH,
    entityTypeId: TALL_LOG_FRAGMENT_ENTITY_TYPE_ID,
    height: TREE_TALL_FRAGMENT_HEIGHT,
    width: TREE_TALL_FRAGMENT_WIDTH,
    wordCount: TREE_TALL_FRAGMENT_WORD_COUNT
  });
  return tall.length < standard.length ? tall : standard;
}

function packLogVoxelGroupWithLayout(
  blocks: readonly PhysicsContraptionBlock[],
  layout: {
    readonly depth: number;
    readonly entityTypeId:
      | typeof LOG_FRAGMENT_ENTITY_TYPE_ID
      | typeof TALL_LOG_FRAGMENT_ENTITY_TYPE_ID;
    readonly height: number;
    readonly width: number;
    readonly wordCount: number;
  }
): PackedFragment[] {
  const visual = blocks[0]!.visual!;
  if (visual.renderer !== "log_fragment") {
    throw new TypeError("Log fragment packing received a non-log visual.");
  }
  return packVoxelGroupWithLayout(blocks, layout, {
    allBark: visual.allBark,
    family: visual.family,
    slotsPerWord: TREE_FRAGMENT_SLOTS_PER_WORD,
    stateBits: TREE_FRAGMENT_STATE_BITS,
    stateOf: block => block.visual!.state
  });
}

/** Shared log/leaf voxel packer; the caller supplies the per-slot bit layout. */
function packVoxelGroupWithLayout(
  blocks: readonly PhysicsContraptionBlock[],
  layout: {
    readonly depth: number;
    readonly entityTypeId:
      | typeof LOG_FRAGMENT_ENTITY_TYPE_ID
      | typeof TALL_LOG_FRAGMENT_ENTITY_TYPE_ID
      | typeof LEAF_FRAGMENT_ENTITY_TYPE_ID
      | typeof COMPACT_LEAF_FRAGMENT_ENTITY_TYPE_ID;
    readonly height: number;
    readonly width: number;
    readonly wordCount: number;
  },
  encoding: {
    readonly allBark: boolean;
    readonly family: number;
    readonly slotsPerWord: number;
    readonly stateBits: number;
    readonly stateOf: (block: PhysicsContraptionBlock) => number;
  }
): PackedFragment[] {
  const origin = {
    x: chooseAxisOrigin(blocks, "x", layout.width),
    y: chooseAxisOrigin(blocks, "y", layout.height),
    z: chooseAxisOrigin(blocks, "z", layout.depth)
  };
  const result: PackedFragment[] = [];
  for (const [anchorLocalLocation, bucket] of bucketBlocksByOrigin(
    blocks,
    origin,
    layout.width,
    layout.height,
    layout.depth
  )) {
    const words = new Array<number>(layout.wordCount).fill(0);
    const assignments: FragmentSlotAssignment[] = [];
    for (const block of bucket) {
      const localX = block.localLocation.x - anchorLocalLocation.x;
      const localY = block.localLocation.y - anchorLocalLocation.y;
      const localZ = block.localLocation.z - anchorLocalLocation.z;
      const slot = localY * layout.width * layout.depth
        + localZ * layout.width
        + localX;
      const word = Math.floor(slot / encoding.slotsPerWord);
      const shift = (slot % encoding.slotsPerWord) * encoding.stateBits;
      words[word] = words[word] | (encoding.stateOf(block) * (2 ** shift));
      assignments.push({
        bitCount: encoding.stateBits,
        blockKey: blockKey(block.localLocation),
        shift,
        slot,
        word
      });
    }
    assignments.sort((left, right) => left.slot - right.slot);
    result.push({
      allBark: encoding.allBark,
      anchorLocalLocation,
      assignments,
      blockCount: bucket.length,
      entityTypeId: layout.entityTypeId,
      family: encoding.family,
      words
    });
  }
  return result;
}

function chooseAxisOrigin(
  blocks: readonly PhysicsContraptionBlock[],
  axis: "x" | "y" | "z",
  size: number
): number {
  const minimum = Math.min(...blocks.map(block => block.localLocation[axis]));
  let bestOrigin = minimum;
  let bestBucketCount = Number.POSITIVE_INFINITY;
  for (let shift = 0; shift < size; shift++) {
    const origin = minimum - shift;
    const buckets = new Set<number>();
    for (const block of blocks) {
      buckets.add(Math.floor((block.localLocation[axis] - origin) / size));
    }
    if (buckets.size < bestBucketCount) {
      bestBucketCount = buckets.size;
      bestOrigin = origin;
    }
  }
  return bestOrigin;
}

function isSupportedVisual(block: PhysicsContraptionBlock): boolean {
  const visual = block.visual;
  if (
    !Number.isInteger(block.localLocation.x)
    || !Number.isInteger(block.localLocation.y)
    || !Number.isInteger(block.localLocation.z)
    || !visual
    || (visual.renderer !== "cube_block_fragment" && (
      !Number.isInteger(visual.family) || visual.family < 0
    ))
  ) return false;
  if (!Number.isInteger(visual.state) || visual.state < 0) return false;
  if (visual.renderer === "log_fragment") {
    return typeof visual.allBark === "boolean"
      && visual.family < TREE_FRAGMENT_FAMILIES.length
      && visual.state >= 2
      && visual.state <= 7;
  }
  if (visual.renderer === "leaf_fragment") {
    return visual.family < TREE_FRAGMENT_FAMILIES.length
      && visual.state === 1;
  }
  if (visual.renderer === "cube_block_fragment") {
    return block.typeId === "minecraft:chest" && visual.state >= 0 && visual.state <= 3;
  }
  return visual.renderer === "attachment_fragment"
    && visual.family < TREE_ATTACHMENT_FRAGMENT_FAMILIES.length
    && visual.state <= 15;
}

function isEncodableOrigin(location: Vector3): boolean {
  return location.x >= -TREE_FRAGMENT_ORIGIN_BIAS
    && location.x < TREE_FRAGMENT_ORIGIN_SIZE - TREE_FRAGMENT_ORIGIN_BIAS
    && location.y >= -TREE_FRAGMENT_ORIGIN_BIAS
    && location.y < TREE_FRAGMENT_ORIGIN_SIZE - TREE_FRAGMENT_ORIGIN_BIAS
    && location.z >= -TREE_FRAGMENT_ORIGIN_BIAS
    && location.z < TREE_FRAGMENT_ORIGIN_SIZE - TREE_FRAGMENT_ORIGIN_BIAS;
}

function compareBlocks(left: PhysicsContraptionBlock, right: PhysicsContraptionBlock): number {
  return left.localLocation.y - right.localLocation.y
    || left.localLocation.z - right.localLocation.z
    || left.localLocation.x - right.localLocation.x
    || visualFamily(left.visual!) - visualFamily(right.visual!)
    || left.visual!.state - right.visual!.state;
}

/** Keep sparse newly placed blocks near the center while still minimizing buckets. */
function chooseCenteredAxisOrigin(
  blocks: readonly PhysicsContraptionBlock[],
  axis: "x" | "y" | "z",
  size: number
): number {
  const minimum = Math.min(...blocks.map(block => block.localLocation[axis]));
  const center = (size - 1) / 2;
  let bestOrigin = minimum;
  let bestBucketCount = Number.POSITIVE_INFINITY;
  let bestCenterDistance = Number.POSITIVE_INFINITY;
  for (let shift = 0; shift < size; shift++) {
    const origin = minimum - shift;
    const buckets = new Set<number>();
    let centerDistance = 0;
    for (const block of blocks) {
      const relative = block.localLocation[axis] - origin;
      const bucket = Math.floor(relative / size);
      buckets.add(bucket);
      const inBucket = relative - bucket * size;
      centerDistance += (inBucket - center) ** 2;
    }
    if (
      buckets.size < bestBucketCount
      || (buckets.size === bestBucketCount && centerDistance < bestCenterDistance)
    ) {
      bestBucketCount = buckets.size;
      bestCenterDistance = centerDistance;
      bestOrigin = origin;
    }
  }
  return bestOrigin;
}
function bucketBlocksByOrigin(
  blocks: readonly PhysicsContraptionBlock[],
  origin: Vector3,
  width: number,
  height: number,
  depth: number
): readonly (readonly [Vector3, PhysicsContraptionBlock[]])[] {
  const buckets = new Map<string, PhysicsContraptionBlock[]>();
  for (const block of blocks) {
    const bucketX = Math.floor((block.localLocation.x - origin.x) / width);
    const bucketY = Math.floor((block.localLocation.y - origin.y) / height);
    const bucketZ = Math.floor((block.localLocation.z - origin.z) / depth);
    const key = `${bucketX},${bucketY},${bucketZ}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(block);
    else buckets.set(key, [block]);
  }

  return [...buckets].map(([key, bucket]) => {
    const [bucketX, bucketY, bucketZ] = key.split(",").map(Number) as [number, number, number];
    return [
      {
        x: origin.x + bucketX * width,
        y: origin.y + bucketY * height,
        z: origin.z + bucketZ * depth
      },
      bucket
    ] as const;
  });
}

function visualFamily(visual: NonNullable<PhysicsContraptionBlock["visual"]>): number {
  return visual.renderer === "cube_block_fragment" ? 0 : visual.family;
}

function compareFragments(left: PackedFragment, right: PackedFragment): number {
  return left.entityTypeId.localeCompare(right.entityTypeId)
    || left.family - right.family
    || Number(left.allBark) - Number(right.allBark)
    || left.anchorLocalLocation.y - right.anchorLocalLocation.y
    || left.anchorLocalLocation.z - right.anchorLocalLocation.z
    || left.anchorLocalLocation.x - right.anchorLocalLocation.x;
}
