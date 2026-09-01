import { world, type World } from "@minecraft/server";

const DEFAULT_CHUNK_SIZE = 30000;

export interface DynamicPropertyTarget {
  getDynamicProperty(identifier: string): boolean | number | string | object | undefined;
  setDynamicProperty(identifier: string, value?: boolean | number | string | object): void;
}

export type DynamicPropertySaveResult = "failed" | "saved" | "unchanged";

interface ActiveManifest {
  byteCount: number;
  chunkCount: number;
  generation: string;
}

/** Atomic, generation-based JSON storage backed by world dynamic properties. */
export class DynamicPropertyJsonStore {
  #lastJson: string | undefined;
  #nextGeneration = 1;

  constructor(
    readonly prefix: string,
    readonly chunkSize = DEFAULT_CHUNK_SIZE,
    readonly target: DynamicPropertyTarget = world as World
  ) {}

  load<T>(): T | undefined {
    try {
      const manifest = this.#getActiveManifest();
      if (!manifest) return undefined;
      let json = "";
      for (let index = 0; index < manifest.chunkCount; index++) {
        const chunk = this.target.getDynamicProperty(
          this.#chunkKey(manifest.generation, index)
        );
        if (typeof chunk !== "string") return undefined;
        json += chunk;
      }
      if (json.length !== manifest.byteCount) return undefined;
      const value = JSON.parse(json) as T;
      this.#lastJson = json;
      return value;
    } catch {
      return undefined;
    }
  }

  saveWithResult<T>(value: T): DynamicPropertySaveResult {
    const json = JSON.stringify(value);
    if (json === this.#lastJson) return "unchanged";
    const chunks = splitIntoChunks(json, this.chunkSize);

    let previous: ActiveManifest | undefined;
    const generation = this.#createGeneration();
    try {
      previous = this.#getActiveManifest();
      // The active manifest changes only after every new chunk is durable.
      for (let index = 0; index < chunks.length; index++) {
        this.target.setDynamicProperty(this.#chunkKey(generation, index), chunks[index]);
      }
      this.target.setDynamicProperty(this.#manifestKey(), serializeManifest({
        byteCount: json.length,
        chunkCount: chunks.length,
        generation
      }));
      this.#lastJson = json;
    } catch {
      return "failed";
    }

    // The new manifest is already the transaction commit point. Failure to
    // reclaim unreachable chunks must not report the committed value as failed.
    if (previous && previous.generation !== generation) {
      this.#tryDeleteGeneration(previous.generation, previous.chunkCount);
    }
    return "saved";
  }

  clear(): boolean {
    let manifest: ActiveManifest | undefined;
    try {
      manifest = this.#getActiveManifest();
      // Removing the active manifest commits the clear before stale chunks are
      // reclaimed, mirroring saveWithResult's generation transaction.
      this.target.setDynamicProperty(this.#manifestKey());
      this.#lastJson = undefined;
    } catch {
      return false;
    }
    // Reclaiming stale chunks happens after the clear is committed, so a
    // failure here does not make the committed clear ambiguous.
    if (manifest) this.#tryDeleteGeneration(manifest.generation, manifest.chunkCount);
    return true;
  }

  /** Best-effort reclamation of a superseded generation's chunk properties. */
  #tryDeleteGeneration(generation: string, chunkCount: number): void {
    try {
      for (let index = 0; index < chunkCount; index++) {
        this.target.setDynamicProperty(this.#chunkKey(generation, index));
      }
    } catch {
      // Unreachable old chunks do not affect the committed active state.
    }
  }

  #createGeneration(): string {
    return `${Date.now().toString(36)}_${(this.#nextGeneration++).toString(36)}`;
  }

  #getActiveManifest(): ActiveManifest | undefined {
    const raw = this.target.getDynamicProperty(this.#manifestKey());
    return typeof raw === "string" ? parseManifest(raw) : undefined;
  }

  #manifestKey(): string {
    return `${this.prefix}_active`;
  }

  #chunkKey(generation: string, index: number): string {
    return `${this.prefix}_g_${generation}_${index}`;
  }
}

function serializeManifest(manifest: ActiveManifest): string {
  return [
    manifest.generation,
    manifest.chunkCount,
    manifest.byteCount
  ].join("|");
}

function parseManifest(value: string): ActiveManifest | undefined {
  const [generation, chunks, bytes, extra] = value.split("|");
  const chunkCount = Number.parseInt(chunks ?? "", 10);
  const byteCount = Number.parseInt(bytes ?? "", 10);
  if (
    !generation
    || extra !== undefined
    || !Number.isFinite(chunkCount)
    || !Number.isFinite(byteCount)
    || chunkCount < 1
    || byteCount < 0
  ) return undefined;
  return { byteCount, chunkCount, generation };
}

// `value` is always JSON.stringify output of a defined value (never empty) and
// `size` is a positive integer from the constructor, so at least one chunk is
// produced and the loop always terminates.
function splitIntoChunks(value: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks;
}
