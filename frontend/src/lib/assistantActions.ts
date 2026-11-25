// The assistant's explorer actions, applied to the explorer's state as if the
// user had set the controls. Pure: Explorer.tsx keeps the state, this computes
// the next one and one line per action for the chat.
import type { ExplorerAction } from "../api/client";
import type { Selection } from "../components/explorer/types";
import { TEAM_OTHER, TEAM_UNKNOWN, prettyType, type Network } from "./network";
import { initialFilterState, parseAttrRows, type AttrFilter, type FilterState } from "./visibility";

export interface ExplorerView {
  filters: FilterState;
  search: string;
  selected: Selection | null;
}

export interface ActionScope {
  network: Network;
  /** Groups in legend order (orderedTeams). */
  teams: string[];
  nodeKeys: string[];
  edgeKeys: string[];
  /** Weight of every link. */
  weights: number[];
}

export interface ActionResult {
  view: ExplorerView;
  lines: string[];
  /** The view should be fitted to the visible graph. */
  fit: boolean;
  /** The attribute rows changed and must show the applied filters. */
  attrRows: boolean;
}

/** "2", "2 and 3", "1, 2 and 4". */
function listed(items: (string | number)[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Matches the user's spelling of a name: exact, then ignoring case. */
function findName(name: string, names: string[], pretty: (s: string) => string = (s) => s) {
  const lower = name.trim().toLowerCase();
  return (
    names.find((n) => n === name) ??
    names.find((n) => n.toLowerCase() === lower || pretty(n).toLowerCase() === lower)
  );
}

function nameMatches(network: Network, search: string) {
  const q = search.trim().toLowerCase();
  return q ? network.nodes.filter((n) => n.name.toLowerCase().includes(q)) : [];
}

export function applyAssistantActions(
  actions: readonly ExplorerAction[],
  start: ExplorerView,
  scope: ActionScope,
): ActionResult {
  const { network } = scope;
  // Ranked groups: the legend without "other" and "unknown".
  const ranked = scope.teams.filter((t) => t !== TEAM_OTHER && t !== TEAM_UNKNOWN);
  const relations = [...new Set(network.edges.map((e) => e.type))];
  const lowest = scope.weights.length ? Math.min(...scope.weights) : 0;
  const highest = scope.weights.length ? Math.max(...scope.weights) : 0;

  let view = start;
  let fit = false;
  let attrRows = false;
  const lines: string[] = [];
  const setFilters = (patch: Partial<FilterState>) => {
    view = { ...view, filters: { ...view.filters, ...patch } };
  };

  for (const action of actions) {
    switch (action.kind) {
      case "keep_largest_groups": {
        const kept = ranked.slice(0, action.n);
        setFilters({ teams: new Set(kept) });
        lines.push(
          kept.length === 1
            ? "Showing the largest group"
            : `Showing the ${kept.length} largest groups`,
        );
        break;
      }
      case "groups_by_rank": {
        const ranks = [...new Set(action.ranks)].sort((a, b) => a - b);
        const found = ranks.filter((r) => r >= 1 && r <= ranked.length);
        const missing = ranks.filter((r) => !found.includes(r));
        if (found.length) {
          setFilters({ teams: new Set(found.map((r) => ranked[r - 1]!)) });
          lines.push(`Showing ${plural(found.length, "group", "groups")} ${listed(found)}`);
        }
        if (missing.length) {
          lines.push(
            `No ${plural(missing.length, "group", "groups")} ${listed(missing)}: this network ` +
              `has ${ranked.length} ${plural(ranked.length, "group", "groups")}.`,
          );
        }
        break;
      }
      case "set_relations": {
        const next = new Set(view.filters.relations);
        const changed: string[] = [];
        for (const name of action.relations) {
          const type = findName(name, relations, prettyType);
          if (!type) {
            lines.push(`No relation ${name} in this network.`);
            continue;
          }
          if (action.visible) next.add(type);
          else next.delete(type);
          changed.push(prettyType(type));
        }
        if (changed.length) {
          setFilters({ relations: next });
          lines.push(`${action.visible ? "Showing" : "Hiding"} links of type ${listed(changed)}`);
        }
        break;
      }
      case "set_weight_range": {
        if (!scope.weights.length) {
          lines.push("This network has no links.");
          break;
        }
        const clamp = (w: number) => Math.min(highest, Math.max(lowest, w));
        const min = clamp(action.min ?? lowest);
        const max = clamp(action.max ?? highest);
        setFilters({ weightRange: min <= lowest && max >= highest ? null : { min, max } });
        lines.push(`Showing links of weight ${min}–${max}`);
        break;
      }
      case "set_hide_unlinked":
        setFilters({ hideUnlinked: action.on });
        lines.push(
          action.on ? "Hiding nodes without visible links" : "Showing nodes without visible links",
        );
        break;
      case "add_attribute_filter": {
        const nodes = action.target === "nodes";
        const key = findName(action.attribute, nodes ? scope.nodeKeys : scope.edgeKeys);
        if (!key) {
          lines.push(`No attribute ${action.attribute} in this network.`);
          break;
        }
        const text = action.values.map((v) => v.trim()).join("; ");
        const [parsed] = parseAttrRows([{ key, value: text }]);
        if (!parsed) break;
        const filter: AttrFilter = { ...parsed, text };
        const current = nodes ? view.filters.nodeAttr : view.filters.edgeAttr;
        const next = current.some((f) => f.attribute === key)
          ? current.map((f) => (f.attribute === key ? filter : f))
          : [...current, filter];
        setFilters(nodes ? { nodeAttr: next } : { edgeAttr: next });
        attrRows = true;
        lines.push(`Filtering ${nodes ? "nodes" : "links"} by ${key}: ${text}`);
        break;
      }
      case "set_search": {
        view = { ...view, search: action.text };
        const count = nameMatches(network, action.text).length;
        lines.push(
          action.text.trim()
            ? `Searching for "${action.text}": ${count} ${plural(count, "match", "matches")}`
            : "Cleared the name search",
        );
        break;
      }
      case "select_match": {
        const matches = nameMatches(network, view.search);
        const node = matches[action.n - 1];
        if (!node) {
          view = { ...view, selected: null };
          lines.push(
            `Only ${matches.length} ${plural(matches.length, "match", "matches")} for "${view.search}".`,
          );
        } else {
          view = { ...view, selected: { kind: "node", id: node.id } };
          lines.push(`Selected ${node.name}`);
        }
        break;
      }
      case "fit":
        fit = true;
        lines.push("Fitted the view to the visible graph");
        break;
      case "reset":
        view = { filters: initialFilterState(network), search: "", selected: null };
        attrRows = true;
        lines.push("Reset the explorer");
        break;
    }
  }
  return { view, lines, fit, attrRows };
}
