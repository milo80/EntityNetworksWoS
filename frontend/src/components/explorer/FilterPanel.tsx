import type { GroupStyle } from "../../lib/colors";
import { prettyTeam, prettyType, type Network } from "../../lib/network";
import type { AttrFilter, FilterState } from "../../lib/visibility";
import { AttrSearch } from "./AttrSearch";

interface Props {
  network: Network;
  teams: string[];
  teamCounts: Map<string, number>;
  relations: string[];
  styles: Map<string, GroupStyle>;
  state: FilterState;
  onChange: (state: FilterState) => void;
  search: string;
  onSearch: (q: string) => void;
  matchCount: number;
  nodeKeys: string[];
  edgeKeys: string[];
}

function toggled(set: ReadonlySet<string>, value: string, on: boolean): Set<string> {
  const next = new Set(set);
  if (on) next.add(value);
  else next.delete(value);
  return next;
}

export function FilterPanel(p: Props) {
  const { state, onChange } = p;
  const allTeams = state.teams.size === p.teams.length;
  const attrActive = state.nodeAttr.length + state.edgeAttr.length;

  return (
    <>
      <div>
        <label htmlFor="name-search" className="group-title">
          Find by name
        </label>
        <input
          id="name-search"
          className="input"
          type="search"
          placeholder="Highlights matches"
          value={p.search}
          onChange={(e) => p.onSearch(e.target.value)}
        />
        {p.search.trim() && (
          <p className="small muted" role="status" style={{ marginTop: 4 }}>
            {p.matchCount} match{p.matchCount === 1 ? "" : "es"} highlighted
          </p>
        )}
      </div>

      <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="group-title" style={{ width: "100%" }}>
          <span>Group</span>
          <button
            type="button"
            className="btn-link"
            onClick={() => onChange({ ...state, teams: new Set(allTeams ? [] : p.teams) })}
          >
            {allTeams ? "Hide all" : "Show all"}
          </button>
        </legend>
        {p.teams.map((team) => {
          const st = p.styles.get(team);
          return (
            <label key={team} className="check">
              <input
                type="checkbox"
                checked={state.teams.has(team)}
                onChange={(e) =>
                  onChange({ ...state, teams: toggled(state.teams, team, e.target.checked) })
                }
              />
              <span
                className={`swatch${st?.hollow ? " hollow" : ""}`}
                style={{ background: st?.color }}
                aria-hidden="true"
              />
              {prettyTeam(team)}
              <span className="count">{p.teamCounts.get(team)}</span>
            </label>
          );
        })}
      </fieldset>

      <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="group-title">Relationship</legend>
        {p.relations.map((rel) => (
          <label key={rel} className="check">
            <input
              type="checkbox"
              checked={state.relations.has(rel)}
              onChange={(e) =>
                onChange({ ...state, relations: toggled(state.relations, rel, e.target.checked) })
              }
            />
            {prettyType(rel)}
          </label>
        ))}
        <p className="small muted" style={{ marginTop: 4 }}>
          Hides links only, not the people or institutions.
        </p>
      </fieldset>

      <details open={attrActive > 0 || undefined}>
        <summary className="group-title" style={{ display: "list-item" }}>
          Attribute search{attrActive ? ` · ${attrActive} applied` : ""}
        </summary>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 8 }}>
          <p className="small muted">
            Comma-separated terms match any (OR); conditions combine (AND).
          </p>
          <AttrSearch
            label="Nodes"
            items={p.network.nodes}
            keys={p.nodeKeys}
            applied={state.nodeAttr}
            onApply={(nodeAttr: AttrFilter[]) => onChange({ ...state, nodeAttr })}
          />
          <AttrSearch
            label="Links"
            items={p.network.edges}
            keys={p.edgeKeys}
            applied={state.edgeAttr}
            onApply={(edgeAttr: AttrFilter[]) => onChange({ ...state, edgeAttr })}
          />
        </div>
      </details>
    </>
  );
}
