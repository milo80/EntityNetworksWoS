// Group (team) colors for the graph.
//
// The 7 largest groups get the first 7 slots of the reference categorical
// palette, in its fixed order, assigned once per network (colors follow the
// group and never repaint when filters change). Every other group, and "other",
// is neutral gray; "unknown" (no value at all) is a hollow node, distinct from
// "other" without relying on color.
//
// Known limitation (chosen deliberately, see docs/design-notes.md): a network
// graph can put any two groups side by side, and with 7 colors some pairs are
// hard to tell apart (blue/violet; green/orange for color-blind readers). Group
// names in the Group filter (the legend), the tooltip and the details panel are
// the secondary encoding.
import { TEAM_OTHER, TEAM_UNKNOWN, type Network } from "./network";

export const GROUP_PALETTE = [
  "#2a78d6", // blue
  "#eb6834", // orange
  "#1baf7a", // aqua
  "#eda100", // yellow
  "#e87ba4", // magenta
  "#008300", // green
  "#6250d6", // violet
] as const;
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
