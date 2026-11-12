// Editing state of one "attribute search" panel (shared by nodes and edges, as
// in the prototype). Rows are edited freely; nothing filters until Apply turns
// them into AttrFilters (see visibility.parseAttrRows).
export interface AttrRow {
  key: string;
  value: string;
}

/** One empty row for the first key, or no rows when the data has no attributes. */
export function initialRows(keys: readonly string[]): AttrRow[] {
  return keys.length ? [{ key: keys[0]!, value: "" }] : [];
}

export function unusedKeys(rows: readonly AttrRow[], keys: readonly string[]): string[] {
  const used = new Set(rows.map((r) => r.key));
  return keys.filter((k) => !used.has(k));
}

/** Add a row for the next unused key (each key can be used once). */
export function addRow(rows: readonly AttrRow[], keys: readonly string[]): AttrRow[] {
  const next = unusedKeys(rows, keys)[0];
  return next === undefined ? [...rows] : [...rows, { key: next, value: "" }];
}

export function removeRow(rows: readonly AttrRow[], index: number): AttrRow[] {
  return rows.filter((_, i) => i !== index);
}

/** Changing the attribute clears the text: it belonged to the previous attribute. */
export function setRowKey(rows: readonly AttrRow[], index: number, key: string): AttrRow[] {
  return rows.map((r, i) => (i === index ? { key, value: "" } : r));
}

export function setRowValue(rows: readonly AttrRow[], index: number, value: string): AttrRow[] {
  return rows.map((r, i) => (i === index ? { ...r, value } : r));
}

/** Keys selectable in a row: its own key plus those not used by other rows. */
export function keyOptions(rows: readonly AttrRow[], keys: readonly string[], index: number) {
  const own = rows[index]?.key;
  const usedElsewhere = new Set(rows.filter((_, i) => i !== index).map((r) => r.key));
  return keys.filter((k) => k === own || !usedElsewhere.has(k));
}
