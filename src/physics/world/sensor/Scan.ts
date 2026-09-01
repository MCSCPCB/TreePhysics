// Indexed world-sensor sweep for the cannon kernel: swept oriented-box samples
// and SAT contact selection against cached sensor boxes. Chunk-key enumeration
// stays in indexed-world-sensor-chunk-index.ts; the two are deliberately separate.
import type { Vector3 } from "@minecraft/server";
import type { Quaternion, Vec3 } from "cannon-es";
import type { GreedyBox } from "@src/physics/core/GreedyBoxMesher";
import {
  findOrientedBoxAabbContactNormal,
  prepareOrientedBoxAabbSatAxes
} from "@src/physics/collision/OrientedBoxAabbSat";
import {
  lerp,
  multiplyQuaternions,
  quaternionAngularDistance,
  quaternionRotationMatrix,
  slerpQuaternionShortest,
  toCannonQuaternion,
  type IntegerBounds
} from "@src/physics/motion/KernelMath";
import type {
  NormalizedBodyCollider,
  NormalizedBoxColliderShape
} from "@src/physics/core/ColliderNormalization";
import { clamp } from "@src/utils/Vector3Math";

const WORLD_SENSOR_SWEEP_MAX_STEP_DISTANCE = 0.2;
const WORLD_SENSOR_SWEEP_MAX_ANGLE = Math.PI / 24;
const WORLD_SENSOR_SWEEP_MAX_STEPS = 32;
const WORLD_SENSOR_SWEEP_BOUNDS_MARGIN = 0.001;

export interface OrientedWorldSensorBoxSample {
  readonly bodyX: number;
  readonly bodyY: number;
  readonly bodyZ: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly centerZ: number;
  readonly halfX: number;
  readonly halfY: number;
  readonly halfZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly r00: number;
  readonly r01: number;
  readonly r02: number;
  readonly r10: number;
  readonly r11: number;
  readonly r12: number;
  readonly r20: number;
  readonly r21: number;
  readonly r22: number;
  satAxes?: Float64Array;
  readonly time: number;
}

export interface IndexedWorldSensorSweep {
  readonly bounds: IntegerBounds;
  readonly samples: readonly OrientedWorldSensorBoxSample[];
}

export interface IndexedWorldSensorContact {
  readonly bodyX: number;
  readonly bodyY: number;
  readonly bodyZ: number;
  readonly normalX: number;
  readonly normalY: number;
  readonly normalZ: number;
  readonly pointX: number;
  readonly pointY: number;
  readonly pointZ: number;
  readonly time: number;
}

export function createIndexedWorldSensorSweep(
  shape: NormalizedBoxColliderShape,
  localCenterOfMass: Vector3,
  startPosition: Vec3,
  startQuaternion: Quaternion,
  endPosition: Vec3,
  endQuaternion: Quaternion
): IndexedWorldSensorSweep {
  const localCenterX = shape.location.x - localCenterOfMass.x;
  const localCenterY = shape.location.y - localCenterOfMass.y;
  const localCenterZ = shape.location.z - localCenterOfMass.z;
  const halfX = shape.primitive.halfExtents.x;
  const halfY = shape.primitive.halfExtents.y;
  const halfZ = shape.primitive.halfExtents.z;
  const radius = Math.hypot(localCenterX, localCenterY, localCenterZ)
    + Math.hypot(halfX, halfY, halfZ);
  const travel = Math.hypot(
    endPosition.x - startPosition.x,
    endPosition.y - startPosition.y,
    endPosition.z - startPosition.z
  );
  const rotationAngle = quaternionAngularDistance(startQuaternion, endQuaternion);
  const stepCount = Math.max(1, Math.min(
    WORLD_SENSOR_SWEEP_MAX_STEPS,
    Math.ceil(Math.max(
      travel / WORLD_SENSOR_SWEEP_MAX_STEP_DISTANCE,
      rotationAngle / WORLD_SENSOR_SWEEP_MAX_ANGLE,
      (travel + radius * rotationAngle) / WORLD_SENSOR_SWEEP_MAX_STEP_DISTANCE
    ))
  ));
  const shapeRotation = toCannonQuaternion(shape.rotation);
  const samples: OrientedWorldSensorBoxSample[] = [];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let step = 0; step <= stepCount; step++) {
    const time = step / stepCount;
    const bodyX = lerp(startPosition.x, endPosition.x, time);
    const bodyY = lerp(startPosition.y, endPosition.y, time);
    const bodyZ = lerp(startPosition.z, endPosition.z, time);
    const bodyRotation = slerpQuaternionShortest(startQuaternion, endQuaternion, time);
    const rotation = multiplyQuaternions(bodyRotation, shapeRotation);
    const bodyMatrix = quaternionRotationMatrix(bodyRotation);
    const matrix = quaternionRotationMatrix(rotation);
    const centerX = bodyX
      + bodyMatrix.r00 * localCenterX
      + bodyMatrix.r01 * localCenterY
      + bodyMatrix.r02 * localCenterZ;
    const centerY = bodyY
      + bodyMatrix.r10 * localCenterX
      + bodyMatrix.r11 * localCenterY
      + bodyMatrix.r12 * localCenterZ;
    const centerZ = bodyZ
      + bodyMatrix.r20 * localCenterX
      + bodyMatrix.r21 * localCenterY
      + bodyMatrix.r22 * localCenterZ;
    const r00 = matrix.r00;
    const r01 = matrix.r01;
    const r02 = matrix.r02;
    const r10 = matrix.r10;
    const r11 = matrix.r11;
    const r12 = matrix.r12;
    const r20 = matrix.r20;
    const r21 = matrix.r21;
    const r22 = matrix.r22;
    const worldHalfX = Math.abs(r00) * halfX
      + Math.abs(r01) * halfY
      + Math.abs(r02) * halfZ;
    const worldHalfY = Math.abs(r10) * halfX
      + Math.abs(r11) * halfY
      + Math.abs(r12) * halfZ;
    const worldHalfZ = Math.abs(r20) * halfX
      + Math.abs(r21) * halfY
      + Math.abs(r22) * halfZ;
    const sample: OrientedWorldSensorBoxSample = {
      bodyX,
      bodyY,
      bodyZ,
      centerX,
      centerY,
      centerZ,
      halfX,
      halfY,
      halfZ,
      maxX: centerX + worldHalfX,
      maxY: centerY + worldHalfY,
      maxZ: centerZ + worldHalfZ,
      minX: centerX - worldHalfX,
      minY: centerY - worldHalfY,
      minZ: centerZ - worldHalfZ,
      r00,
      r01,
      r02,
      r10,
      r11,
      r12,
      r20,
      r21,
      r22,
      time
    };
    samples.push(sample);
    minX = Math.min(minX, sample.minX);
    minY = Math.min(minY, sample.minY);
    minZ = Math.min(minZ, sample.minZ);
    maxX = Math.max(maxX, sample.maxX);
    maxY = Math.max(maxY, sample.maxY);
    maxZ = Math.max(maxZ, sample.maxZ);
  }
  return {
    bounds: {
      maxX: Math.floor(maxX + WORLD_SENSOR_SWEEP_BOUNDS_MARGIN),
      maxY: Math.floor(maxY + WORLD_SENSOR_SWEEP_BOUNDS_MARGIN),
      maxZ: Math.floor(maxZ + WORLD_SENSOR_SWEEP_BOUNDS_MARGIN),
      minX: Math.floor(minX - WORLD_SENSOR_SWEEP_BOUNDS_MARGIN),
      minY: Math.floor(minY - WORLD_SENSOR_SWEEP_BOUNDS_MARGIN),
      minZ: Math.floor(minZ - WORLD_SENSOR_SWEEP_BOUNDS_MARGIN)
    },
    samples
  };
}

export function getIndexedWorldSensorShapes(
  collider: NormalizedBodyCollider
): readonly NormalizedBoxColliderShape[] | undefined {
  for (const shape of collider.shapes) {
    if (shape.primitive.type !== "box") return undefined;
  }
  return collider.shapes as readonly NormalizedBoxColliderShape[];
}

export function findIndexedWorldSensorContact(
  samples: readonly OrientedWorldSensorBoxSample[],
  sensorBox: GreedyBox
): IndexedWorldSensorContact | undefined {
  const sensorMaxX = sensorBox.minX + sensorBox.sizeX;
  const sensorMaxY = sensorBox.minY + sensorBox.sizeY;
  const sensorMaxZ = sensorBox.minZ + sensorBox.sizeZ;
  const sensorHalfX = sensorBox.sizeX / 2;
  const sensorHalfY = sensorBox.sizeY / 2;
  const sensorHalfZ = sensorBox.sizeZ / 2;
  const sensorCenterX = sensorBox.minX + sensorHalfX;
  const sensorCenterY = sensorBox.minY + sensorHalfY;
  const sensorCenterZ = sensorBox.minZ + sensorHalfZ;
  for (const sample of samples) {
    if (
      sample.maxX < sensorBox.minX - WORLD_SENSOR_SWEEP_BOUNDS_MARGIN
      || sample.maxY < sensorBox.minY - WORLD_SENSOR_SWEEP_BOUNDS_MARGIN
      || sample.maxZ < sensorBox.minZ - WORLD_SENSOR_SWEEP_BOUNDS_MARGIN
      || sample.minX > sensorMaxX + WORLD_SENSOR_SWEEP_BOUNDS_MARGIN
      || sample.minY > sensorMaxY + WORLD_SENSOR_SWEEP_BOUNDS_MARGIN
      || sample.minZ > sensorMaxZ + WORLD_SENSOR_SWEEP_BOUNDS_MARGIN
    ) continue;
    const preparedAxes = sample.satAxes ??= prepareOrientedBoxAabbSatAxes(
      sample,
      sample.halfX,
      sample.halfY,
      sample.halfZ
    );
    const contact = findOrientedBoxAabbContactNormal(
      preparedAxes,
      sample.centerX - sensorCenterX,
      sample.centerY - sensorCenterY,
      sample.centerZ - sensorCenterZ,
      sensorHalfX,
      sensorHalfY,
      sensorHalfZ,
      WORLD_SENSOR_SWEEP_BOUNDS_MARGIN
    );
    if (!contact) continue;
    return {
      bodyX: sample.bodyX,
      bodyY: sample.bodyY,
      bodyZ: sample.bodyZ,
      normalX: contact.normalX,
      normalY: contact.normalY,
      normalZ: contact.normalZ,
      pointX: clamp(
        sample.centerX,
        sensorBox.minX + WORLD_SENSOR_SWEEP_BOUNDS_MARGIN,
        sensorMaxX - WORLD_SENSOR_SWEEP_BOUNDS_MARGIN
      ),
      pointY: clamp(
        sample.centerY,
        sensorBox.minY + WORLD_SENSOR_SWEEP_BOUNDS_MARGIN,
        sensorMaxY - WORLD_SENSOR_SWEEP_BOUNDS_MARGIN
      ),
      pointZ: clamp(
        sample.centerZ,
        sensorBox.minZ + WORLD_SENSOR_SWEEP_BOUNDS_MARGIN,
        sensorMaxZ - WORLD_SENSOR_SWEEP_BOUNDS_MARGIN
      ),
      time: sample.time
    };
  }
  return undefined;
}

export function integerBoundsOverlapGreedyBox(bounds: IntegerBounds, box: GreedyBox): boolean {
  return bounds.minX <= box.minX + box.sizeX - 1
    && bounds.maxX >= box.minX
    && bounds.minY <= box.minY + box.sizeY - 1
    && bounds.maxY >= box.minY
    && bounds.minZ <= box.minZ + box.sizeZ - 1
    && bounds.maxZ >= box.minZ;
}
