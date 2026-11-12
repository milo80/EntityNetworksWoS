// Group (team) colors for the graph.
//
// A network graph puts any two groups side by side, so every PAIR of colors must
// stay distinguishable (the "all pairs" case, like a scatter plot). Of the
// reference categorical palette, the largest subset that passes all-pairs
// validation in light mode with no colour-vision-deficiency warnings is these
// four (worst CVD dE 13, normal-vision dE 19.6 - see docs/design-notes.md). So:
//  - the 4 largest groups get these colors, assigned once per network (colors
//    follow the group, they never repaint when filters change);
//  - every other group, and "other", is neutral gray;
//  - "unknown" (no value at all) is a hollow node, distinct from "other" without
//    relying on color.
// Groups stay identifiable by name in the Group filter and the details panel.
import { TEAM_OTHER, TEAM_UNKNOWN, type Network } from "./network";

export const GROUP_PALETTE = ["#2a78d6", "#eda100", "#e87ba4", "#008300"] as const;
export const NEUTRAL = "#898781";

export interface GroupStyle {
  color: string;
  hollow: boolean;
}

/** Style per team: palette slots by descending node count (ties: first appearance). */
export function groupStyles(network: Network): Map<string, GroupStyle> {
  const counts = new Map<string, number>();
  for (const n of network.nodes) counts.set(n.team, (counts.get(n.team) ?? 0) + 1);
  const ranked = [...counts.keys()]
    .filter((t) => t !== TEAM_OTHER && t !== TEAM_UNKNOWN)
    .sort((a, b) => counts.get(b)! - counts.get(a)!);

  const styles = new Map<string, GroupStyle>();
  for (const team of counts.keys())
    styles.set(team, { color: NEUTRAL, hollow: team === TEAM_UNKNOWN });
  ranked.slice(0, GROUP_PALETTE.length).forEach((team, i) => {
    styles.set(team, { color: GROUP_PALETTE[i]!, hollow: false });
  });
  return styles;
}

/** Filter-list order: colored groups first (by size), then the rest, other/unknown last. */
export function orderedTeams(network: Network, styles: Map<string, GroupStyle>): string[] {
  const counts = new Map<string, number>();
  for (const n of network.nodes) counts.set(n.team, (counts.get(n.team) ?? 0) + 1);
  const rank = (t: string) => {
    if (t === TEAM_OTHER) return 2;
    if (t === TEAM_UNKNOWN) return 3;
    return styles.get(t)?.color === NEUTRAL ? 1 : 0;
  };
  return [...counts.keys()].sort(
    (a, b) => rank(a) - rank(b) || counts.get(b)! - counts.get(a)! || a.localeCompare(b),
  );
}

export function teamCounts(network: Network): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of network.nodes) counts.set(n.team, (counts.get(n.team) ?? 0) + 1);
  return counts;
}
