export interface OrientedBoxRotationMatrix {
  readonly r00: number;
  readonly r01: number;
  readonly r02: number;
  readonly r10: number;
  readonly r11: number;
  readonly r12: number;
  readonly r20: number;
  readonly r21: number;
  readonly r22: number;
}

export interface OrientedBoxAabbContactNormal {
  readonly normalX: number;
  readonly normalY: number;
  readonly normalZ: number;
}

const AXIS_EPSILON = 1e-10;
const AXIS_STRIDE = 7;
const MAXIMUM_AXIS_COUNT = 15;
const AXIS_COUNT_INDEX = 0;
const FIRST_AXIS_INDEX = 1;

export function prepareOrientedBoxAabbSatAxes(
  rotation: OrientedBoxRotationMatrix,
  halfX: number,
  halfY: number,
  halfZ: number
): Float64Array {
  const axes = new Float64Array(FIRST_AXIS_INDEX + MAXIMUM_AXIS_COUNT * AXIS_STRIDE);
  let count = 0;
  count = appendAxis(axes, count, rotation.r00, rotation.r10, rotation.r20, rotation, halfX, halfY, halfZ);
  count = appendAxis(axes, count, rotation.r01, rotation.r11, rotation.r21, rotation, halfX, halfY, halfZ);
  count = appendAxis(axes, count, rotation.r02, rotation.r12, rotation.r22, rotation, halfX, halfY, halfZ);
  count = appendAxis(axes, count, 1, 0, 0, rotation, halfX, halfY, halfZ);
  count = appendAxis(axes, count, 0, 1, 0, rotation, halfX, halfY, halfZ);
  count = appendAxis(axes, count, 0, 0, 1, rotation, halfX, halfY, halfZ);
  count = appendCrossAxes(axes, count, rotation.r00, rotation.r10, rotation.r20, rotation, halfX, halfY, halfZ);
  count = appendCrossAxes(axes, count, rotation.r01, rotation.r11, rotation.r21, rotation, halfX, halfY, halfZ);
  count = appendCrossAxes(axes, count, rotation.r02, rotation.r12, rotation.r22, rotation, halfX, halfY, halfZ);
  axes[AXIS_COUNT_INDEX] = count;
  return axes;
}

export function findOrientedBoxAabbContactNormal(
  preparedAxes: Float64Array,
  deltaX: number,
  deltaY: number,
  deltaZ: number,
  sensorHalfX: number,
  sensorHalfY: number,
  sensorHalfZ: number,
  separationMargin: number
): OrientedBoxAabbContactNormal | undefined {
  let minimumOverlap = Number.POSITIVE_INFINITY;
  let normalX = 0;
  let normalY = 1;
  let normalZ = 0;
  const axisCount = preparedAxes[AXIS_COUNT_INDEX]!;
  let offset = FIRST_AXIS_INDEX;
  for (let index = 0; index < axisCount; index++, offset += AXIS_STRIDE) {
    const axisX = preparedAxes[offset]!;
    const axisY = preparedAxes[offset + 1]!;
    const axisZ = preparedAxes[offset + 2]!;
    const distance = deltaX * axisX + deltaY * axisY + deltaZ * axisZ;
    const sensorRadius = sensorHalfX * preparedAxes[offset + 3]!
      + sensorHalfY * preparedAxes[offset + 4]!
      + sensorHalfZ * preparedAxes[offset + 5]!;
    const overlap = preparedAxes[offset + 6]! + sensorRadius - Math.abs(distance);
    if (overlap < -separationMargin) return undefined;
    if (overlap < minimumOverlap) {
      const direction = distance < 0 ? -1 : 1;
      minimumOverlap = overlap;
      normalX = axisX * direction;
      normalY = axisY * direction;
      normalZ = axisZ * direction;
    }
  }
  return { normalX, normalY, normalZ };
}

function appendCrossAxes(
  axes: Float64Array,
  count: number,
  axisX: number,
  axisY: number,
  axisZ: number,
  rotation: OrientedBoxRotationMatrix,
  halfX: number,
  halfY: number,
  halfZ: number
): number {
  count = appendAxis(axes, count, 0, axisZ, -axisY, rotation, halfX, halfY, halfZ);
  count = appendAxis(axes, count, -axisZ, 0, axisX, rotation, halfX, halfY, halfZ);
  return appendAxis(axes, count, axisY, -axisX, 0, rotation, halfX, halfY, halfZ);
}

function appendAxis(
  axes: Float64Array,
  count: number,
  axisX: number,
  axisY: number,
  axisZ: number,
  rotation: OrientedBoxRotationMatrix,
  halfX: number,
  halfY: number,
  halfZ: number
): number {
  const length = Math.hypot(axisX, axisY, axisZ);
  if (length <= AXIS_EPSILON) return count;
  const unitX = axisX / length;
  const unitY = axisY / length;
  const unitZ = axisZ / length;
  const offset = FIRST_AXIS_INDEX + count * AXIS_STRIDE;
  axes[offset] = unitX;
  axes[offset + 1] = unitY;
  axes[offset + 2] = unitZ;
  axes[offset + 3] = Math.abs(unitX);
  axes[offset + 4] = Math.abs(unitY);
  axes[offset + 5] = Math.abs(unitZ);
  axes[offset + 6] = halfX * Math.abs(
    rotation.r00 * unitX + rotation.r10 * unitY + rotation.r20 * unitZ
  ) + halfY * Math.abs(
    rotation.r01 * unitX + rotation.r11 * unitY + rotation.r21 * unitZ
  ) + halfZ * Math.abs(
    rotation.r02 * unitX + rotation.r12 * unitY + rotation.r22 * unitZ
  );
  return count + 1;
}
