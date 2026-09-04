export function contextSegmentUsed(occupancy?: { used: number } | null): number | null {
  if (!occupancy) return null;
  return occupancy.used;
}
