// Right panel: the selected item, then the visible items as JSON (exactly
// visibleNodes()/visibleEdges()).
import { useEffect, useRef } from "react";
import { Link } from "react-router";

import {
  prettyTeam,
  prettyType,
  type AttrValue,
  type Network,
  type NetworkEdge,
  type NetworkNode,
} from "../../lib/network";
import { linkRecordsUrl, nodeRecordsUrl, type RecordsSource } from "../../lib/records";
import type { Selection } from "./types";

interface Props {
  network: Network;
  nodeById: Map<string, NetworkNode>;
  visibleNodes: NetworkNode[];
  visibleEdges: NetworkEdge[];
  selected: Selection | null;
  records?: RecordsSource;
}

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

function ShowRecords({ to }: { to: string | null }) {
  if (!to) return null;
  return (
    <p className="small" style={{ marginTop: 8 }}>
      <Link to={to}>Show records</Link>
    </p>
  );
}

/** A link's shared items: "evidence" in custom networks, "shared_keywords" otherwise. */
function sharedItems(e: NetworkEdge): string[] {
  const v = e.attr?.evidence ?? e.attr?.shared_keywords;
  return Array.isArray(v) ? v.map(String) : v ? [String(v)] : [];
}

function SelectedItem({
  network,
  nodeById,
  selected,
  records,
}: Pick<Props, "network" | "nodeById" | "selected" | "records">) {
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
        {records && <ShowRecords to={nodeRecordsUrl(records, n)} />}
        <AttrList attr={n.attr} />
      </div>
    );
  }
  const e = network.edges[selected.index];
  if (!e) return null;
  const a = nodeById.get(e.source);
  const b = nodeById.get(e.target);
  return (
    <div>
      <h2>
        {nodeById.get(e.source)?.name} — {nodeById.get(e.target)?.name}
      </h2>
      <p className="small muted">
        {prettyType(e.type)} · weight {e.weight}
      </p>
      {records && a && b && <ShowRecords to={linkRecordsUrl(records, a, b, sharedItems(e))} />}
      <AttrList attr={e.attr} />
    </div>
  );
}

export function DetailsPanel(p: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const selectedKey =
    p.selected?.kind === "node" ? p.selected.id : p.selected ? `e${p.selected.index}` : null;

  // Keep the selected entry in view.
  useEffect(() => {
    if (!selectedKey) return;
    const el = listRef.current?.querySelector(`[data-key="${CSS.escape(selectedKey)}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [selectedKey]);

  const edgeIndex = (e: NetworkEdge) => p.network.edges.indexOf(e);

  return (
    <>
      {/* The details stay put; only the JSON below scrolls. */}
      <section aria-label="Selection" className="details-selection">
        <SelectedItem
          network={p.network}
          nodeById={p.nodeById}
          selected={p.selected}
          records={p.records}
        />
      </section>
      <section aria-labelledby="details-json-title" className="details-items">
        <h3 id="details-json-title" className="group-title">
          JSON
        </h3>
        <div ref={listRef} className="details-list">
          {p.visibleNodes.length === 0 && p.visibleEdges.length === 0 ? (
            <p className="empty">Nothing matches the current filters.</p>
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
