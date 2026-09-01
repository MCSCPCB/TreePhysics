import type { Vector3 } from "@minecraft/server";
import type {
  PhysicsContraption,
  PhysicsContraptionBlock
} from "@src/Physics";
import {
  clampPointToAabb,
  getContraptionBasis,
  getLocalCollisionBoxes,
  type LocalBox,
  type OrthonormalBasis
} from "@src/content/contraption/interaction/ContactGeometry";
import { rejectNormal } from "./Motion";
import {
  add,
  clamp,
  dot,
  EPSILON_1E8,
  length,
  scale,
  squaredDistance,
  subtract
} from "@src/utils/Vector3Math";

const PLAYER_RADIUS = 0.3;
const PLAYER_SPHERE_HEIGHTS = Object.freeze([0.3, 0.9, 1.5] as const);
const STEP_HEIGHT = 0.6;
const SUPPORT_PROBE_DISTANCE = 0.08;
const COLLISION_SKIN = 0.001;
const COLLISION_EPSILON = EPSILON_1E8;
const PENETRATION_MAX_ITERATIONS = 8;
const SWEEP_MAX_ITERATIONS = 4;

interface LocalCollisionBox {
  readonly block: PhysicsContraptionBlock;
  readonly bounds: LocalBox;
}

interface SpherePenetration {
  readonly depth: number;
  readonly normal: Vector3;
}

interface SphereSweepHit {
  readonly block: PhysicsContraptionBlock;
  readonly localPoint: Vector3;
  readonly normal: Vector3;
  readonly time: number;
}

interface SlideResult {
  readonly contacts: readonly SphereSweepHit[];
  readonly position: Vector3;
}

export interface MountSupport {
  readonly block?: PhysicsContraptionBlock;
  readonly localPoint: Vector3;
  /** World-space normal of the supporting contraption face. */
  readonly normal: Vector3;
  readonly worldPoint: Vector3;
}

export interface MountCollisionResult {
  readonly grounded: boolean;
  readonly hitCeiling: boolean;
  readonly movement: Vector3;
  readonly support?: MountSupport;
}

/**
 * Resolves one tick of rider-relative movement in the owning contraption's
 * current local frame. Carrier displacement is deliberately excluded by the
 * caller, so moving the contraption cannot make it collide with its own rider.
 */
export function resolveMountCollision(
  contraption: PhysicsContraption,
  feet: Vector3,
  movement: Vector3,
  wasGrounded: boolean
): MountCollisionResult {
  const basis = getContraptionBasis(contraption);
  const localFeet = contraption.body.worldPointToLocal(feet);
  const localMovement = worldVectorToLocal(movement, basis);
  const sphereOffsets = PLAYER_SPHERE_HEIGHTS.map(height => (
    worldVectorToLocal({ x: 0, y: height, z: 0 }, basis)
  ));
  const boxes = getSweepCollisionBoxes(
    contraption,
    localFeet,
    localMovement,
    sphereOffsets
  );
  let position = recoverPenetration(localFeet, sphereOffsets, boxes);
  let slide = moveAndSlide(position, localMovement, sphereOffsets, boxes);

  if (wasGrounded
    && Math.hypot(movement.x, movement.z) > COLLISION_EPSILON
    && hasSideContact(slide.contacts, basis)) {
    const stepped = tryStep(
      position,
      movement,
      slide,
      sphereOffsets,
      boxes,
      basis
    );
    if (stepped) slide = stepped;
  }

  position = slide.position;
  let support: MountSupport | undefined;
  if (wasGrounded || movement.y <= COLLISION_EPSILON) {
    const settled = settleOnSupport(
      position,
      sphereOffsets,
      boxes,
      basis,
      SUPPORT_PROBE_DISTANCE
    );
    if (settled) {
      position = settled.position;
      support = {
        block: settled.hit.block,
        localPoint: settled.hit.localPoint,
        normal: localVectorToWorld(settled.hit.normal, basis),
        worldPoint: contraption.body.localPointToWorld(settled.hit.localPoint)
      };
    }
  }

  return {
    grounded: support !== undefined,
    hitCeiling: slide.contacts.some(contact => (
      localVectorToWorld(contact.normal, basis).y < -COLLISION_EPSILON
    )),
    movement: localVectorToWorld(subtract(position, localFeet), basis),
    support
  };
}

/** Collects the indexed local collision boxes touched by the direct and step paths once. */
function getSweepCollisionBoxes(
  contraption: PhysicsContraption,
  localFeet: Vector3,
  localMovement: Vector3,
  sphereOffsets: readonly Vector3[]
): readonly LocalCollisionBox[] {
  const firstOffset = sphereOffsets[0]!;
  let minimum = add(localFeet, firstOffset);
  let maximum = { ...minimum };
  for (const offset of sphereOffsets) {
    const start = add(localFeet, offset);
    const end = add(start, localMovement);
    minimum = {
      x: Math.min(minimum.x, start.x, end.x),
      y: Math.min(minimum.y, start.y, end.y),
      z: Math.min(minimum.z, start.z, end.z)
    };
    maximum = {
      x: Math.max(maximum.x, start.x, end.x),
      y: Math.max(maximum.y, start.y, end.y),
      z: Math.max(maximum.z, start.z, end.z)
    };
  }
  const margin = PLAYER_RADIUS + STEP_HEIGHT + COLLISION_SKIN;
  const blocks = contraption.getBlocksInLocalBounds(
    {
      x: minimum.x - margin,
      y: minimum.y - margin,
      z: minimum.z - margin
    },
    {
      x: maximum.x + margin,
      y: maximum.y + margin,
      z: maximum.z + margin
    }
  );
  const boxes: LocalCollisionBox[] = [];
  for (const block of blocks) {
    for (const bounds of getLocalCollisionBoxes(block, true)) {
      boxes.push({ block, bounds });
    }
  }
  return boxes;
}

/** Separates an already-overlapping sphere group before applying new movement. */
function recoverPenetration(
  start: Vector3,
  sphereOffsets: readonly Vector3[],
  boxes: readonly LocalCollisionBox[]
): Vector3 {
  let position = { ...start };
  for (let iteration = 0; iteration < PENETRATION_MAX_ITERATIONS; iteration++) {
    let deepest: SpherePenetration | undefined;
    for (const offset of sphereOffsets) {
      const center = add(position, offset);
      for (const box of boxes) {
        const penetration = getSpherePenetration(center, PLAYER_RADIUS, box.bounds);
        if (penetration && (!deepest || penetration.depth > deepest.depth)) {
          deepest = penetration;
        }
      }
    }
    if (!deepest) break;
    position = add(position, scale(
      deepest.normal,
      deepest.depth + COLLISION_SKIN
    ));
  }
  return position;
}

/** Continuous sphere-group sweep with contact-plane sliding. */
function moveAndSlide(
  start: Vector3,
  movement: Vector3,
  sphereOffsets: readonly Vector3[],
  boxes: readonly LocalCollisionBox[]
): SlideResult {
  const contacts: SphereSweepHit[] = [];
  let position = { ...start };
  let remaining = { ...movement };
  for (let iteration = 0; iteration < SWEEP_MAX_ITERATIONS; iteration++) {
    const remainingLength = length(remaining);
    if (remainingLength <= COLLISION_EPSILON) break;
    const hit = findFirstSweepHit(position, remaining, sphereOffsets, boxes);
    if (!hit) {
      position = add(position, remaining);
      break;
    }

    const travelTime = Math.max(
      0,
      hit.time - COLLISION_SKIN / remainingLength
    );
    position = add(position, scale(remaining, travelTime));
    remaining = scale(remaining, 1 - travelTime);
    const inwardAmount = dot(remaining, hit.normal);
    if (inwardAmount < 0) {
      remaining = rejectNormal(remaining, hit.normal);
    }
    contacts.push(hit);
  }
  return { contacts, position };
}

/** Tries the vanilla-sized step path inside the same local collision solve. */
function tryStep(
  start: Vector3,
  movementWorld: Vector3,
  direct: SlideResult,
  sphereOffsets: readonly Vector3[],
  boxes: readonly LocalCollisionBox[],
  basis: OrthonormalBasis
): SlideResult | undefined {
  const up = worldVectorToLocal({ x: 0, y: STEP_HEIGHT, z: 0 }, basis);
  const raised = moveAndSlide(start, up, sphereOffsets, boxes);
  const raisedWorld = localVectorToWorld(subtract(raised.position, start), basis);
  if (raisedWorld.y < STEP_HEIGHT - COLLISION_SKIN) return undefined;

  const horizontal = worldVectorToLocal({
    x: movementWorld.x,
    y: 0,
    z: movementWorld.z
  }, basis);
  const advanced = moveAndSlide(
    raised.position,
    horizontal,
    sphereOffsets,
    boxes
  );
  const settled = settleOnSupport(
    advanced.position,
    sphereOffsets,
    boxes,
    basis,
    STEP_HEIGHT + SUPPORT_PROBE_DISTANCE
  );
  if (!settled) return undefined;

  const directionLength = Math.hypot(movementWorld.x, movementWorld.z);
  const direction = {
    x: movementWorld.x / directionLength,
    y: 0,
    z: movementWorld.z / directionLength
  };
  const directWorld = localVectorToWorld(subtract(direct.position, start), basis);
  const steppedWorld = localVectorToWorld(subtract(settled.position, start), basis);
  if (steppedWorld.y > STEP_HEIGHT + COLLISION_SKIN) return undefined;
  const directProgress = dot(directWorld, direction);
  const steppedProgress = dot(steppedWorld, direction);
  if (steppedProgress <= directProgress + COLLISION_SKIN) return undefined;
  return {
    contacts: [...raised.contacts, ...advanced.contacts, settled.hit],
    position: settled.position
  };
}

function settleOnSupport(
  position: Vector3,
  sphereOffsets: readonly Vector3[],
  boxes: readonly LocalCollisionBox[],
  basis: OrthonormalBasis,
  distance: number
): { readonly hit: SphereSweepHit; readonly position: Vector3 } | undefined {
  const downward = worldVectorToLocal({ x: 0, y: -distance, z: 0 }, basis);
  // Only the lowest sphere may own support; upper body contacts must remain
  // walls instead of turning ledges beside the player into climbable ground.
  const hit = findFirstSweepHit(
    position,
    downward,
    [sphereOffsets[0]!],
    boxes,
    contact => isMountSupportNormal(localVectorToWorld(contact.normal, basis))
  );
  if (!hit) return undefined;
  const travelTime = Math.max(0, hit.time - COLLISION_SKIN / distance);
  return {
    hit,
    position: add(position, scale(downward, travelTime))
  };
}

function hasSideContact(
  contacts: readonly SphereSweepHit[],
  basis: OrthonormalBasis
): boolean {
  return contacts.some(contact => (
    Math.abs(localVectorToWorld(contact.normal, basis).y) <= COLLISION_EPSILON
  ));
}

/** Keeps upward-facing contacts continuous through near-vertical slopes. */
export function isMountSupportNormal(normal: Vector3): boolean {
  return normal.y > COLLISION_EPSILON;
}

function findFirstSweepHit(
  position: Vector3,
  movement: Vector3,
  sphereOffsets: readonly Vector3[],
  boxes: readonly LocalCollisionBox[],
  accept?: (hit: SphereSweepHit) => boolean
): SphereSweepHit | undefined {
  let first: SphereSweepHit | undefined;
  for (const offset of sphereOffsets) {
    const origin = add(position, offset);
    for (const box of boxes) {
      const hit = sweepSphereAgainstAabb(origin, movement, PLAYER_RADIUS, box);
      if (!hit || (accept && !accept(hit))) continue;
      if (!first || hit.time < first.time) first = hit;
    }
  }
  return first;
}

/** Exact first contact of a moving sphere with one local AABB. */
function sweepSphereAgainstAabb(
  origin: Vector3,
  movement: Vector3,
  radius: number,
  box: LocalCollisionBox
): SphereSweepHit | undefined {
  const times = [0, 1];
  addAxisBreakpoints(times, origin.x, movement.x, box.bounds.min.x, box.bounds.max.x);
  addAxisBreakpoints(times, origin.y, movement.y, box.bounds.min.y, box.bounds.max.y);
  addAxisBreakpoints(times, origin.z, movement.z, box.bounds.min.z, box.bounds.max.z);
  times.sort((left, right) => left - right);
  const uniqueTimes = times.filter((time, index) => (
    index === 0 || time - times[index - 1]! > COLLISION_EPSILON
  ));

  const radiusSquared = radius * radius;
  for (let index = 0; index < uniqueTimes.length - 1; index++) {
    const startTime = uniqueTimes[index]!;
    const endTime = uniqueTimes[index + 1]!;
    const startPoint = add(origin, scale(movement, startTime));
    if (squaredDistanceToAabb(startPoint, box.bounds) <= radiusSquared + COLLISION_EPSILON) {
      return createSweepHit(origin, movement, startTime, box);
    }
    if (endTime - startTime <= COLLISION_EPSILON) continue;

    const middleTime = (startTime + endTime) * 0.5;
    const coefficients = getDistanceCoefficients(
      origin,
      movement,
      box.bounds,
      middleTime
    );
    const root = firstQuadraticRootInRange(
      coefficients.quadratic,
      coefficients.linear,
      coefficients.constant - radiusSquared,
      startTime,
      endTime
    );
    if (root !== undefined) return createSweepHit(origin, movement, root, box);
  }

  const endPoint = add(origin, movement);
  return squaredDistanceToAabb(endPoint, box.bounds) <= radiusSquared + COLLISION_EPSILON
    ? createSweepHit(origin, movement, 1, box)
    : undefined;
}

function createSweepHit(
  origin: Vector3,
  movement: Vector3,
  time: number,
  box: LocalCollisionBox
): SphereSweepHit | undefined {
  const center = add(origin, scale(movement, time));
  const localPoint = clampPointToAabb(center, box.bounds);
  const normal = getSphereContactNormal(center, localPoint, box.bounds);
  return dot(movement, normal) < -COLLISION_EPSILON
    ? { block: box.block, localPoint, normal, time }
    : undefined;
}

function getSpherePenetration(
  center: Vector3,
  radius: number,
  box: LocalBox
): SpherePenetration | undefined {
  const closest = clampPointToAabb(center, box);
  const delta = subtract(center, closest);
  const distance = length(delta);
  if (distance > COLLISION_EPSILON) {
    const depth = radius - distance;
    return depth > COLLISION_EPSILON
      ? { depth, normal: scale(delta, 1 / distance) }
      : undefined;
  }

  const nearest = nearestBoxFace(center, box);
  return {
    depth: radius + nearest.distance,
    normal: nearest.normal
  };
}

function getSphereContactNormal(
  center: Vector3,
  closest: Vector3,
  box: LocalBox
): Vector3 {
  const delta = subtract(center, closest);
  const distance = length(delta);
  return distance > COLLISION_EPSILON
    ? scale(delta, 1 / distance)
    : nearestBoxFace(center, box).normal;
}

function nearestBoxFace(
  point: Vector3,
  box: LocalBox
): { readonly distance: number; readonly normal: Vector3 } {
  const faces = [
    { distance: point.x - box.min.x, normal: { x: -1, y: 0, z: 0 } },
    { distance: box.max.x - point.x, normal: { x: 1, y: 0, z: 0 } },
    { distance: point.y - box.min.y, normal: { x: 0, y: -1, z: 0 } },
    { distance: box.max.y - point.y, normal: { x: 0, y: 1, z: 0 } },
    { distance: point.z - box.min.z, normal: { x: 0, y: 0, z: -1 } },
    { distance: box.max.z - point.z, normal: { x: 0, y: 0, z: 1 } }
  ] as const;
  let nearest: { readonly distance: number; readonly normal: Vector3 } = faces[0]!;
  for (let index = 1; index < faces.length; index++) {
    const face = faces[index]!;
    if (face.distance < nearest.distance) nearest = face;
  }
  return nearest;
}

function addAxisBreakpoints(
  times: number[],
  origin: number,
  movement: number,
  minimum: number,
  maximum: number
): void {
  if (Math.abs(movement) <= COLLISION_EPSILON) return;
  const first = (minimum - origin) / movement;
  const second = (maximum - origin) / movement;
  if (first > COLLISION_EPSILON && first < 1 - COLLISION_EPSILON) times.push(first);
  if (second > COLLISION_EPSILON && second < 1 - COLLISION_EPSILON) times.push(second);
}

function getDistanceCoefficients(
  origin: Vector3,
  movement: Vector3,
  box: LocalBox,
  sampleTime: number
): { readonly constant: number; readonly linear: number; readonly quadratic: number } {
  let constant = 0;
  let linear = 0;
  let quadratic = 0;
  for (const axis of ["x", "y", "z"] as const) {
    const sample = origin[axis] + movement[axis] * sampleTime;
    let offset = 0;
    if (sample < box.min[axis]) offset = origin[axis] - box.min[axis];
    else if (sample > box.max[axis]) offset = origin[axis] - box.max[axis];
    else continue;
    constant += offset * offset;
    linear += 2 * offset * movement[axis];
    quadratic += movement[axis] * movement[axis];
  }
  return { constant, linear, quadratic };
}

function firstQuadraticRootInRange(
  quadratic: number,
  linear: number,
  constant: number,
  minimum: number,
  maximum: number
): number | undefined {
  if (quadratic <= COLLISION_EPSILON) {
    if (Math.abs(linear) <= COLLISION_EPSILON) return undefined;
    const root = -constant / linear;
    return root >= minimum - COLLISION_EPSILON
      && root <= maximum + COLLISION_EPSILON
      ? clamp(root, minimum, maximum)
      : undefined;
  }
  const discriminant = linear * linear - 4 * quadratic * constant;
  if (discriminant < -COLLISION_EPSILON) return undefined;
  const squareRoot = Math.sqrt(Math.max(0, discriminant));
  const first = (-linear - squareRoot) / (2 * quadratic);
  const second = (-linear + squareRoot) / (2 * quadratic);
  for (const root of [first, second]) {
    if (root >= minimum - COLLISION_EPSILON
      && root <= maximum + COLLISION_EPSILON) {
      return clamp(root, minimum, maximum);
    }
  }
  return undefined;
}

function squaredDistanceToAabb(point: Vector3, box: LocalBox): number {
  return squaredDistance(point, clampPointToAabb(point, box));
}

function worldVectorToLocal(
  vector: Vector3,
  basis: OrthonormalBasis
): Vector3 {
  return {
    x: dot(vector, basis.x),
    y: dot(vector, basis.y),
    z: dot(vector, basis.z)
  };
}

function localVectorToWorld(
  vector: Vector3,
  basis: OrthonormalBasis
): Vector3 {
  return {
    x: basis.x.x * vector.x + basis.y.x * vector.y + basis.z.x * vector.z,
    y: basis.x.y * vector.x + basis.y.y * vector.y + basis.z.y * vector.z,
    z: basis.x.z * vector.x + basis.y.z * vector.y + basis.z.z * vector.z
  };
}
