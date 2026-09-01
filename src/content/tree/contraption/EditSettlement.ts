/**
 * Distributes the parent's elapsed settlement ticks across edited children in
 * proportion to their log counts. Integer remainders go to the largest exact
 * fractional shares so the allocated total remains exact and deterministic.
 */
export function allocateTreeEditSettlementTicks(
  parentSleepTicks: number,
  sleepTicksPerLog: number,
  childLogCounts: readonly number[]
): number[] {
  assertNonNegativeInteger(parentSleepTicks, "Parent settlement ticks");
  assertPositiveInteger(sleepTicksPerLog, "Settlement ticks per log");
  for (const count of childLogCounts) {
    assertNonNegativeInteger(count, "Edited child log count");
  }

  const totalLogCount = childLogCounts.reduce((sum, count) => sum + count, 0);
  if (!Number.isSafeInteger(totalLogCount)) {
    throw new RangeError("Edited child total log count exceeds the safe integer range.");
  }
  if (totalLogCount === 0) return childLogCounts.map(() => 0);

  const totalTimeoutTicks = totalLogCount * sleepTicksPerLog;
  if (!Number.isSafeInteger(totalTimeoutTicks)) {
    throw new RangeError("Edited child settlement duration exceeds the safe integer range.");
  }
  const distributableTicks = Math.min(parentSleepTicks, totalTimeoutTicks);
  const allocations = childLogCounts.map(count => (
    Math.floor(distributableTicks * count / totalLogCount)
  ));
  let remainingTicks = distributableTicks
    - allocations.reduce((sum, ticks) => sum + ticks, 0);
  if (remainingTicks === 0) return allocations;

  const remainderOrder = childLogCounts
    .map((count, index) => ({
      index,
      remainder: distributableTicks * count % totalLogCount
    }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (const { index } of remainderOrder) {
    if (remainingTicks === 0) break;
    allocations[index]!++;
    remainingTicks--;
  }
  if (remainingTicks !== 0) {
    throw new Error("Could not conserve edited-child settlement ticks.");
  }
  return allocations;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}
