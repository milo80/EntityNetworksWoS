// Right panel: the selected item, then the visible items as a readable list or
// as JSON. Both views list exactly visibleNodes()/visibleEdges().
import { useEffect, useRef, useState } from "react";

import type { GroupStyle } from "../../lib/colors";
import {
  prettyTeam,
  prettyType,
  type AttrValue,
  type Network,
  type NetworkEdge,
  type NetworkNode,
} from "../../lib/network";
import type { Selection } from "./types";

interface Props {
  network: Network;
  nodeById: Map<string, NetworkNode>;
  visibleNodes: NetworkNode[];
  visibleEdges: NetworkEdge[];
  styles: Map<string, GroupStyle>;
  selected: Selection | null;
  onSelect: (s: Selection) => void;
}

type View = "readable" | "json";

function AttrList({ attr }: { attr?: Record<string, AttrValue> | null }) {
  if (!attr) return null;
  return (
    <dl className="small" style={{ margin: "8px 0 0", display: "grid", gap: 4 }}>
      {Object.entries(attr).map(([k, v]) => (
        <div key={k}>
          <dt className="muted" style={{ fontSize: 12 }}>
            {k}
          </dt>
          <dd style={{ margin: 0, wordBreak: "break-word" }}>
            {Array.isArray(v) ? v.join(", ") : String(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SelectedItem({
  network,
  nodeById,
  selected,
}: Pick<Props, "network" | "nodeById" | "selected">) {
  if (!selected) {
    return <p className="small muted">Click a node or link in the graph to see its details.</p>;
  }
  if (selected.kind === "node") {
    const n = nodeById.get(selected.id);
    if (!n) return null;
    return (
      <div>
        <h2>{n.name}</h2>
        <p className="small muted">
          {prettyTeam(n.team)} · {n.role}
        </p>
        <AttrList attr={n.attr} />
      </div>
    );
  }
  const e = network.edges[selected.index];
  if (!e) return null;
  return (
    <div>
      <h2>
        {nodeById.get(e.source)?.name} — {nodeById.get(e.target)?.name}
      </h2>
      <p className="small muted">
        {prettyType(e.type)} · weight {e.weight}
      </p>
      <AttrList attr={e.attr} />
    </div>
  );
}

export function DetailsPanel(p: Props) {
  const [view, setView] = useState<View>("readable");
  const listRef = useRef<HTMLDivElement>(null);
  const selectedKey =
    p.selected?.kind === "node" ? p.selected.id : p.selected ? `e${p.selected.index}` : null;

  // Keep the selected entry in view (both tabs).
  useEffect(() => {
    if (!selectedKey) return;
    const el = listRef.current?.querySelector(`[data-key="${CSS.escape(selectedKey)}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [selectedKey, view]);

  const edgeIndex = (e: NetworkEdge) => p.network.edges.indexOf(e);

  return (
    <>
      <section aria-label="Selection">
        <SelectedItem network={p.network} nodeById={p.nodeById} selected={p.selected} />
      </section>
      <section aria-label="Visible items" style={{ minHeight: 0 }}>
        <div className="tabs" role="tablist" aria-label="Visible items view">
          {(["readable", "json"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              className="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
            >
              {v === "readable" ? `Readable (${p.visibleNodes.length})` : "JSON"}
            </button>
          ))}
        </div>
        <div ref={listRef} role="tabpanel">
          {p.visibleNodes.length === 0 && p.visibleEdges.length === 0 ? (
            <p className="empty">Nothing matches the current filters.</p>
          ) : view === "readable" ? (
            <ul className="entity-list">
              {p.visibleNodes.map((n) => {
                const st = p.styles.get(n.team);
                return (
                  <li
                    key={n.id}
                    data-key={n.id}
                    className={`entity${selectedKey === n.id ? " selected" : ""}`}
                    tabIndex={0}
                    aria-current={selectedKey === n.id || undefined}
                    onClick={() => p.onSelect({ kind: "node", id: n.id, from: "list" })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        p.onSelect({ kind: "node", id: n.id, from: "list" });
                      }
                    }}
                  >
                    <span
                      className={`swatch${st?.hollow ? " hollow" : ""}`}
                      style={{ background: st?.color }}
                      aria-hidden="true"
                    />
                    <span className="name">{n.name}</span>
                    <span className="meta">
                      {n.role} · {prettyTeam(n.team)}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <pre className="json-view">
              {'{\n  "nodes": [\n'}
              {p.visibleNodes.map((n, i) => (
                <div
                  key={n.id}
                  data-key={n.id}
                  className={`json-item${selectedKey === n.id ? " selected" : ""}`}
                >
                  {JSON.stringify(n, null, 2)}
                  {i < p.visibleNodes.length - 1 ? "," : ""}
                </div>
              ))}
              {'  ],\n  "edges": [\n'}
              {p.visibleEdges.map((e, i) => {
                const key = `e${edgeIndex(e)}`;
                return (
                  <div
                    key={key}
                    data-key={key}
                    className={`json-item${selectedKey === key ? " selected" : ""}`}
                  >
                    {JSON.stringify(e, null, 2)}
                    {i < p.visibleEdges.length - 1 ? "," : ""}
                  </div>
                );
              })}
              {"  ]\n}"}
            </pre>
          )}
        </div>
      </section>
    </>
  );
}
