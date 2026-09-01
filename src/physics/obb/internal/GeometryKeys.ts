export function fineCellKey(xIndex: number, zIndex: number): string { return `${xIndex},${zIndex}`; }

export function parseFineCellKey(key: string): Readonly<{ x: number; z: number }> {
  const [x, z] = key.split(",").map(Number);
  if (!Number.isInteger(x) || !Number.isInteger(z)) throw new Error(`Invalid horizontal support key: ${key}.`);
  return { x: x!, z: z! };
}

export function verticalCellKey(xIndex: number, yIndex: number, zIndex: number): string { return `v:${xIndex},${yIndex},${zIndex}`; }
const VERTICAL_CELL_KEY_PATTERN = /^v:(-?\d+),(-?\d+),(-?\d+)$/;
export function parseVerticalCellKey(key: string): Readonly<{ x: number; y: number; z: number }> {
  const match = VERTICAL_CELL_KEY_PATTERN.exec(key);
  if (!match) throw new Error(`Invalid vertical support key: ${key}.`);
  return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
}
export function compressedHorizontalPatchKey(presetId: string, xIndex: number, zIndex: number): string { return `h:${presetId}:${xIndex},${zIndex}`; }
export function compressedVerticalPatchKey(presetId: string, xIndex: number, yIndex: number, zIndex: number): string { return `v:${presetId}:${xIndex},${yIndex},${zIndex}`; }
export function topNamespaceKey(key: string): string { return `t:${key}`; }
export function compressedWalkingTopKey(presetId: string, cellKey: string): string { return `t:${presetId}:${cellKey}`; }
export function volumeSegmentKey(cellKey: string, index: number, locationY: number): string { return `${cellKey}:${index}:${locationY}`; }
export function walkingSideSegmentKey(cellKey: string, index: number, locationY: number): string { return `s:${cellKey}:${index}:${locationY}`; }
