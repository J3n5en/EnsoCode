export function parseAgyVersion(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareAgyVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function agyVersionAtLeast(version: string, minimum: string): boolean {
  const parsed = parseAgyVersion(version);
  const floor = parseAgyVersion(minimum);
  if (!parsed || !floor) return false;
  return compareAgyVersions(parsed, floor) >= 0;
}
