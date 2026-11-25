// Attribute search for nodes or edges: rows of (attribute, terms separated by ";").
// Terms in a row combine with OR, rows with AND. Nothing filters until Apply.
import { useId, useState } from "react";

import {
  addRow,
  initialRows,
  keyOptions,
  removeRow,
  setRowKey,
  setRowValue,
  unusedKeys,
  type AttrRow,
} from "../../lib/attrSearch";
import { attrValues, type Attributed } from "../../lib/network";
import { parseAttrRows, type AttrFilter } from "../../lib/visibility";

interface Props {
  label: string;
  items: Attributed[];
  keys: string[];
  applied: readonly AttrFilter[];
  onApply: (filters: AttrFilter[]) => void;
}

/** The applied filters as rows (as typed), or one empty row. */
function rowsOf(applied: readonly AttrFilter[], keys: string[]): AttrRow[] {
  return applied.length
    ? applied.map((f) => ({ key: f.attribute, value: f.text ?? f.values.join("; ") }))
    : initialRows(keys);
}

export function AttrSearch({ label, items, keys, applied, onApply }: Props) {
  // Remounted (new key) when the filters change from outside, e.g. the assistant.
  const [rows, setRows] = useState<AttrRow[]>(() => rowsOf(applied, keys));
  const uid = useId();
  const apply = () =>
    onApply(
      parseAttrRows(rows).map((f) => ({
        ...f,
        text: rows.find((r) => r.key === f.attribute)?.value.trim(),
      })),
    );

  if (keys.length === 0) {
    return (
      <div>
        <div className="field-label small">{label}</div>
        <p className="small muted">No searchable attributes.</p>
      </div>
    );
  }

  return (
    <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
      <legend className="field-label small" style={{ marginBottom: 8 }}>
        {label}
      </legend>
      {rows.map((row, i) => {
        const listId = `${uid}-values-${i}`;
        return (
          <div className="attr-row" key={i}>
            <select
              className="select"
              aria-label={`${label} attribute ${i + 1}`}
              value={row.key}
              onChange={(e) => setRows(setRowKey(rows, i, e.target.value))}
            >
              {keyOptions(rows, keys, i).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <input
              className="input"
              aria-label={`${label} ${row.key} contains`}
              placeholder="contains… (a; b)"
              list={listId}
              value={row.value}
              onChange={(e) => setRows(setRowValue(rows, i, e.target.value))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  apply();
                }
              }}
            />
            <datalist id={listId}>
              {attrValues(items, row.key)
                .slice(0, 500)
                .map((v) => (
                  <option key={v} value={v} />
                ))}
            </datalist>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Remove ${row.key} filter`}
              title="Remove"
              onClick={() => setRows(removeRow(rows, i))}
            >
              −
            </button>
          </div>
        );
      })}
      <div className="attr-actions">
        <button type="button" className="btn btn-sm" onClick={apply}>
          Apply
        </button>
        {unusedKeys(rows, keys).length > 0 && (
          <button
            type="button"
            className="btn-link small"
            onClick={() => setRows(addRow(rows, keys))}
          >
            + Add condition
          </button>
        )}
        {applied.length > 0 && (
          <>
            <span className="applied" role="status">
              {applied.length} applied
            </span>
            <button
              type="button"
              className="btn-link small"
              onClick={() => {
                setRows(initialRows(keys));
                onApply([]);
              }}
            >
              Clear
            </button>
          </>
        )}
      </div>
    </fieldset>
  );
}
