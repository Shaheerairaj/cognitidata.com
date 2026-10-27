// Pure layout math for the map⇄list divider (mock: moment4-layout-model.html).
// The map and list share one vertical stage; the divider snaps to three detents.
export type Detent = "map" | "balanced" | "list";

// the map's share of the vertical stage, as a percentage, at each detent
export const DETENT_PCT: Record<Detent, number> = { map: 72, balanced: 40, list: 8 };

const ORDER: Detent[] = ["list", "balanced", "map"]; // ascending map-height

// nearest detent to a dragged percentage; ties round toward the taller map
export function snapDetent(pct: number): Detent {
  let best: Detent = "balanced";
  let bestDist = Infinity;
  for (const d of ORDER) {
    const dist = Math.abs(DETENT_PCT[d] - pct);
    if (dist <= bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

// step one detent up (dir +1, taller map) or down (dir -1, taller list), clamped
export function nextDetent(d: Detent, dir: 1 | -1): Detent {
  const i = ORDER.indexOf(d);
  const j = Math.min(ORDER.length - 1, Math.max(0, i + dir));
  return ORDER[j];
}
