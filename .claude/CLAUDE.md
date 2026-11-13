# EntityNetworks: project notes for Claude

## Network graph (Cytoscape) conventions

- **Node labels keep a constant on-screen size at every zoom**, equal to the
  side-panel list text (`--text-sm`, 14 px) and in the UI font. Cytoscape scales
  text with the zoom by default, which makes labels huge when zoomed in. Undo it
  with style functions (`"font-size": () => LABEL_PX / zoom`, same for
  `text-margin-y`) and call `cy.style().update()` on `zoom`, at most once per
  animation frame and only when the zoom changed by more than 2%. Don't use
  `min-zoomed-font-size` to hide labels; use `text-opacity` below a zoom
  threshold, and always label search matches and the selected node.
  Reference: `frontend/src/components/explorer/GraphView.tsx`.
- **Layout:** `cytoscape-fcose` with `uniformNodeDimensions: true` and
  `initialEnergyOnIncremental: 0.1` (~1.5 s in the browser for 700 nodes / 3000
  links). Lowering `numIter` doesn't speed it up. Measure on
  `backend/tests/fixtures/golden/network_author.json` before changing it.
- **Group colors:** the 7 largest groups get the first 7 slots of the reference
  categorical palette (fixed order, assigned once per network, never repainted
  by filters); the rest and "other" are gray; "unknown" is hollow. Group names in
  the filter list, tooltip and details panel are the secondary encoding.
  Reference: `frontend/src/lib/colors.ts`, `docs/design-notes.md`.
