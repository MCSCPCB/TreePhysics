import type { Vector3 } from "@minecraft/server";
import type { PhysicsContraption } from "@src/Physics";
import {
  CONTRAPTION_OUTLINE_EDGE_CAPACITY,
  type ContraptionOutlineEdge
} from "@src/render/outline/Geometry";
import { EPSILON_1E8 } from "@src/utils/Vector3Math";

const BREAK_OVERLAY_CENTER_HEIGHT = 0.375;
const RAY_REFRESH_TICKS = 2;
const BLOCK_CONFIRMATION_TICKS = 50;
const VIEW_DIRECTION_EPSILON_SQUARED = 1e-10;
const BREAK_OVERLAY_TRANSFORM_EPSILON_SQUARED = EPSILON_1E8;

export interface BlockPreviewTransform {
  side: number;
  x: number;
  y: number;
  z: number;
}

export function hasViewDirectionChanged(previous: Vector3, current: Vector3): boolean {
  const dx = previous.x - current.x;
  const dy = previous.y - current.y;
  const dz = previous.z - current.z;
  return dx * dx + dy * dy + dz * dz > VIEW_DIRECTION_EPSILON_SQUARED;
}

export function vectorComponentsEqual(left: Vector3, right: Vector3): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

export function shouldEnterBlockPreview(mode: "contraption" | "block" | undefined, stableTicks: number, viewChanged: boolean): boolean {
  return mode === "contraption" && (viewChanged || stableTicks >= BLOCK_CONFIRMATION_TICKS);
}

export function shouldRefreshOutlineRay(mode: "contraption" | "block" | undefined, ticksSinceRefresh: number, viewChanged: boolean, contraptionMoving: boolean): boolean {
  return viewChanged || (mode === "block" ? contraptionMoving : ticksSinceRefresh >= RAY_REFRESH_TICKS);
}

/** Encode a one- or two-cell preview as one center and an optional adjacent side. */
export function createBlockPreviewTransform(target: Vector3, placement: Vector3 | undefined, visualAnchor: Vector3): BlockPreviewTransform {
  let side = 0;
  if (placement) {
    const dx = placement.x - target.x;
    const dy = placement.y - target.y;
    const dz = placement.z - target.z;
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) !== 1) throw new RangeError("Block preview placement must be adjacent to its target cell.");
    // Face encoding contract with the client render controller: the signed
    // axis index x -> +/-1, y -> +/-2, z -> +/-3 (0 = no placement cell) is decoded
    // from the preview_side entity property, so these exact values matter.
    side = dx !== 0 ? dx : dy !== 0 ? dy * 2 : dz * 3;
  }
  return { side, x: target.x - visualAnchor.x, y: target.y - visualAnchor.y, z: target.z - visualAnchor.z };
}

/** Reject placement only when the player's head enters the new contraption cell. */
export function isPlayerHeadInsideContraptionPlacement(headLocation: Vector3, placement: Vector3, worldPointToLocal: (point: Vector3) => Vector3): boolean {
  if (!isFiniteVector(headLocation)) throw new TypeError("Player head location must contain finite coordinates.");
  if (!isFiniteVector(placement)) throw new TypeError("Contraption placement must contain finite coordinates.");
  const local = worldPointToLocal(headLocation);
  if (!isFiniteVector(local)) throw new TypeError("Contraption placement transform returned a non-finite point.");
  return Math.abs(local.x - placement.x) < 0.5 && Math.abs(local.y - placement.y) < 0.5 && Math.abs(local.z - placement.z) < 0.5;
}

/** Entity locations are feet-based; center the crack geometry on the selected cell. */
export function breakOverlayLocation(cellCenter: Vector3): Vector3 {
  return { x: cellCenter.x, y: cellCenter.y - BREAK_OVERLAY_CENTER_HEIGHT, z: cellCenter.z };
}

export function createEdgeWriteExpression(edges: readonly ContraptionOutlineEdge[], visualAnchor: Vector3): string {
  if (edges.length > CONTRAPTION_OUTLINE_EDGE_CAPACITY) throw new RangeError(`Outline has ${edges.length} edges; capacity is ${CONTRAPTION_OUTLINE_EDGE_CAPACITY}.`);
  const values: string[] = [];
  for (let index = 0; index < CONTRAPTION_OUTLINE_EDGE_CAPACITY; index++) {
    const edge = edges[index];
    const prefix = `v.e${index}`;
    if (!edge) { values.push(`${prefix}_l=0`); continue; }
    values.push(`${prefix}_x=${molangNumber(edge.start.x - visualAnchor.x)}`, `${prefix}_y=${molangNumber(edge.start.y - visualAnchor.y)}`, `${prefix}_z=${molangNumber(edge.start.z - visualAnchor.z)}`, `${prefix}_l=${molangNumber(edge.length)}`, `${prefix}_a=${edge.axis === "x" ? 0 : edge.axis === "y" ? 1 : 2}`);
  }
  // Complex Molang expressions default to 0 without an explicit return. Stop
  // the looping writer after every edge variable has been assigned once.
  return `${values.join(";")};return 1;`;
}

export function edgeSignature(edges: readonly ContraptionOutlineEdge[]): string {
  return edges.map(edge => `${edge.axis}:${edge.start.x},${edge.start.y},${edge.start.z}:${edge.length}`).join("|");
}

function molangNumber(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError(`Outline transform contains ${value}.`);
  return Object.is(value, -0) ? "0" : String(value);
}

export function resolvePlacementCardinalDirection(contraption: PhysicsContraption, worldOrigin: Vector3, worldViewDirection: Vector3): "north" | "east" | "south" | "west" {
  const localOrigin = contraption.body.worldPointToLocal(worldOrigin);
  const localViewPoint = contraption.body.worldPointToLocal({ x: worldOrigin.x + worldViewDirection.x, y: worldOrigin.y + worldViewDirection.y, z: worldOrigin.z + worldViewDirection.z });
  const dx = localViewPoint.x - localOrigin.x;
  const dz = localViewPoint.z - localOrigin.z;
  // The fragment's cardinal-direction visual faces along the placement ray in contraption-local space.
  if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? "east" : "west";
  return dz >= 0 ? "south" : "north";
}

function isFiniteVector(value: Vector3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

export { RAY_REFRESH_TICKS, BREAK_OVERLAY_TRANSFORM_EPSILON_SQUARED };
