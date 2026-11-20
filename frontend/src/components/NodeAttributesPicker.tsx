// The fields added to each node of a custom network for the explorer's
// attribute search: a list with (−) per field and a (+) catalogue of every
// field the dataset has (from the network options), so new export columns
// show up without code changes.
import { useEffect, useRef, useState } from "react";
import type { NetworkOptions } from "../api/client";

type AttributeOption = NetworkOptions["attributes"][number];

export function NodeAttributesPicker({
  id,
  options,
  entity,
  chosen,
  onChange,
  describedBy,
}: {
  id: string;
  options: AttributeOption[];
  entity: string;
  chosen: string[];
  onChange: (next: string[]) => void;
  describedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const byKey = new Map(options.map((o) => [o.key, o]));

  // Close the catalogue on a click outside it or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const addable = options.filter(
    (o) => !chosen.includes(o.key) && (!q || o.label.toLowerCase().includes(q)),
  );

  // Why a chosen field won't be added to these nodes (shown, not dropped).
  const note = (key: string): string | null => {
    const o = byKey.get(key);
    if (!o) return "not in this data";
    if (o.not_for.includes(entity as never)) return "same field as the nodes";
    return null;
  };

  return (
    <div className="attr-picker" ref={wrap}>
      <ul
        id={id}
        className="attr-list"
        aria-label="Attributes for search"
        aria-describedby={describedBy}
      >
        {chosen.length === 0 && <li className="attr-empty">None</li>}
        {chosen.map((key) => {
          const why = note(key);
          const label = byKey.get(key)?.label ?? key;
          return (
            <li key={key} className={why ? "attr-item attr-item-off" : "attr-item"}>
              <span className="attr-name">
                {label}
                {why && <span className="attr-note"> ({why})</span>}
              </span>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label={`Remove ${label}`}
                title="Remove"
                onClick={() => onChange(chosen.filter((k) => k !== key))}
              >
                −
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="icon-btn icon-btn-sm attr-add"
        aria-label="Add a field"
        title="Add a field"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((x) => !x)}
      >
        +
      </button>
      {open && (
        <div className="attr-popup" role="dialog" aria-label="Fields">
          <input
            className="input"
            type="search"
            placeholder="Filter fields…"
            aria-label="Filter fields"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul className="attr-catalog">
            {addable.length === 0 && <li className="attr-empty">No more fields</li>}
            {addable.map((o) => (
              <li key={o.key}>
                <button
                  type="button"
                  className="attr-option"
                  aria-label={`Add ${o.label}`}
                  onClick={() => onChange([...chosen, o.key])}
                >
                  <span>{o.label}</span>
                  {o.fill_pct != null && <span className="count">{o.fill_pct}%</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
