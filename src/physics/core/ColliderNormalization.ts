// Collider normalization and convex-polyhedron validation for the cannon kernel:
// converts user collider definitions into the normalized shape records and
// cannon-es shapes the runtime consumes. Extracted from cannon-kernel.ts.
import type { Vector3 } from "@minecraft/server";
import {
  Box,
  ConvexPolyhedron,
  Cylinder,
  type Quaternion,
  type Shape,
  Sphere,
  Vec3
} from "cannon-es";
import type {
  PhysicsBodyCompoundChildCollider,
  PhysicsBodyCompoundColliderChild,
  PhysicsBodyOptions,
  PhysicsCollisionTag
} from "@src/physics/core/Types";
import {
  dot,
  isFiniteVector as isFiniteVector3,
  subtract
} from "@src/utils/Vector3Math";
import { toCannonQuaternion } from "@src/physics/motion/KernelMath";

const DEFAULT_BODY_BOX_SIZE = 1;
export const DEFAULT_BODY_BOX_HALF_EXTENT = DEFAULT_BODY_BOX_SIZE / 2;

export interface NormalizedBoxCollider {
  readonly halfExtents: Vector3;
  readonly type: "box";
}

export interface NormalizedSphereCollider {
  readonly radius: number;
  readonly type: "sphere";
}

export interface NormalizedCylinderCollider {
  readonly height: number;
  readonly radiusBottom: number;
  readonly radiusTop: number;
  readonly segments: number;
  readonly type: "cylinder";
}

export interface NormalizedConvexCollider {
  readonly faces: readonly (readonly number[])[];
  readonly type: "convex";
  readonly vertices: readonly Vector3[];
}

export type NormalizedPrimitiveCollider =
  | NormalizedBoxCollider
  | NormalizedSphereCollider
  | NormalizedCylinderCollider
  | NormalizedConvexCollider;

export interface NormalizedColliderShape {
  readonly centroid: Vector3;
  readonly collisionTag?: PhysicsCollisionTag;
  readonly collisionResponse?: boolean;
  readonly localBoundsMax: Vector3;
  readonly localBoundsMin: Vector3;
  readonly location: Vector3;
  readonly primitive: NormalizedPrimitiveCollider;
  readonly rotation: Vector3;
  readonly volume: number;
}

export interface NormalizedBoxColliderShape extends NormalizedColliderShape {
  readonly primitive: NormalizedBoxCollider;
}

export interface NormalizedBodyCollider {
  readonly boundingHalfExtents: Vector3;
  readonly localCenter: Vector3;
  readonly shapes: readonly NormalizedColliderShape[];
}

export function normalizeBodyCollider(options: PhysicsBodyOptions): NormalizedBodyCollider {
  const declared = options.collider;
  const solid = declared?.type === "sensor" ? declared.collider : declared;
  const normalizedShapes = solid?.type === "compound"
    ? normalizeCompoundShapes(solid.children)
    : [normalizePrimitiveShape(solid, options.size)];
  const shapes = declared?.type === "sensor"
    ? normalizedShapes.map(shape => ({ ...shape, collisionResponse: false }))
    : normalizedShapes;
  const bounds = combineShapeBounds(shapes);
  const localCenter = computeColliderCenterOfMass(shapes);
  return {
    boundingHalfExtents: {
      x: (bounds.max.x - bounds.min.x) / 2,
      y: (bounds.max.y - bounds.min.y) / 2,
      z: (bounds.max.z - bounds.min.z) / 2
    },
    localCenter,
    shapes
  };
}

function normalizeCompoundShapes(
  children: readonly PhysicsBodyCompoundColliderChild[]
): NormalizedColliderShape[] {
  if (!Array.isArray(children)) {
    throw new TypeError("PhysicsBodyCompoundCollider.children must be an array.");
  }
  if (children.length === 0) {
    throw new RangeError("PhysicsBodyCompoundCollider.children must contain at least one collider.");
  }
  return children.map((child, index) => normalizeCompoundChild(child, index));
}

function normalizeCompoundChild(
  child: PhysicsBodyCompoundColliderChild,
  index: number
): NormalizedColliderShape {
  if (!child || typeof child !== "object" || !child.collider) {
    throw new TypeError(`PhysicsBodyCompoundCollider.children[${index}] is invalid.`);
  }
  const childType = (child.collider as { readonly type?: unknown }).type;
  if (!["box", "sphere", "cylinder", "convex"].includes(String(childType))) {
    throw new TypeError(
      `PhysicsBodyCompoundCollider.children[${index}] must contain a non-compound solid collider.`
    );
  }
  const childLocation = child.location ?? { x: 0, y: 0, z: 0 };
  const childRotation = child.rotation ?? { x: 0, y: 0, z: 0 };
  if (!isFiniteVector3(childLocation) || !isFiniteVector3(childRotation)) {
    throw new TypeError(
      `PhysicsBodyCompoundCollider.children[${index}] location and rotation must be finite.`
    );
  }
  const shape = normalizePrimitiveShape(child.collider);
  const orientation = toCannonQuaternion(childRotation);
  const location = rotateAndTranslate(shape.location, orientation, childLocation);
  const centroid = rotateAndTranslate(shape.centroid, orientation, childLocation);
  const bounds = transformBounds(
    shape.localBoundsMin,
    shape.localBoundsMax,
    orientation,
    childLocation
  );
  return {
    centroid,
    collisionTag: child.collisionTag,
    collisionResponse: child.collisionResponse !== false,
    localBoundsMax: bounds.max,
    localBoundsMin: bounds.min,
    location,
    primitive: shape.primitive,
    rotation: { ...childRotation },
    volume: shape.volume
  };
}

function normalizePrimitiveShape(
  collider: PhysicsBodyCompoundChildCollider | undefined,
  bodySize?: Vector3
): NormalizedColliderShape {
  if (collider?.type === "sphere") {
    const radius = normalizeColliderLength(collider.radius, DEFAULT_BODY_BOX_HALF_EXTENT);
    const center = { x: 0, y: radius, z: 0 };
    return {
      centroid: center,
      localBoundsMax: { x: radius, y: radius * 2, z: radius },
      localBoundsMin: { x: -radius, y: 0, z: -radius },
      location: center,
      primitive: { radius, type: "sphere" },
      rotation: { x: 0, y: 0, z: 0 },
      volume: 4 * Math.PI * radius * radius * radius / 3
    };
  }

  if (collider?.type === "cylinder") {
    const fallbackRadius = normalizeColliderLength(
      collider.radius,
      DEFAULT_BODY_BOX_HALF_EXTENT
    );
    const radiusTop = normalizeColliderLength(collider.radiusTop, fallbackRadius);
    const radiusBottom = normalizeColliderLength(collider.radiusBottom, fallbackRadius);
    const height = normalizeColliderLength(collider.height, DEFAULT_BODY_BOX_SIZE);
    const maximumRadius = Math.max(radiusTop, radiusBottom);
    const radiusTerm = radiusBottom * radiusBottom
      + radiusBottom * radiusTop
      + radiusTop * radiusTop;
    return {
      centroid: { x: 0, y: height / 2, z: 0 },
      localBoundsMax: { x: maximumRadius, y: height, z: maximumRadius },
      localBoundsMin: { x: -maximumRadius, y: 0, z: -maximumRadius },
      location: { x: 0, y: height / 2, z: 0 },
      primitive: {
        height,
        radiusBottom,
        radiusTop,
        segments: 12,
        type: "cylinder"
      },
      rotation: { x: 0, y: 0, z: 0 },
      volume: Math.PI * height * radiusTerm / 3
    };
  }

  if (collider?.type === "convex") {
    return normalizeConvexShape(collider.vertices, collider.faces);
  }

  const halfExtents = normalizeBoxHalfExtents(
    collider?.type === "box" ? collider : undefined,
    bodySize
  );
  const center = { x: 0, y: halfExtents.y, z: 0 };
  return {
    centroid: center,
    localBoundsMax: { x: halfExtents.x, y: halfExtents.y * 2, z: halfExtents.z },
    localBoundsMin: { x: -halfExtents.x, y: 0, z: -halfExtents.z },
    location: center,
    primitive: { halfExtents, type: "box" },
    rotation: { x: 0, y: 0, z: 0 },
    volume: halfExtents.x * halfExtents.y * halfExtents.z * 8
  };
}

function normalizeConvexShape(
  inputVertices: readonly Vector3[],
  inputFaces: readonly (readonly number[])[]
): NormalizedColliderShape {
  if (!Array.isArray(inputVertices) || !Array.isArray(inputFaces)) {
    throw new TypeError("PhysicsBodyConvexCollider vertices and faces must be arrays.");
  }
  if (inputVertices.length < 4 || inputFaces.length < 4) {
    throw new RangeError("PhysicsBodyConvexCollider requires at least four vertices and four faces.");
  }
  const vertices = inputVertices.map((vertex, index) => {
    if (!vertex || !isFiniteVector3(vertex)) {
      throw new TypeError(`PhysicsBodyConvexCollider.vertices[${index}] must be finite.`);
    }
    return { x: vertex.x, y: vertex.y, z: vertex.z };
  });
  for (let left = 0; left < vertices.length; left++) {
    for (let right = left + 1; right < vertices.length; right++) {
      const delta = subtract(vertices[left]!, vertices[right]!);
      if (Math.hypot(delta.x, delta.y, delta.z) <= 1e-9) {
        throw new RangeError("PhysicsBodyConvexCollider vertices must be unique.");
      }
    }
  }
  const interior = vertices.reduce(
    (sum, vertex) => ({
      x: sum.x + vertex.x / vertices.length,
      y: sum.y + vertex.y / vertices.length,
      z: sum.z + vertex.z / vertices.length
    }),
    { x: 0, y: 0, z: 0 }
  );
  const edgeCounts = new Map<string, number>();
  const usedVertices = new Set<number>();
  const faces = inputFaces.map((face, faceIndex) => {
    if (!Array.isArray(face)) {
      throw new TypeError(`PhysicsBodyConvexCollider.faces[${faceIndex}] must be an array.`);
    }
    const sourceFace = face as readonly number[];
    if (sourceFace.length < 3 || new Set(sourceFace).size !== sourceFace.length) {
      throw new RangeError(
        `PhysicsBodyConvexCollider.faces[${faceIndex}] must contain at least three unique indices.`
      );
    }
    const normalizedFace = Array.from(sourceFace);
    for (const index of normalizedFace) {
      if (!Number.isInteger(index) || index < 0 || index >= vertices.length) {
        throw new RangeError(
          `PhysicsBodyConvexCollider.faces[${faceIndex}] contains an invalid vertex index.`
        );
      }
      usedVertices.add(index);
    }
    validateConvexFace(vertices, normalizedFace, faceIndex, interior);
    for (let index = 0; index < normalizedFace.length; index++) {
      const left = normalizedFace[index]!;
      const right = normalizedFace[(index + 1) % normalizedFace.length]!;
      const key = left < right ? `${left}:${right}` : `${right}:${left}`;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
    return normalizedFace;
  });
  for (const count of edgeCounts.values()) {
    if (count !== 2) {
      throw new RangeError("PhysicsBodyConvexCollider faces must form a closed manifold.");
    }
  }
  if (usedVertices.size !== vertices.length) {
    throw new RangeError("Every PhysicsBodyConvexCollider vertex must be used by a face.");
  }
  const mass = computeConvexVolumeAndCentroid(vertices, faces);
  const bounds = getVertexBounds(vertices);
  return {
    centroid: mass.centroid,
    localBoundsMax: bounds.max,
    localBoundsMin: bounds.min,
    location: { x: 0, y: 0, z: 0 },
    primitive: { faces, type: "convex", vertices },
    rotation: { x: 0, y: 0, z: 0 },
    volume: mass.volume
  };
}

function validateConvexFace(
  vertices: readonly Vector3[],
  face: readonly number[],
  faceIndex: number,
  interior: Vector3
): void {
  const first = vertices[face[0]!]!;
  const second = vertices[face[1]!]!;
  const third = vertices[face[2]!]!;
  const normal = cross(subtract(second, first), subtract(third, first));
  const length = Math.hypot(normal.x, normal.y, normal.z);
  if (length <= 1e-9) {
    throw new RangeError(`PhysicsBodyConvexCollider.faces[${faceIndex}] is degenerate.`);
  }
  const planeTolerance = Math.max(1, length) * 1e-7;
  if (dot(normal, subtract(interior, first)) >= -planeTolerance) {
    throw new RangeError(
      `PhysicsBodyConvexCollider.faces[${faceIndex}] must use outward counter-clockwise winding.`
    );
  }
  const faceIndices = new Set(face);
  for (let index = 0; index < vertices.length; index++) {
    const distance = dot(normal, subtract(vertices[index]!, first));
    if (faceIndices.has(index)) {
      if (Math.abs(distance) > planeTolerance) {
        throw new RangeError(`PhysicsBodyConvexCollider.faces[${faceIndex}] is not planar.`);
      }
    } else if (distance > planeTolerance) {
      throw new RangeError("PhysicsBodyConvexCollider must describe a convex polyhedron.");
    }
  }
}

function computeConvexVolumeAndCentroid(
  vertices: readonly Vector3[],
  faces: readonly (readonly number[])[]
): { readonly centroid: Vector3; readonly volume: number } {
  let signedVolume = 0;
  const centroid = { x: 0, y: 0, z: 0 };
  for (const face of faces) {
    const first = vertices[face[0]!]!;
    for (let index = 1; index < face.length - 1; index++) {
      const second = vertices[face[index]!]!;
      const third = vertices[face[index + 1]!]!;
      const tetraVolume = dot(first, cross(second, third)) / 6;
      signedVolume += tetraVolume;
      centroid.x += (first.x + second.x + third.x) * tetraVolume / 4;
      centroid.y += (first.y + second.y + third.y) * tetraVolume / 4;
      centroid.z += (first.z + second.z + third.z) * tetraVolume / 4;
    }
  }
  if (signedVolume <= 1e-9) {
    throw new RangeError("PhysicsBodyConvexCollider must enclose a positive volume.");
  }
  centroid.x /= signedVolume;
  centroid.y /= signedVolume;
  centroid.z /= signedVolume;
  return { centroid, volume: signedVolume };
}

function getVertexBounds(vertices: readonly Vector3[]): {
  readonly max: Vector3;
  readonly min: Vector3;
} {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const vertex of vertices) {
    min.x = Math.min(min.x, vertex.x);
    min.y = Math.min(min.y, vertex.y);
    min.z = Math.min(min.z, vertex.z);
    max.x = Math.max(max.x, vertex.x);
    max.y = Math.max(max.y, vertex.y);
    max.z = Math.max(max.z, vertex.z);
  }
  return { max, min };
}

function combineShapeBounds(shapes: readonly NormalizedColliderShape[]): {
  readonly max: Vector3;
  readonly min: Vector3;
} {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const shape of shapes) {
    min.x = Math.min(min.x, shape.localBoundsMin.x);
    min.y = Math.min(min.y, shape.localBoundsMin.y);
    min.z = Math.min(min.z, shape.localBoundsMin.z);
    max.x = Math.max(max.x, shape.localBoundsMax.x);
    max.y = Math.max(max.y, shape.localBoundsMax.y);
    max.z = Math.max(max.z, shape.localBoundsMax.z);
  }
  return { max, min };
}

function computeColliderCenterOfMass(shapes: readonly NormalizedColliderShape[]): Vector3 {
  let totalVolume = 0;
  const center = { x: 0, y: 0, z: 0 };
  for (const shape of shapes) {
    totalVolume += shape.volume;
    center.x += shape.centroid.x * shape.volume;
    center.y += shape.centroid.y * shape.volume;
    center.z += shape.centroid.z * shape.volume;
  }
  if (totalVolume <= 0) throw new RangeError("Physics body collider must have positive volume.");
  center.x /= totalVolume;
  center.y /= totalVolume;
  center.z /= totalVolume;
  return center;
}

function transformBounds(
  min: Vector3,
  max: Vector3,
  rotation: Quaternion,
  translation: Vector3
): { readonly max: Vector3; readonly min: Vector3 } {
  const transformed: Vector3[] = [];
  for (const x of [min.x, max.x]) {
    for (const y of [min.y, max.y]) {
      for (const z of [min.z, max.z]) {
        transformed.push(rotateAndTranslate({ x, y, z }, rotation, translation));
      }
    }
  }
  return getVertexBounds(transformed);
}

function rotateAndTranslate(value: Vector3, rotation: Quaternion, translation: Vector3): Vector3 {
  const transformed = new Vec3(value.x, value.y, value.z);
  rotation.vmult(transformed, transformed);
  return {
    x: transformed.x + translation.x,
    y: transformed.y + translation.y,
    z: transformed.z + translation.z
  };
}

function cross(left: Vector3, right: Vector3): Vector3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x
  };
}

function normalizeBoxHalfExtents(
  collider: { readonly halfExtents?: Vector3; readonly size?: Vector3 } | undefined,
  bodySize: Vector3 | undefined
): Vector3 {
  const halfExtents = collider?.halfExtents;
  if (halfExtents) {
    return {
      x: normalizeColliderLength(halfExtents.x, DEFAULT_BODY_BOX_HALF_EXTENT),
      y: normalizeColliderLength(halfExtents.y, DEFAULT_BODY_BOX_HALF_EXTENT),
      z: normalizeColliderLength(halfExtents.z, DEFAULT_BODY_BOX_HALF_EXTENT)
    };
  }
  const size = collider?.size ?? bodySize;
  if (size) {
    return {
      x: normalizeColliderLength(size.x / 2, DEFAULT_BODY_BOX_HALF_EXTENT),
      y: normalizeColliderLength(size.y / 2, DEFAULT_BODY_BOX_HALF_EXTENT),
      z: normalizeColliderLength(size.z / 2, DEFAULT_BODY_BOX_HALF_EXTENT)
    };
  }
  return {
    x: DEFAULT_BODY_BOX_HALF_EXTENT,
    y: DEFAULT_BODY_BOX_HALF_EXTENT,
    z: DEFAULT_BODY_BOX_HALF_EXTENT
  };
}

export function createCannonShape(collider: NormalizedPrimitiveCollider): Shape {
  if (collider.type === "sphere") return new Sphere(collider.radius);
  if (collider.type === "cylinder") {
    return new Cylinder(
      collider.radiusTop,
      collider.radiusBottom,
      collider.height,
      collider.segments
    );
  }
  if (collider.type === "convex") {
    return new ConvexPolyhedron({
      faces: collider.faces.map((face) => Array.from(face)),
      vertices: collider.vertices.map((vertex) => new Vec3(vertex.x, vertex.y, vertex.z))
    });
  }
  return new Box(new Vec3(
    collider.halfExtents.x,
    collider.halfExtents.y,
    collider.halfExtents.z
  ));
}

function normalizeColliderLength(value: number | undefined, fallback: number): number {
  // 0.001 is the smallest accepted collider dimension; shorter inputs are
  // clamped up to it.
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.max(0.001, value)
    : fallback;
}

export function normalizeHalfExtent(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_BODY_BOX_HALF_EXTENT;
}

export function normalizedColliderShapeSignature(shape: NormalizedColliderShape): string {
  return JSON.stringify({
    collisionResponse: shape.collisionResponse !== false,
    collisionTag: shape.collisionTag,
    location: shape.location,
    primitive: shape.primitive,
    rotation: shape.rotation
  });
}
