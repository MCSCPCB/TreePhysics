export interface GreedyBox {
  readonly collisionResponse: boolean;
  readonly materialId: string;
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
}

/**
 * Dense incremental mesher for per-tick world scans. This deliberately differs
 * from contraption-mesher.meshVoxels, whose deterministic search minimizes box count.
 */
export class GreedyBoxMesher {
  readonly #cellCount: number;
  readonly #defaultGroupValue: number;
  readonly #groups: Uint32Array;
  readonly #strideX: number;
  readonly #strideZ: number;
  readonly #strideXZ: number;
  readonly #voxels: Uint8Array;

  constructor(
    readonly sizeX: number,
    readonly sizeY: number,
    readonly sizeZ: number,
    readonly materialId = "world_block",
    readonly collisionResponse = true
  ) {
    this.#cellCount = sizeX * sizeY * sizeZ;
    this.#strideX = sizeX + 1;
    this.#strideZ = sizeZ + 1;
    this.#strideXZ = this.#strideX * this.#strideZ;
    this.#defaultGroupValue = 1 + this.#strideX + this.#strideXZ;
    this.#voxels = new Uint8Array(this.#cellCount);
    this.#groups = new Uint32Array(this.#cellCount);
  }

  setVoxel(x: number, y: number, z: number): void {
    this.#voxels[x + z * this.sizeX + y * this.sizeX * this.sizeZ] = 1;
  }

  meshBoxes(originX: number, originY: number, originZ: number): GreedyBox[] {
    const groups = this.buildGroups();
    const boxes: GreedyBox[] = [];
    for (let y = 0; y < this.sizeY; y++) {
      const yBase = y * this.sizeX * this.sizeZ;
      for (let z = 0; z < this.sizeZ; z++) {
        const rowBase = yBase + z * this.sizeX;
        for (let x = 0; x < this.sizeX; x++) {
          const group = groups[rowBase + x];
          if (group === 0) continue;
          const sizeX = group % this.#strideX;
          const sizeZ = Math.floor(group / this.#strideX) % this.#strideZ;
          const sizeY = Math.floor(group / this.#strideXZ) % (this.sizeY + 1);
          boxes.push({
            collisionResponse: this.collisionResponse,
            materialId: this.materialId,
            minX: originX + x + 1 - sizeX,
            minY: originY + y + 1 - sizeY,
            minZ: originZ + z + 1 - sizeZ,
            sizeX,
            sizeY,
            sizeZ
          });
        }
      }
    }
    return boxes;
  }

  private buildGroups(): Uint32Array {
    const groups = this.#groups;
    const voxels = this.#voxels;
    for (let index = 0; index < this.#cellCount; index++) {
      groups[index] = voxels[index] === 0 ? 0 : this.#defaultGroupValue;
    }
    for (let y = 0; y < this.sizeY; y++) {
      const yBase = y * this.sizeX * this.sizeZ;
      for (let z = 0; z < this.sizeZ; z++) {
        const rowBase = yBase + z * this.sizeX;
        for (let x = 1; x < this.sizeX; x++) {
          const index = rowBase + x;
          if (voxels[index] === 0 || voxels[index - 1] === 0 || groups[index - 1] === 0) continue;
          groups[index] += groups[index - 1] % this.#strideX;
          groups[index - 1] = 0;
        }
      }
    }
    for (let y = 0; y < this.sizeY; y++) {
      const yBase = y * this.sizeX * this.sizeZ;
      for (let z = 1; z < this.sizeZ; z++) {
        const rowBase = yBase + z * this.sizeX;
        const previousRowBase = rowBase - this.sizeX;
        for (let x = 0; x < this.sizeX; x++) {
          const index = rowBase + x;
          const previousIndex = previousRowBase + x;
          const previousGroup = groups[previousIndex];
          const currentGroup = groups[index];
          if (voxels[index] === 0 || voxels[previousIndex] === 0 || previousGroup === 0
            || currentGroup === 0 || previousGroup % this.#strideX !== currentGroup % this.#strideX) continue;
          groups[index] += (Math.floor(previousGroup / this.#strideX) % this.#strideZ) * this.#strideX;
          groups[previousIndex] = 0;
        }
      }
    }
    for (let y = 1; y < this.sizeY; y++) {
      const yBase = y * this.sizeX * this.sizeZ;
      const previousYBase = yBase - this.sizeX * this.sizeZ;
      for (let z = 0; z < this.sizeZ; z++) {
        const rowBase = yBase + z * this.sizeX;
        const previousRowBase = previousYBase + z * this.sizeX;
        for (let x = 0; x < this.sizeX; x++) {
          const index = rowBase + x;
          const previousIndex = previousRowBase + x;
          const previousGroup = groups[previousIndex];
          const currentGroup = groups[index];
          if (voxels[index] === 0 || voxels[previousIndex] === 0 || previousGroup === 0
            || currentGroup === 0 || previousGroup % this.#strideX !== currentGroup % this.#strideX
            || Math.floor(previousGroup / this.#strideX) % this.#strideZ
              !== Math.floor(currentGroup / this.#strideX) % this.#strideZ) continue;
          groups[index] += (Math.floor(previousGroup / this.#strideXZ) % (this.sizeY + 1)) * this.#strideXZ;
          groups[previousIndex] = 0;
        }
      }
    }
    return groups;
  }
}
