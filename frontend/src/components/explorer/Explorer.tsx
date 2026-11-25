// The network explorer: filters | graph | details. Owns the filter state and
// computes visibility once; graph and JSON both render from it.
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { ExplorerAction } from "../../api/client";
import { applyAssistantActions } from "../../lib/assistantActions";
import { groupStyles, orderedTeams, teamCounts } from "../../lib/colors";
import { attrKeys, type Network } from "../../lib/network";
import type { RecordsSource } from "../../lib/records";
import { computeVisibility, initialFilterState, type FilterState } from "../../lib/visibility";
import { useAssistantExplorer } from "../assistant/AssistantContext";
import { DetailsPanel } from "./DetailsPanel";
import { FilterPanel } from "./FilterPanel";
import { GraphView } from "./GraphView";
import { Resizer } from "./Resizer";
import type { Selection } from "./types";

interface Props {
  network: Network;
  title: string;
  /** Extra controls in the header. */
  actions?: ReactNode;
  /** A back link above the title. */
  back?: ReactNode;
  /** Below the graph (e.g. Download). */
  footer?: ReactNode;
  /** Where the network's records are: enables "Show records" on a selection. */
  records?: RecordsSource;
  /** The network's run; null for a local file (the assistant only drives runs). */
  runId?: number | null;
}

const MIN_SIDE = 200;
const MIN_GRAPH = 320;

export function Explorer({ network, title, actions, back, footer, records, runId = null }: Props) {
  const styles = useMemo(() => groupStyles(network), [network]);
  const teams = useMemo(() => orderedTeams(network, styles), [network, styles]);
  const counts = useMemo(() => teamCounts(network), [network]);
  const nodeKeys = useMemo(() => attrKeys(network.nodes), [network]);
  const edgeKeys = useMemo(() => attrKeys(network.edges), [network]);
  const weights = useMemo(() => network.edges.map((e) => e.weight ?? 1), [network]);
  const nodeById = useMemo(() => new Map(network.nodes.map((n) => [n.id, n])), [network]);
  const edgeIndex = useMemo(() => new Map(network.edges.map((e, i) => [e, i])), [network]);

  const [filters, setFilters] = useState<FilterState>(() => initialFilterState(network));
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Selection | null>(null);
  const [open, setOpen] = useState<"left" | "right" | null>(null);
  const relations = useMemo(() => [...new Set(network.edges.map((e) => e.type))], [network]);

  // The assistant's actions set the same state the controls do (group colors
  // come from `styles`, which never changes with the filters).
  const [attrVersion, setAttrVersion] = useState(0);
  const [fitRequest, setFitRequest] = useState(0);
  useAssistantExplorer(runId, (actions: ExplorerAction[]) => {
    const result = applyAssistantActions(
      actions,
      { filters, search, selected },
      { network, teams, nodeKeys, edgeKeys, weights },
    );
    setFilters(result.view.filters);
    setSearch(result.view.search);
    setSelected(result.view.selected);
    if (result.attrRows) setAttrVersion((v) => v + 1);
    if (result.fit) setFitRequest((v) => v + 1);
    return result.lines;
  });

  const visibility = useMemo(() => computeVisibility(network, filters), [network, filters]);
  const visibleNodes = useMemo(() => visibility.visibleNodes(), [visibility]);
  const visibleEdges = useMemo(() => visibility.visibleEdges(), [visibility]);
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);
  const visibleEdgeIdx = useMemo(
    () => new Set(visibleEdges.map((e) => edgeIndex.get(e)!)),
    [visibleEdges, edgeIndex],
  );
  const q = search.trim().toLowerCase();
  const matchCount = useMemo(
    () => (q ? network.nodes.filter((n) => n.name.toLowerCase().includes(q)).length : 0),
    [network, q],
  );

  // Panel widths: graph gets half of the space initially; sides a quarter each.
  // The container width is tracked in state so limits stay right on window resize.
  const root = useRef<HTMLDivElement>(null);
  const [total, setTotal] = useState(0);
  const [widths, setWidths] = useState<{ left: number; right: number } | null>(null);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const w = el.clientWidth || 1200;
    setTotal(w);
    setWidths({ left: Math.max(MIN_SIDE, w / 4), right: Math.max(MIN_SIDE, w / 4) });
    const observer = new ResizeObserver(() => setTotal(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const maxSide = (other: number) => Math.max(MIN_SIDE, total - other - MIN_GRAPH);

  const onSelect = useCallback((s: Selection | null) => setSelected(s), []);

  return (
    <div className="explorer" ref={root}>
      <aside
        className={`ex-side left ex-filters${open === "left" ? " open" : ""}`}
        style={{ width: widths?.left }}
        aria-label="Filters"
      >
        <FilterPanel
          network={network}
          teams={teams}
          teamCounts={counts}
          styles={styles}
          state={filters}
          onChange={setFilters}
          search={search}
          onSearch={setSearch}
          matchCount={matchCount}
          nodeKeys={nodeKeys}
          edgeKeys={edgeKeys}
          weights={weights}
          shownLinks={visibleEdges.length}
          relations={relations}
          attrVersion={attrVersion}
        />
      </aside>
      {widths && (
        <Resizer
          label="Resize filters panel"
          value={widths.left}
          min={MIN_SIDE}
          max={maxSide(widths.right)}
          direction={1}
          onChange={(left) => setWidths({ ...widths, left })}
        />
      )}

      <div className="ex-center">
        <div className="ex-head">
          <div>
            {back}
            <h1>{title}</h1>
            <p className="sub" role="status">
              {visibleNodes.length} of {network.nodes.length} nodes · {visibleEdges.length} of{" "}
              {network.edges.length} links shown
            </p>
          </div>
          <div className="form-row" style={{ gap: 8 }}>
            <div className="ex-toggles">
              <button
                type="button"
                className="btn btn-sm"
                aria-expanded={open === "left"}
                onClick={() => setOpen(open === "left" ? null : "left")}
              >
                Filters
              </button>
              <button
                type="button"
                className="btn btn-sm"
                aria-expanded={open === "right"}
                onClick={() => setOpen(open === "right" ? null : "right")}
              >
                Details
              </button>
            </div>
            {actions}
          </div>
        </div>
        <GraphView
          network={network}
          styles={styles}
          visibleNodeIds={visibleNodeIds}
          visibleEdgeIdx={visibleEdgeIdx}
          search={q}
          selected={selected}
          onSelect={onSelect}
          fitRequest={fitRequest}
        />
        {footer && <div className="ex-foot">{footer}</div>}
      </div>

      {widths && (
        <Resizer
          label="Resize details panel"
          value={widths.right}
          min={MIN_SIDE}
          max={maxSide(widths.left)}
          direction={-1}
          onChange={(right) => setWidths({ ...widths, right })}
        />
      )}
      <aside
        className={`ex-side right ex-details${open === "right" ? " open" : ""}`}
        style={{ width: widths?.right }}
        aria-label="Details"
      >
        <DetailsPanel
          network={network}
          nodeById={nodeById}
          visibleNodes={visibleNodes}
          visibleEdges={visibleEdges}
          selected={selected}
          records={records}
        />
      </aside>
    </div>
  );
}
