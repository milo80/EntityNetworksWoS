// Cytoscape wrapper. Builds the graph once per network; visibility, search
// highlight and selection are applied as classes, so filtering never re-lays out.
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import fcose from "cytoscape-fcose";
import { useEffect, useRef, useState } from "react";

import type { GroupStyle } from "../../lib/colors";
import { prettyTeam, shortLabel, type Network } from "../../lib/network";
import type { Selection } from "./types";

cytoscape.use(fcose);

// Cytoscape injects an inline <style> (`position: relative` for its container)
// unless an element with this id already exists. The CSP forbids inline styles
// (style-src 'self') and .graph-canvas is already positioned, so provide the
// marker instead. Checked by the browser tests, which fail on CSP violations.
const CYTOSCAPE_STYLESHEET_ID = "__________cytoscape_stylesheet";
function preventCytoscapeInlineStyle() {
  if (document.getElementById(CYTOSCAPE_STYLESHEET_ID)) return;
  const marker = document.createElement("meta");
  marker.id = CYTOSCAPE_STYLESHEET_ID;
  document.head.appendChild(marker);
}

// fcose: a fast spectral placement, then a short force-directed refinement. A low
// initial energy keeps the refinement close to the spectral result: on the
// 700-node / 3022-link author network this takes ~0.9 s headless, against 7.5 s
// for the built-in "cose" layout (see docs/design-notes.md).
const LAYOUT = {
  name: "fcose",
  animate: false,
  randomize: true,
  uniformNodeDimensions: true,
  initialEnergyOnIncremental: 0.1,
  padding: 30,
} as const;

interface Props {
  network: Network;
  styles: Map<string, GroupStyle>;
  visibleNodeIds: ReadonlySet<string>;
  visibleEdgeIdx: ReadonlySet<number>;
  /** Lower-cased name search; matches are highlighted, nothing is hidden. */
  search: string;
  selected: Selection | null;
  onSelect: (s: Selection | null) => void;
}

interface Tip {
  x: number;
  y: number;
  title: string;
  meta: string;
}

const INK = "#0b0b0b";
const LINE = "#c3c2b7";
const ACCENT = "#1c5cab";
/** Node labels keep this on-screen size at any zoom: the Readable list's size (--text-sm). */
const LABEL_PX = 14;
/** Below this zoom only highlighted and selected nodes are labelled (avoids clutter). */
const LABEL_MIN_ZOOM = 1;

export function GraphView(props: Props) {
  const { network, styles, visibleNodeIds, visibleEdgeIdx, search, selected, onSelect } = props;
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const onSelectRef = useRef(onSelect);
  const [tip, setTip] = useState<Tip | null>(null);
  const [laidOut, setLaidOut] = useState(false);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  // Build the graph when the network changes.
  useEffect(() => {
    if (!container.current) return;
    setLaidOut(false);
    const weights = network.edges.map((e) => e.weight || 1);
    const wMin = Math.min(1, ...weights);
    const wMax = Math.max(1, ...weights);
    const width = (w: number) => (wMax === wMin ? 1.5 : 1 + ((w - wMin) / (wMax - wMin)) * 3);

    const elements: ElementDefinition[] = [
      ...network.nodes.map((n) => {
        const st = styles.get(n.team);
        return {
          group: "nodes" as const,
          data: {
            id: n.id,
            label: shortLabel(n.name),
            color: st?.color ?? LINE,
            hollow: st?.hollow ? 1 : 0,
            name: n.name,
            team: n.team,
            role: n.role,
          },
        };
      }),
      ...network.edges.map((e, i) => ({
        group: "edges" as const,
        data: { id: `e${i}`, source: e.source, target: e.target, w: width(e.weight || 1) },
      })),
    ];

    // Cytoscape scales text with the zoom; these style functions undo that, and
    // are re-evaluated (see the "zoom" handler below) when the zoom changes.
    let zoom = 1;
    const fontFamily = getComputedStyle(document.body).fontFamily;

    preventCytoscapeInlineStyle();
    const cy = cytoscape({
      container: container.current,
      elements,
      minZoom: 0.05,
      maxZoom: 6,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "data(color)",
            width: 14,
            height: 14,
            label: "data(label)",
            "font-size": () => LABEL_PX / zoom,
            "font-family": fontFamily,
            color: INK,
            "text-valign": "bottom",
            "text-margin-y": () => 4 / zoom,
            "text-opacity": () => (zoom >= LABEL_MIN_ZOOM ? 1 : 0),
            "border-width": 0,
          },
        },
        {
          selector: "node[hollow = 1]",
          style: { "background-opacity": 0, "border-width": 2, "border-color": LINE },
        },
        {
          selector: "edge",
          style: {
            width: "data(w)",
            "line-color": LINE,
            opacity: 0.7,
            "curve-style": "haystack",
          },
        },
        {
          selector: ".match",
          style: {
            "border-width": 3,
            "border-color": INK,
            width: 18,
            height: 18,
            "text-opacity": 1,
            "font-weight": "bold",
            "z-index": 10,
          },
        },
        {
          selector: "node:selected",
          style: {
            "border-width": 4,
            "border-color": ACCENT,
            "text-opacity": 1,
            "z-index": 20,
          },
        },
        { selector: "edge:selected", style: { "line-color": ACCENT, opacity: 1, "z-index": 20 } },
        { selector: ".hidden", style: { display: "none" } },
      ],
      layout: { name: "preset" },
    });
    cyRef.current = cy;

    cy.on("tap", "node", (evt) =>
      onSelectRef.current({ kind: "node", id: evt.target.id(), from: "graph" }),
    );
    cy.on("tap", "edge", (evt) =>
      onSelectRef.current({ kind: "edge", index: Number(evt.target.id().slice(1)), from: "graph" }),
    );
    cy.on("tap", (evt) => {
      if (evt.target === cy) onSelectRef.current(null);
    });
    cy.on("mouseover", "node", (evt) => {
      const p = evt.renderedPosition;
      const d = evt.target.data();
      setTip({ x: p.x, y: p.y, title: d.name, meta: `${prettyTeam(d.team)} · ${d.role}` });
    });
    cy.on("mouseout", "node", () => setTip(null));
    cy.on("viewport", () => setTip(null));

    // Re-apply the label size when the zoom changes by more than 2% (the drift
    // in between is invisible), at most once per frame.
    let frame = 0;
    const applyZoom = () => {
      frame = 0;
      const z = cy.zoom();
      if (Math.abs(z / zoom - 1) < 0.02 && z >= LABEL_MIN_ZOOM === zoom >= LABEL_MIN_ZOOM) return;
      zoom = z;
      cy.style().update();
    };
    cy.on("zoom", () => {
      frame ||= window.requestAnimationFrame(applyZoom);
    });

    // Lay out after first paint so the page shows up before the (CPU-heavy) layout.
    const handle = window.setTimeout(() => {
      cy.layout(LAYOUT).run();
      cy.fit(undefined, 30);
      setLaidOut(true);
    }, 0);

    const resize = new ResizeObserver(() => cy.resize());
    resize.observe(container.current);

    return () => {
      window.clearTimeout(handle);
      window.cancelAnimationFrame(frame);
      resize.disconnect();
      cy.destroy();
      cyRef.current = null;
    };
  }, [network, styles]);

  // Visibility: toggle classes only.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        n.toggleClass("hidden", !visibleNodeIds.has(n.id()));
      });
      cy.edges().forEach((e) => {
        e.toggleClass("hidden", !visibleEdgeIdx.has(Number(e.id().slice(1))));
      });
    });
  }, [visibleNodeIds, visibleEdgeIdx, network]);

  // Name search highlight.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        const name = String(n.data("name")).toLowerCase();
        n.toggleClass("match", search.length > 0 && name.includes(search));
      });
    });
  }, [search, network]);

  // Selection (from the graph itself or from the details panel).
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().unselect();
    if (!selected) return;
    const el =
      selected.kind === "node"
        ? cy.getElementById(selected.id)
        : cy.getElementById(`e${selected.index}`);
    if (el.empty()) return;
    el.select();
    if (selected.from === "list") {
      cy.animate({ center: { eles: el } }, { duration: 250 });
    }
  }, [selected, network]);

  return (
    <div className="graph-wrap">
      <div ref={container} className="graph-canvas" data-testid="graph-canvas" />
      {!laidOut && <div className="graph-overlay">Laying out {network.nodes.length} nodes…</div>}
      {tip && (
        <div className="tooltip" style={{ left: tip.x, top: tip.y }} role="tooltip">
          <strong>{tip.title}</strong>
          <br />
          {tip.meta}
        </div>
      )}
    </div>
  );
}
