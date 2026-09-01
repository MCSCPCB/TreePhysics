import type { Vector3 } from "@minecraft/server";
import type { PhysicsCollisionTag } from "@src/physics/core/Types";
import type { CannonKernelBody, CannonKernelRuntime } from "@src/physics/simulation/CannonKernel";

export interface CannonKernelStepAfterEvent {
  currentTick: number;
  fixedTimeStep: number;
  runtime: CannonKernelRuntime;
}

export interface CannonKernelCollisionAfterEvent {
  body: CannonKernelBody;
  collisionTag?: PhysicsCollisionTag;
  currentTick: number;
  impactSpeed: number;
  indexedWorldSensorHits?: readonly CannonKernelIndexedWorldSensorHit[];
  normal: Vector3;
  otherBody?: CannonKernelBody;
  otherCollisionTag?: PhysicsCollisionTag;
  point: Vector3;
}

export interface CannonKernelIndexedWorldSensorHit {
  readonly collisionTag?: PhysicsCollisionTag;
  readonly impactSpeed: number;
  readonly normal: Vector3;
  readonly point: Vector3;
  readonly worldBlockLocation: Vector3;
}

export interface CannonKernelWaterEntryAfterEvent {
  body: CannonKernelBody;
  fastestContactVelocityY: number;
  maxContactX: number;
  maxContactZ: number;
  minContactX: number;
  minContactZ: number;
  point: Vector3;
  timeStep: number;
  bodyAabbSizeX: number;
  bodyAabbSizeZ: number;
}

export interface CannonKernelLavaEntryAfterEvent extends CannonKernelWaterEntryAfterEvent {}

type CannonKernelEventCallback<T> = (event: T) => void;

class CannonKernelAfterEventSignal<T> {
  readonly #callbacks = new Set<CannonKernelEventCallback<T>>();

  subscribe(callback: CannonKernelEventCallback<T>): CannonKernelEventCallback<T> {
    this.#callbacks.add(callback);
    return callback;
  }

  unsubscribe(callback: CannonKernelEventCallback<T>): void {
    this.#callbacks.delete(callback);
  }

  emit(event: T): void {
    for (const callback of this.#callbacks) callback(event);
  }
}

export class CannonKernelAfterEvents {
  readonly collision = new CannonKernelAfterEventSignal<CannonKernelCollisionAfterEvent>();
  readonly lavaEntry = new CannonKernelAfterEventSignal<CannonKernelLavaEntryAfterEvent>();
  readonly step = new CannonKernelAfterEventSignal<CannonKernelStepAfterEvent>();
  readonly waterEntry = new CannonKernelAfterEventSignal<CannonKernelWaterEntryAfterEvent>();
}
