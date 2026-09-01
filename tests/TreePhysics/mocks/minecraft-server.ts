export const BlockTypes = {
  get: (_typeId: string) => undefined
};

export const ItemTypes = {
  get: (_typeId: string) => ({})
};

export class BlockPermutation {
  static resolve(typeId: string, states: Record<string, boolean | number | string> = {}) {
    return {
      getAllStates: () => ({ ...states }),
      states: { ...states },
      type: { id: typeId }
    };
  }
}

export class MolangVariableMap {
  readonly floats = new Map<string, number>();

  setFloat(name: string, value: number): void {
    this.floats.set(name, value);
  }
}

export const EntitySwingSource = {
  Attack: "Attack",
  Build: "Build",
  Interact: "Interact",
  Mine: "Mine",
  UseItem: "UseItem"
};

export const GameMode = {
  Adventure: "Adventure",
  Creative: "Creative",
  Spectator: "Spectator",
  Survival: "Survival"
};

export const InputMode = {
  Gamepad: "Gamepad",
  KeyboardAndMouse: "KeyboardAndMouse",
  MotionController: "MotionController",
  Touch: "Touch"
};

export const InputButton = {
  Jump: "Jump",
  Sneak: "Sneak"
};

export const InputPermissionCategory = {
  Movement: "Movement"
};

export const system = {
  beforeEvents: {
    startup: {
      subscribe: (_callback: (event: unknown) => void) => undefined
    }
  },
  currentTick: 0,
  run: (callback: () => void) => callback()
};

const playerSpawnCallbacks: Array<(event: { player: unknown }) => void> = [];
const playerDimensionChangeCallbacks: Array<(event: { player: unknown }) => void> = [];
const playerButtonInputCallbacks: Array<(event: { button: string; player: unknown }) => void> = [];
const playerLeaveCallbacks: Array<(event: { player: unknown }) => void> = [];
const playerInteractWithEntityCallbacks: Array<(event: unknown) => void> = [];
const entityContainerOpenedCallbacks: Array<(event: unknown) => void> = [];
const entityContainerClosedCallbacks: Array<(event: unknown) => void> = [];
const entityDieCallbacks: Array<(event: unknown) => void> = [];
const entityRemoveCallbacks: Array<(event: unknown) => void> = [];

export const world = {
  afterEvents: {
    entityContainerClosed: {
      subscribe: (callback: (event: unknown) => void) => {
        entityContainerClosedCallbacks.push(callback);
      }
    },
    entityContainerOpened: {
      subscribe: (callback: (event: unknown) => void) => {
        entityContainerOpenedCallbacks.push(callback);
      }
    },
    entityDie: {
      subscribe: (callback: (event: unknown) => void) => {
        entityDieCallbacks.push(callback);
      }
    },
    entityRemove: {
      subscribe: (callback: (event: unknown) => void) => {
        entityRemoveCallbacks.push(callback);
      }
    },
    playerButtonInput: {
      subscribe: (callback: (event: { button: string; player: unknown }) => void) => {
        playerButtonInputCallbacks.push(callback);
      }
    },
    playerDimensionChange: {
      subscribe: (callback: (event: { player: unknown }) => void) => {
        playerDimensionChangeCallbacks.push(callback);
      }
    },
    playerSpawn: {
      subscribe: (callback: (event: { player: unknown }) => void) => {
        playerSpawnCallbacks.push(callback);
      }
    }
  },
  beforeEvents: {
    playerInteractWithEntity: {
      subscribe: (callback: (event: unknown) => void) => {
        playerInteractWithEntityCallbacks.push(callback);
      }
    },
    playerLeave: {
      subscribe: (callback: (event: { player: unknown }) => void) => {
        playerLeaveCallbacks.push(callback);
      }
    }
  },
  getDimension: (_id: string) => ({ getEntities: () => [] }),
  getAllPlayers: () => [],
  getPlayers: () => []
};

export const testEvents = {
  entityContainerClosed: (event: unknown) => {
    for (const callback of entityContainerClosedCallbacks) callback(event);
  },
  entityContainerOpened: (event: unknown) => {
    for (const callback of entityContainerOpenedCallbacks) callback(event);
  },
  entityDie: (event: unknown) => {
    for (const callback of entityDieCallbacks) callback(event);
  },
  entityRemove: (event: unknown) => {
    for (const callback of entityRemoveCallbacks) callback(event);
  },
  playerButtonInput: (player: unknown) => {
    for (const callback of playerButtonInputCallbacks) {
      callback({ button: InputButton.Sneak, player });
    }
  },
  playerDimensionChange: (player: unknown) => {
    for (const callback of playerDimensionChangeCallbacks) callback({ player });
  },
  playerInteractWithEntity: (event: unknown) => {
    for (const callback of playerInteractWithEntityCallbacks) callback(event);
  },
  playerLeave: (player: unknown) => {
    for (const callback of playerLeaveCallbacks) callback({ player });
  },
  playerSpawn: (player: unknown) => {
    for (const callback of playerSpawnCallbacks) callback({ player });
  },
  /** Detach container-event subscribers registered by a finished test. */
  resetContainerEvents: () => {
    playerInteractWithEntityCallbacks.length = 0;
    entityContainerOpenedCallbacks.length = 0;
    entityContainerClosedCallbacks.length = 0;
    entityDieCallbacks.length = 0;
    entityRemoveCallbacks.length = 0;
  }
};
