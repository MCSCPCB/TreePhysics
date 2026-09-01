// Tree fragment visual renderer: mirrors the physics body pose onto bit-packed
// log/leaf/attachment/cube fragment entities riding shared carrier entities.
import { system, type Entity, type Vector3 } from "@minecraft/server";
import { vectorsEqual } from "@src/utils/Vector3Math";
import type { PhysicsContraptionBlock, PhysicsContraptionFoliageTint } from "@src/physics/core/Types";
import {
  CUBE_FRAGMENT_ENTITY_TYPE_ID,
  ATTACHMENT_FRAGMENT_ENTITY_TYPE_ID,
  packFragments,
  readCubeBlockFragmentSlot,
  replaceAttachmentDescriptorState,
  tryCreateCubeBlockFragmentSlot,
  type CubeBlockFragmentSlot,
  type CubeBlockFragmentLayout,
  type PackedFragment,
  type FragmentSlotAssignment
} from "@src/render/contraption/fragment/FragmentLayout";
import {
  attachmentFamilyMask,
  encodeCubeFragmentModes,
  encodeFragmentFamily,
  encodeLogFragmentModes,
  getPackedFragmentOrigin,
  isLeafFragmentEntityTypeId,
  logFragmentModes,
  packAttachmentOriginY
} from "@src/render/contraption/fragment/FragmentCodec";
import { packFragmentFoliageTint } from "@src/render/foliage/TintCodec";
import { findContraptionVisualAnchor } from "@src/render/contraption/shared/VisualAnchor";
import type {
  ContraptionRenderBody,
  ContraptionRenderer
} from "@src/render/contraption/shared/Renderer";
import {
  VISUAL_POSITION_WRITE_THRESHOLD,
  VISUAL_ROTATION_WRITE_THRESHOLD_DEGREES,
  ejectCurrentVehicle,
  exceedsWriteThreshold,
  getContinuousVisualRotation,
  hasExactRiders,
  hasRidersConsistentWithPendingAttachments,
  nativeRiders,
  scheduleRiderAttachmentConfirmation,
  validEntityLocations
} from "@src/render/contraption/shared/VisualEntityUtils";

export const FRAGMENT_CARRIER_ENTITY_TYPE_ID = "treephysics:fragment_carrier";
// One native seat is reserved for the single contraption outline rider.
export const FRAGMENT_CARRIER_CAPACITY = 511;

interface LiveFragment {
  allBark: boolean;
  anchorLocalLocation: Vector3;
  attachmentFamilyMask: number;
  blockCount: number;
  cubeLayout?: CubeBlockFragmentLayout;
  entity: Entity;
  entityTypeId: string;
  family: number;
  logModes: number;
  originY: number;
  words: number[];
}

interface LiveFragmentCarrier {
  auxiliaryRiderIds: Set<string>;
  dedicatedToPersistentRiders: boolean;
  entity: Entity;
  fragmentIds: Set<string>;
  pendingRiderIds: Set<string>;
  persistentRiderIds: Set<string>;
}

interface LiveAssignment {
  assignment: FragmentSlotAssignment;
  fragment: LiveFragment;
}

interface CubeFragmentMerge {
  readonly blockKey: string;
  readonly fragment: LiveFragment;
  readonly slot: CubeBlockFragmentSlot;
}

export class FragmentRenderer implements ContraptionRenderer {
  readonly #carriers: LiveFragmentCarrier[] = [];
  readonly #carrierByFragmentId = new Map<string, LiveFragmentCarrier>();
  readonly #assignments = new Map<string, LiveAssignment>();
  readonly #body: ContraptionRenderBody;
  readonly #foliageTint: PhysicsContraptionFoliageTint;
  readonly #fragments: LiveFragment[] = [];
  readonly #fragmentByEntityId = new Map<string, LiveFragment>();
  readonly #onEntityAdded?: (entityId: string) => void;
  readonly #onEntityRemoved?: (entityId: string) => void;
  readonly #spawnEntity: (typeId: string, location: Vector3) => Entity;
  #visualAnchor: Vector3;
  #visualAnchorRevision = 0;
  #lastOriginX = Number.NaN;
  #lastOriginY = Number.NaN;
  #lastOriginZ = Number.NaN;
  #knownIntegrityFailure = false;
  #initialPoseDeferred: boolean;
  #poseReady = false;
  #sleepingAtLastSync = false;
  #visualRotation: Vector3 | undefined;
  readonly #publishedVisualRotation: Vector3 = {
    x: Number.NaN,
    y: Number.NaN,
    z: Number.NaN
  };

  readonly supportsBlockAddition = true;

  get initialPoseDeferred(): boolean { return this.#initialPoseDeferred; }
  get visualRotation(): Readonly<Vector3> { return this.#publishedVisualRotation; }
  get visualAnchorLocal(): Vector3 { return { ...this.#visualAnchor }; }

  constructor(
    body: ContraptionRenderBody,
    fragments: readonly PackedFragment[],
    spawnEntity: (typeId: string, location: Vector3) => Entity,
    foliageTint: PhysicsContraptionFoliageTint,
    onEntityRemoved: ((entityId: string) => void) | undefined,
    visualAnchor: Vector3,
    onEntityAdded: ((entityId: string) => void) | undefined
  ) {
    this.#body = body;
    this.#foliageTint = foliageTint;
    this.#onEntityAdded = onEntityAdded;
    this.#onEntityRemoved = onEntityRemoved;
    this.#spawnEntity = spawnEntity;
    this.#visualAnchor = { ...visualAnchor };
    this.#initialPoseDeferred = true;
    try {
      this.#createFragments(fragments);
    } catch (error) {
      this.remove();
      throw error;
    }
  }

  get entityCount(): number {
    return this.#fragments.filter(fragment => fragment.entity.isValid).length
      + this.#carriers.filter(carrier => carrier.entity.isValid).length;
  }
  get entityIds(): readonly string[] {
    return [
      ...this.#fragments
        .filter(fragment => fragment.entity.isValid)
        .map(fragment => fragment.entity.id),
      ...this.#carriers
        .filter(carrier => carrier.entity.isValid)
        .map(carrier => carrier.entity.id)
    ];
  }
  get entityLocations(): readonly Vector3[] {
    return validEntityLocations([
      ...this.#fragments.map(fragment => fragment.entity),
      ...this.#carriers.map(carrier => carrier.entity)
    ]);
  }
  get firstEntityLocation(): Vector3 | undefined {
    return this.entityLocations[0];
  }

  hasEntity(entityId: string): boolean {
    return this.#fragmentByEntityId.get(entityId)?.entity.isValid === true
      || this.#carriers.some(
        carrier => carrier.entity.id === entityId && carrier.entity.isValid
      );
  }

  hasIntactEntities(): boolean {
    if (this.#knownIntegrityFailure) return false;
    if (this.#fragments.length === 0 || this.#carriers.length === 0) return false;
    for (const fragment of this.#fragments) {
      if (!fragment.entity.isValid) return false;
    }
    for (const carrier of this.#carriers) {
      const intact = carrier.pendingRiderIds.size > 0
        ? hasRidersConsistentWithPendingAttachments(
          carrier.entity,
          carrier.fragmentIds,
          carrier.auxiliaryRiderIds,
          carrier.persistentRiderIds,
          carrier.pendingRiderIds
        )
        : hasExactRiders(
          carrier.entity,
          carrier.fragmentIds,
          carrier.auxiliaryRiderIds,
          carrier.persistentRiderIds
        );
      if (!intact) return false;
    }
    return true;
  }

  hasKnownIntegrityFailure(): boolean {
    return this.#knownIntegrityFailure;
  }

  releaseInitialPose(): void {
    if (!this.#initialPoseDeferred) return;
    this.#setFragmentPoseReady(true);
    this.#initialPoseDeferred = false;
  }

  #setFragmentPoseReady(ready: boolean): void {
    if (this.#poseReady === ready) return;
    for (const fragment of this.#fragments) {
      this.#setLiveFragmentPoseReady(fragment, ready);
    }
    this.#poseReady = ready;
  }

  #setLiveFragmentPoseReady(fragment: LiveFragment, ready: boolean): void {
    if (!fragment.entity.isValid) {
      this.#knownIntegrityFailure = true;
      return;
    }
    if (isLeafFragmentEntityTypeId(fragment.entityTypeId)) {
      fragment.entity.setProperty(
        "treephysics:family",
        encodeFragmentFamily(fragment.family, ready)
      );
    } else if (fragment.entityTypeId === ATTACHMENT_FRAGMENT_ENTITY_TYPE_ID) {
      fragment.entity.setProperty(
        "treephysics:origin_y",
        packAttachmentOriginY(fragment.originY, fragment.attachmentFamilyMask, ready)
      );
    } else if (fragment.entityTypeId === CUBE_FRAGMENT_ENTITY_TYPE_ID) {
      if (!fragment.cubeLayout) {
        throw new Error(`Cube fragment ${fragment.entity.id} has no layout.`);
      }
      fragment.entity.setProperty(
        "treephysics:modes",
        encodeCubeFragmentModes(fragment.cubeLayout, ready)
      );
    } else {
      fragment.entity.setProperty(
        "treephysics:modes",
        encodeLogFragmentModes(fragment.logModes, ready)
      );
    }
  }

  /** Update one packed attachment slot without rebuilding its fragment. */
  setAttachmentBlockVisualState(blockKey: string, state: number): boolean {
    const live = this.#assignments.get(blockKey);
    if (!live || live.fragment.entityTypeId !== ATTACHMENT_FRAGMENT_ENTITY_TYPE_ID) return false;
    const { assignment, fragment } = live;
    if (!fragment.entity.isValid) {
      this.#knownIntegrityFailure = true;
      return false;
    }
    const descriptor = fragment.words[assignment.word];
    if (descriptor === undefined) {
      throw new Error(`Attachment fragment slot ${blockKey} has no descriptor.`);
    }
    const nextDescriptor = replaceAttachmentDescriptorState(descriptor, state);
    if (descriptor === nextDescriptor) return true;
    fragment.words[assignment.word] = nextDescriptor;
    fragment.entity.setProperty(`treephysics:a${assignment.word}`, nextDescriptor);
    return true;
  }

  /** Update one packed cube slot without rebuilding or replacing its fragment. */
  setCubeBlockOpenState(blockKey: string, open: boolean): boolean {
    const live = this.#assignments.get(blockKey);
    if (!live || live.fragment.entityTypeId !== CUBE_FRAGMENT_ENTITY_TYPE_ID) return false;
    const { assignment, fragment } = live;
    if (!fragment.entity.isValid) {
      this.#knownIntegrityFailure = true;
      return false;
    }
    const currentState = readCubeBlockFragmentSlot(fragment.words, assignment);
    if (currentState < 1 || currentState > 8) {
      throw new RangeError(`Cube fragment slot ${blockKey} has invalid state ${currentState}.`);
    }
    const directionState = ((currentState - 1) % 4) + 1;
    const nextState = directionState + (open ? 4 : 0);
    if (currentState === nextState) return true;
    const place = 2 ** assignment.shift;
    fragment.words[assignment.word] = (fragment.words[assignment.word] ?? 0)
      + (nextState - currentState) * place;
    fragment.entity.setProperty(
      `treephysics:s${assignment.word}`,
      fragment.words[assignment.word] ?? 0
    );
    return true;
  }

  attachAuxiliaryRider(entity: Entity): boolean {
    if (!entity.isValid || this.#carriers.length === 0) return false;
    const carrier = this.#carriers.find(value => !value.dedicatedToPersistentRiders);
    if (
      !carrier
      || !carrier.entity.isValid
      || carrier.auxiliaryRiderIds.size > 0
      || carrier.fragmentIds.size >= FRAGMENT_CARRIER_CAPACITY
    ) return false;
    const rideable = carrier.entity.getComponent("minecraft:rideable");
    if (!rideable?.addRider(entity)) return false;
    carrier.auxiliaryRiderIds.add(entity.id);
    this.#syncAuxiliaryRotation(entity);
    return true;
  }

  attachPersistentRider(entity: Entity): boolean {
    if (!entity.isValid) return false;
    let carrier = this.#carriers.find(value => (
      value.dedicatedToPersistentRiders
      && value.entity.isValid
      && value.persistentRiderIds.size < FRAGMENT_CARRIER_CAPACITY
    ));
    carrier ??= this.#createCarrier(true);
    ejectCurrentVehicle(entity);
    const rideable = carrier.entity.getComponent("minecraft:rideable");
    if (!rideable?.addRider(entity)) return false;
    carrier.persistentRiderIds.add(entity.id);
    scheduleRiderAttachmentConfirmation(
      carrier.entity,
      entity,
      carrier.pendingRiderIds,
      () => this.#body.isValid && carrier.persistentRiderIds.has(entity.id),
      () => { this.#knownIntegrityFailure = true; },
      "persistent"
    );
    return true;
  }

  detachAuxiliaryRider(entity: Entity): void {
    const carrier = this.#carriers.find(value => value.auxiliaryRiderIds.has(entity.id));
    if (!carrier) return;
    carrier.auxiliaryRiderIds.delete(entity.id);
    if (carrier.entity.isValid && entity.isValid) {
      carrier.entity.getComponent("minecraft:rideable")?.ejectRider(entity);
    }
    this.#removeEmptyCarrier(carrier);
  }

  detachPersistentRider(entity: Entity, preserveEmptyCarrier = false): void {
    const carrier = this.#carriers.find(value => value.persistentRiderIds.has(entity.id));
    if (!carrier) return;
    if (carrier.entity.isValid && entity.isValid) {
      carrier.entity.getComponent("minecraft:rideable")?.ejectRider(entity);
    }
    // Commit the script registry only after the native relationship changed.
    carrier.pendingRiderIds.delete(entity.id);
    carrier.persistentRiderIds.delete(entity.id);
    if (!preserveEmptyCarrier) this.#removeEmptyCarrier(carrier, true);
  }

  removeEmptyPersistentRiderCarriers(): void {
    for (const carrier of [...this.#carriers]) {
      if (carrier.dedicatedToPersistentRiders && carrier.persistentRiderIds.size === 0) {
        this.#removeEmptyCarrier(carrier, true);
      }
    }
  }

  removeBlocks(blockKeys: ReadonlySet<string>): void {
    const changedWords = new Map<LiveFragment, Set<number>>();
    const emptyFragments = new Set<LiveFragment>();
    for (const key of blockKeys) {
      const live = this.#assignments.get(key);
      if (!live) continue;
      this.#assignments.delete(key);
      const { assignment, fragment } = live;
      fragment.blockCount--;
      if (fragment.words.length > 0) {
        const place = 2 ** assignment.shift;
        const stateBase = 2 ** assignment.bitCount;
        const state = Math.floor((fragment.words[assignment.word] ?? 0) / place) % stateBase;
        fragment.words[assignment.word] = (fragment.words[assignment.word] ?? 0) - state * place;
        let words = changedWords.get(fragment);
        if (!words) {
          words = new Set();
          changedWords.set(fragment, words);
        }
        words.add(assignment.word);
      }
      if (fragment.blockCount <= 0) emptyFragments.add(fragment);
    }
    for (const [fragment, words] of changedWords) {
      if (emptyFragments.has(fragment) || !fragment.entity.isValid) continue;
      for (const word of words) {
        const prefix = fragment.entityTypeId === ATTACHMENT_FRAGMENT_ENTITY_TYPE_ID
          ? "a"
          : isLeafFragmentEntityTypeId(fragment.entityTypeId)
            ? "l"
            : "s";
        fragment.entity.setProperty(`treephysics:${prefix}${word}`, fragment.words[word] ?? 0);
      }
      if (fragment.entityTypeId === ATTACHMENT_FRAGMENT_ENTITY_TYPE_ID) {
        const familyMask = attachmentFamilyMask(fragment.words);
        if (familyMask !== fragment.attachmentFamilyMask) {
          fragment.attachmentFamilyMask = familyMask;
          fragment.entity.setProperty(
            "treephysics:origin_y",
            packAttachmentOriginY(
              fragment.originY,
              familyMask,
              this.#poseReady
            )
          );
        }
      } else if (
        fragment.entityTypeId !== CUBE_FRAGMENT_ENTITY_TYPE_ID
        && !isLeafFragmentEntityTypeId(fragment.entityTypeId)
      ) {
        const modes = logFragmentModes(fragment.words, fragment.allBark);
        if (modes !== fragment.logModes) {
          fragment.logModes = modes;
          fragment.entity.setProperty(
            "treephysics:modes",
            encodeLogFragmentModes(modes, this.#poseReady)
          );
        }
      }
    }
    for (const fragment of emptyFragments) this.#removeFragment(fragment);
  }

  /** Add only the new fragments so the existing visual chain keeps its pose. */
  addBlocks(blocks: readonly PhysicsContraptionBlock[]): void {
    const merges: CubeFragmentMerge[] = [];
    const newBlocks: PhysicsContraptionBlock[] = [];
    const reservedSlots = new Map<string, Set<number>>();
    const inputKeys = new Set<string>();
    for (const block of blocks) {
      const packed = packFragments([block]);
      if (
        !packed
        || packed.length !== 1
        || packed[0]!.entityTypeId !== CUBE_FRAGMENT_ENTITY_TYPE_ID
      ) {
        throw new Error("The fragment visual renderer received an unsupported added block.");
      }
      const blockKey = packed[0]!.assignments[0]!.blockKey;
      if (inputKeys.has(blockKey) || this.#assignments.has(blockKey)) {
        throw new RangeError(`Fragment block ${blockKey} is already rendered.`);
      }
      inputKeys.add(blockKey);
      const merge = this.#findCubeFragmentMerge(block, blockKey, reservedSlots);
      if (merge) {
        merges.push(merge);
        let fragmentSlots = reservedSlots.get(merge.fragment.entity.id);
        if (!fragmentSlots) {
          fragmentSlots = new Set();
          reservedSlots.set(merge.fragment.entity.id, fragmentSlots);
        }
        fragmentSlots.add(merge.slot.assignment.slot);
      } else {
        newBlocks.push(block);
      }
    }

    const packedNew = newBlocks.length > 0 ? packFragments(newBlocks) : [];
    if (!packedNew) throw new Error("Added cube blocks could not be packed into fragments.");
    let added: LiveFragment[] = [];
    try {
      added = this.#appendFragments(packedNew);
      this.#mergeCubeFragments(merges);
    } catch (error) {
      for (const fragment of [...added].reverse()) this.#removeFragment(fragment);
      throw error;
    }
    if (added.length === 0) return;
    this.sync(true);
    if (!this.#poseReady) return;
    system.run(() => {
      if (!this.#body.isValid) return;
      for (const fragment of added) {
        if (this.#fragmentByEntityId.get(fragment.entity.id) === fragment) {
          this.#setLiveFragmentPoseReady(fragment, true);
        }
      }
    });
  }

  #findCubeFragmentMerge(
    block: PhysicsContraptionBlock,
    blockKey: string,
    reservedSlots: ReadonlyMap<string, ReadonlySet<number>>
  ): CubeFragmentMerge | undefined {
    for (const fragment of this.#fragments) {
      if (
        fragment.entityTypeId !== CUBE_FRAGMENT_ENTITY_TYPE_ID
        || !fragment.entity.isValid
        || !fragment.cubeLayout
      ) continue;
      const slot = tryCreateCubeBlockFragmentSlot(
        block,
        fragment.anchorLocalLocation,
        fragment.cubeLayout,
        fragment.words,
        reservedSlots.get(fragment.entity.id)
      );
      if (!slot || readCubeBlockFragmentSlot(fragment.words, slot.assignment) !== 0) continue;
      if (reservedSlots.get(fragment.entity.id)?.has(slot.assignment.slot)) continue;
      return { blockKey, fragment, slot };
    }
    return undefined;
  }

  /** Publish all occupied slots only after the complete merge is valid. */
  #mergeCubeFragments(merges: readonly CubeFragmentMerge[]): void {
    if (merges.length === 0) return;
    const previousWords = new Map<LiveFragment, Map<number, number>>();
    const addedCounts = new Map<LiveFragment, number>();
    try {
      for (const merge of merges) {
        const { assignment } = merge.slot;
        let words = previousWords.get(merge.fragment);
        if (!words) {
          words = new Map();
          previousWords.set(merge.fragment, words);
        }
        if (!words.has(assignment.word)) {
          words.set(assignment.word, merge.fragment.words[assignment.word] ?? 0);
        }
        merge.fragment.words[assignment.word] = (merge.fragment.words[assignment.word] ?? 0)
          | (merge.slot.state * (2 ** assignment.shift));
        merge.fragment.blockCount++;
        addedCounts.set(merge.fragment, (addedCounts.get(merge.fragment) ?? 0) + 1);
        this.#assignments.set(merge.blockKey, { assignment, fragment: merge.fragment });
      }
      for (const [fragment, words] of previousWords) {
        for (const word of words.keys()) {
          fragment.entity.setProperty(`treephysics:s${word}`, fragment.words[word] ?? 0);
        }
      }
    } catch (error) {
      for (const merge of merges) this.#assignments.delete(merge.blockKey);
      for (const [fragment, words] of previousWords) {
        fragment.blockCount -= addedCounts.get(fragment) ?? 0;
        for (const [word, value] of words) {
          fragment.words[word] = value;
          if (fragment.entity.isValid) {
            fragment.entity.setProperty(`treephysics:s${word}`, value);
          }
        }
      }
      throw error;
    }
  }

  /** Rebuilds anchor-relative visuals when an edit removes the current anchor. */
  rebaseVisualAnchor(blocks: readonly PhysicsContraptionBlock[]): void {
    const nextAnchor = findContraptionVisualAnchor(blocks);
    if (!nextAnchor || vectorsEqual(nextAnchor, this.#visualAnchor)) return;
    const fragments = packFragments(blocks);
    if (!fragments) {
      throw new Error("A fragment contraption cannot change renderer during an in-place edit.");
    }

    const revision = ++this.#visualAnchorRevision;
    const persistentRiders = this.#carriers.flatMap(carrier => (
      nativeRiders(carrier.entity).filter(rider => carrier.persistentRiderIds.has(rider.id))
    ));
    // Existing carriers retain client interpolation history even while their
    // geometry is hidden. Remove them before creating the replacement directly
    // at its final anchor; the normal first-pose gate hides the spawn frame.
    this.remove();
    this.#resetPoseState(nextAnchor);
    try {
      this.#createFragments(fragments);
      for (const rider of persistentRiders) {
        if (!this.attachPersistentRider(rider)) {
          throw new Error(`Could not reattach persistent contraption entity ${rider.id}.`);
        }
      }
      this.sync(true);
    } catch (error) {
      this.remove();
      throw error;
    }
    system.run(() => {
      if (revision !== this.#visualAnchorRevision || !this.#body.isValid) return;
      this.sync(true);
      this.releaseInitialPose();
    });
  }

  #createFragments(fragments: readonly PackedFragment[]): void {
    this.#appendFragments(fragments);
  }

  #appendFragments(fragments: readonly PackedFragment[]): LiveFragment[] {
    const added: LiveFragment[] = [];
    try {
      for (const packed of fragments) {
        const carrier = this.#availableCarrier() ?? this.#createCarrier(false);
        const rideable = carrier.entity.getComponent("minecraft:rideable");
        if (!rideable) throw new Error("Fragment visual carrier lost minecraft:rideable.");
        const origin = getPackedFragmentOrigin(packed, this.#visualAnchor);
        const isAttachment = packed.entityTypeId === ATTACHMENT_FRAGMENT_ENTITY_TYPE_ID;
        const isLeaf = isLeafFragmentEntityTypeId(packed.entityTypeId);
        const familyMask = isAttachment ? attachmentFamilyMask(packed.words) : 0;
        const modes = !isAttachment && !isLeaf
          && packed.entityTypeId !== CUBE_FRAGMENT_ENTITY_TYPE_ID
          ? logFragmentModes(packed.words, packed.allBark)
          : 0;
        const entity = this.#spawnEntity(
          packed.entityTypeId,
          this.#body.localPointToWorld(this.#visualAnchor)
        );
        try {
          initializeFragmentProperties(
            entity,
            packed,
            this.#foliageTint,
            origin,
            familyMask,
            modes
          );
          if (!rideable.addRider(entity)) {
            throw new Error(
              `Could not mount fragment visual ${entity.id} on carrier ${carrier.entity.id}.`
            );
          }
        } catch (error) {
          if (entity.isValid) entity.remove();
          throw error;
        }
        const fragment: LiveFragment = {
          allBark: packed.allBark,
          anchorLocalLocation: { ...packed.anchorLocalLocation },
          attachmentFamilyMask: familyMask,
          blockCount: packed.blockCount,
          cubeLayout: packed.cubeLayout,
          entity,
          entityTypeId: packed.entityTypeId,
          family: packed.family,
          logModes: modes,
          originY: origin.y,
          words: [...packed.words]
        };
        this.#fragments.push(fragment);
        added.push(fragment);
        this.#fragmentByEntityId.set(entity.id, fragment);
        carrier.fragmentIds.add(entity.id);
        this.#carrierByFragmentId.set(entity.id, carrier);
        // addRider can report success before Bedrock publishes the relationship.
        // Keep the fragment transitional until the native carrier confirms it.
        scheduleRiderAttachmentConfirmation(
          carrier.entity,
          entity,
          carrier.pendingRiderIds,
          () => this.#body.isValid && carrier.fragmentIds.has(entity.id),
          () => { this.#knownIntegrityFailure = true; },
          "visual"
        );
        this.#onEntityAdded?.(entity.id);
        for (const assignment of packed.assignments) {
          this.#assignments.set(assignment.blockKey, { assignment, fragment });
        }
      }
      return added;
    } catch (error) {
      for (const fragment of [...added].reverse()) this.#removeFragment(fragment);
      for (const carrier of [...this.#carriers]) this.#removeEmptyCarrier(carrier);
      throw error;
    }
  }

  #availableCarrier(): LiveFragmentCarrier | undefined {
    return this.#carriers.find(carrier => (
      !carrier.dedicatedToPersistentRiders
      && carrier.entity.isValid
      && carrier.fragmentIds.size + carrier.auxiliaryRiderIds.size
        < FRAGMENT_CARRIER_CAPACITY
    ));
  }

  #createCarrier(dedicatedToPersistentRiders: boolean): LiveFragmentCarrier {
    const entity = this.#spawnEntity(
      FRAGMENT_CARRIER_ENTITY_TYPE_ID,
      this.#body.localPointToWorld(this.#visualAnchor)
    );
    if (!entity.getComponent("minecraft:rideable")) {
      if (entity.isValid) entity.remove();
      throw new Error("Fragment visual carrier does not expose minecraft:rideable.");
    }
    const carrier: LiveFragmentCarrier = {
      auxiliaryRiderIds: new Set(),
      dedicatedToPersistentRiders,
      entity,
      fragmentIds: new Set(),
      pendingRiderIds: new Set(),
      persistentRiderIds: new Set()
    };
    this.#carriers.push(carrier);
    this.#onEntityAdded?.(entity.id);
    return carrier;
  }

  #resetPoseState(visualAnchor: Vector3): void {
    this.#visualAnchor = { ...visualAnchor };
    this.#initialPoseDeferred = true;
    this.#poseReady = false;
    this.#knownIntegrityFailure = false;
    this.#sleepingAtLastSync = false;
    this.#visualRotation = undefined;
    this.#lastOriginX = Number.NaN;
    this.#lastOriginY = Number.NaN;
    this.#lastOriginZ = Number.NaN;
    this.#publishedVisualRotation.x = Number.NaN;
    this.#publishedVisualRotation.y = Number.NaN;
    this.#publishedVisualRotation.z = Number.NaN;
  }

  remove(): void {
    for (const fragment of [...this.#fragments]) this.#removeFragment(fragment);
    for (const carrier of this.#carriers) {
      carrier.pendingRiderIds.clear();
      for (const rider of nativeRiders(carrier.entity)) {
        if (carrier.auxiliaryRiderIds.has(rider.id) && rider.isValid) rider.remove();
        else if (carrier.persistentRiderIds.has(rider.id) && rider.isValid) {
          carrier.entity.getComponent("minecraft:rideable")?.ejectRider(rider);
        }
      }
      this.#onEntityRemoved?.(carrier.entity.id);
      if (carrier.entity.isValid) carrier.entity.remove();
    }
    this.#carriers.length = 0;
    this.#carrierByFragmentId.clear();
    this.#assignments.clear();
  }

  sync(force = false): number {
    if (!this.#body.isValid) return 0;
    const sleeping = this.#body.isSleeping === true;
    if (!force && sleeping && this.#sleepingAtLastSync) return 0;
    this.#sleepingAtLastSync = sleeping;
    const rotation = getContinuousVisualRotation(this.#body, this.#visualRotation);
    this.#visualRotation = rotation;
    const sharedAnchor = this.#body.localPointToWorld(this.#visualAnchor);
    const pitchChanged = force || exceedsWriteThreshold(
      rotation.x,
      this.#publishedVisualRotation.x,
      VISUAL_ROTATION_WRITE_THRESHOLD_DEGREES
    );
    const yawChanged = force || exceedsWriteThreshold(
      rotation.y,
      this.#publishedVisualRotation.y,
      VISUAL_ROTATION_WRITE_THRESHOLD_DEGREES
    );
    const rollChanged = force || exceedsWriteThreshold(
      rotation.z,
      this.#publishedVisualRotation.z,
      VISUAL_ROTATION_WRITE_THRESHOLD_DEGREES
    );
    const positionChanged = force
      || exceedsWriteThreshold(sharedAnchor.x, this.#lastOriginX, VISUAL_POSITION_WRITE_THRESHOLD)
      || exceedsWriteThreshold(sharedAnchor.y, this.#lastOriginY, VISUAL_POSITION_WRITE_THRESHOLD)
      || exceedsWriteThreshold(sharedAnchor.z, this.#lastOriginZ, VISUAL_POSITION_WRITE_THRESHOLD);
    if (!positionChanged && !pitchChanged && !yawChanged && !rollChanged) return 0;
    if (positionChanged) {
      this.#lastOriginX = sharedAnchor.x;
      this.#lastOriginY = sharedAnchor.y;
      this.#lastOriginZ = sharedAnchor.z;
    }
    if (pitchChanged) {
      this.#publishedVisualRotation.x = rotation.x;
    }
    if (yawChanged) {
      this.#publishedVisualRotation.y = rotation.y;
    }
    if (rollChanged) {
      this.#publishedVisualRotation.z = rotation.z;
    }
    let writes = 0;
    if (positionChanged) {
      for (const carrier of this.#carriers) {
        if (!carrier.entity.isValid) {
          this.#knownIntegrityFailure = true;
          continue;
        }
        carrier.entity.teleport(sharedAnchor);
        writes++;
      }
    }
    for (const fragment of this.#fragments) {
      const entity = fragment.entity;
      if (!entity.isValid) {
        this.#knownIntegrityFailure = true;
        continue;
      }
      if (pitchChanged) entity.setProperty("treephysics:pitch", rotation.x);
      if (yawChanged) entity.setProperty("treephysics:yaw", rotation.y);
      if (rollChanged) entity.setProperty("treephysics:roll", rotation.z);
      if (pitchChanged || yawChanged || rollChanged) writes++;
    }
    if (pitchChanged || yawChanged || rollChanged) {
      for (const carrier of this.#carriers) {
        if (carrier.auxiliaryRiderIds.size === 0) continue;
        for (const rider of nativeRiders(carrier.entity)) {
          if (!carrier.auxiliaryRiderIds.has(rider.id)) continue;
          this.#syncAuxiliaryRotation(rider, rotation);
          writes++;
        }
      }
    }
    return writes;
  }

  #syncAuxiliaryRotation(entity: Entity, rotation = this.#visualRotation): void {
    if (!entity.isValid || !rotation) return;
    entity.setProperty("treephysics:pitch", rotation.x);
    entity.setProperty("treephysics:yaw", rotation.y);
    entity.setProperty("treephysics:roll", rotation.z);
  }

  #removeFragment(fragment: LiveFragment): void {
    const index = this.#fragments.indexOf(fragment);
    if (index >= 0) this.#fragments.splice(index, 1);
    this.#fragmentByEntityId.delete(fragment.entity.id);
    const carrier = this.#carrierByFragmentId.get(fragment.entity.id);
    this.#carrierByFragmentId.delete(fragment.entity.id);
    if (carrier) {
      carrier.pendingRiderIds.delete(fragment.entity.id);
      carrier.fragmentIds.delete(fragment.entity.id);
      this.#removeEmptyCarrier(carrier);
    }
    this.#onEntityRemoved?.(fragment.entity.id);
    if (fragment.entity.isValid) fragment.entity.remove();
  }

  #removeEmptyCarrier(
    carrier: LiveFragmentCarrier,
    removeDedicatedCarrier = false
  ): void {
    if (
      carrier.fragmentIds.size > 0
      || carrier.auxiliaryRiderIds.size > 0
      || carrier.persistentRiderIds.size > 0
      || (carrier.dedicatedToPersistentRiders && !removeDedicatedCarrier)
    ) return;
    const carrierIndex = this.#carriers.indexOf(carrier);
    if (carrierIndex >= 0) this.#carriers.splice(carrierIndex, 1);
    this.#onEntityRemoved?.(carrier.entity.id);
    if (carrier.entity.isValid) carrier.entity.remove();
  }
}

function initializeFragmentProperties(
  entity: Entity,
  fragment: PackedFragment,
  foliageTint: PhysicsContraptionFoliageTint,
  origin: { readonly xz: number; readonly y: number },
  attachmentFamilyMaskValue: number,
  logModesValue: number
): void {
  entity.setProperty("treephysics:origin_xz", origin.xz);
  entity.setProperty(
    "treephysics:origin_y",
    fragment.entityTypeId === ATTACHMENT_FRAGMENT_ENTITY_TYPE_ID
      ? packAttachmentOriginY(origin.y, attachmentFamilyMaskValue, false)
      : origin.y
  );
  if (fragment.entityTypeId === CUBE_FRAGMENT_ENTITY_TYPE_ID) {
    if (!fragment.cubeLayout) throw new Error("Packed cube fragment has no layout.");
    entity.setProperty(
      "treephysics:modes",
      encodeCubeFragmentModes(fragment.cubeLayout, false)
    );
    for (let index = 0; index < fragment.words.length; index++) {
      const word = fragment.words[index] ?? 0;
      if (word !== 0) entity.setProperty(`treephysics:s${index}`, word);
    }
    return;
  }
  if (isLeafFragmentEntityTypeId(fragment.entityTypeId)) {
    entity.setProperty("treephysics:family", encodeFragmentFamily(fragment.family, false));
    entity.setProperty("treephysics:tint", packFragmentFoliageTint(fragment, foliageTint));
    for (let index = 0; index < fragment.words.length; index++) {
      const word = fragment.words[index] ?? 0;
      if (word !== 0) entity.setProperty(`treephysics:l${index}`, word);
    }
    return;
  }
  if (fragment.entityTypeId === ATTACHMENT_FRAGMENT_ENTITY_TYPE_ID) {
    entity.setProperty("treephysics:tint", packFragmentFoliageTint(fragment, foliageTint));
    for (let index = 0; index < fragment.words.length; index++) {
      const descriptor = fragment.words[index] ?? 0;
      if (descriptor !== 0) entity.setProperty(`treephysics:a${index}`, descriptor);
    }
    return;
  }
  entity.setProperty("treephysics:family", fragment.family);
  entity.setProperty(
    "treephysics:modes",
    encodeLogFragmentModes(logModesValue, false)
  );
  for (let index = 0; index < fragment.words.length; index++) {
    const word = fragment.words[index] ?? 0;
    if (word !== 0) entity.setProperty(`treephysics:s${index}`, word);
  }
}
