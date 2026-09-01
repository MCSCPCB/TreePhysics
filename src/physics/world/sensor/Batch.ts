import type { Vector3 } from "@minecraft/server";
import type { PhysicsCollisionTag } from "@src/physics/core/Types";

export interface IndexedWorldSensorHit {
  readonly collisionTag?: PhysicsCollisionTag;
  readonly impactSpeed: number;
  readonly normal: Vector3;
  readonly point: Vector3;
  readonly worldBlockLocation: Vector3;
}

// Side channel that rides indexed-world-sensor hits alongside a public collision
// event without widening the public event type: the kernel dispatcher
// (physics.ts #emitCollision) attaches the hits keyed by the event object it is
// about to emit, and gameplay code (contraption-lifecycle handleCollision) reads
// them back from that same object. Keying the WeakMap by the event lets the hits
// be garbage-collected together with the event once every listener is done.
const hitsByCollisionEvent = new WeakMap<object, readonly IndexedWorldSensorHit[]>();

export function attachIndexedWorldSensorHits(
  event: object,
  hits: readonly IndexedWorldSensorHit[]
): void {
  hitsByCollisionEvent.set(event, hits);
}

export function getIndexedWorldSensorHits(
  event: object
): readonly IndexedWorldSensorHit[] | undefined {
  return hitsByCollisionEvent.get(event);
}
