// Records: the article rows of a dataset as a compact, read-only table. The
// server filters, sorts and pages (50 per page); the view (filters, sort, page)
// lives in the URL, the column choice per dataset in this browser.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { Link, Navigate, useParams, useSearchParams } from "react-router";

import { api, type RecordColumn, type RecordFilter, type RecordOperator } from "../api/client";
import { ErrorNote, Status, formatNumber } from "../components/common";
import {
  DEFAULT_RECORD_COLUMNS,
  DERIVED_NOTE,
  OPERATORS,
  PAGE_SIZE,
  defaultColumns,
  highlight,
  nextSort,
  orderColumns,
  storeColumns,
  storedColumns,
  takesValue,
  viewFromParams,
  viewToParams,
  type RecordsView,
} from "../lib/records";
import { DatasetList, newestFirst, useDatasets } from "./DatasetDataPage";

export const LINK_NOTE =
  "The network file keeps at most 20 shared items per link and skips keywords used in too many articles, so these records may differ from the link.";

/** "Records" without a dataset: open the newest one's records, as "View data" does. */
export function RecordsIndexPage() {
  const datasets = useDatasets();
  if (datasets.isPending) return <p className="empty">Loading…</p>;
  if (datasets.isError) {
    return (
      <div className="page">
        <ErrorNote error={datasets.error} />
      </div>
    );
  }
  const newest = [...datasets.data].sort(newestFirst)[0];
  if (newest) return <Navigate to={`/datasets/${newest.id}/records`} replace />;
  return (
    <div className="page">
      <h1>Records</h1>
      <p className="empty">
        No datasets yet. Upload one in <Link to="/datasets">Datasets</Link>.
      </p>
    </div>
  );
}

export function RecordsPage() {
  const datasetId = Number(useParams().datasetId);
  // A fresh state (column choice, open record) per dataset.
  return <DatasetRecords key={datasetId} datasetId={datasetId} />;
}

function DatasetRecords({ datasetId }: { datasetId: number }) {
  const [params, setParams] = useSearchParams();
  const view = useMemo(() => viewFromParams(params), [params]);
  const setView = (next: Partial<RecordsView>) =>
    setParams(viewToParams({ ...view, page: 1, ...next }));

  const dataset = useQuery({
    queryKey: ["dataset", datasetId],
    queryFn: () => api.getDataset(datasetId),
  });
  // null = the default set. Opened from the explorer, the filtered columns are shown too.
  const [chosen, setChosen] = useState<string[] | null>(() => {
    const stored = storedColumns(datasetId);
    if (!view.from) return stored;
    const base = stored ?? DEFAULT_RECORD_COLUMNS;
    return [...base, ...view.filters.map((f) => f.column).filter((c) => !base.includes(c))];
  });
  const choose = (columns: string[] | null) => {
    setChosen(columns);
    storeColumns(datasetId, columns);
  };
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const openRow = useRef<HTMLTableRowElement | null>(null);

  const requested = chosen ?? DEFAULT_RECORD_COLUMNS;
  const records = useQuery({
    queryKey: ["records", datasetId, view.page, view.filters, view.sort, view.order, requested],
    queryFn: () =>
      api.getRecords(datasetId, {
        page: view.page,
        filters: view.filters,
        sort: view.sort,
        order: view.order,
        columns: requested,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.status === "pending" ? 2000 : false),
  });
  const data = records.data;
  const columns = data?.columns ?? [];
  const available = columns.map((c) => c.name);
  const byName = new Map(columns.map((c) => [c.name, c]));
  const visible = orderColumns(chosen ?? defaultColumns(available), available);
  const shown = visible.length ? visible : available.slice(0, 1);
  const applied = view.filters.filter((f) => byName.has(f.column));
  const pages = data ? Math.max(1, Math.ceil(data.matching / PAGE_SIZE)) : 1;

  return (
    <div className="page page-wide data-layout">
      {/* While a record is open, the page behind it can't be reached (modal). */}
      <div className="records-aside" inert={openIndex !== null}>
        <DatasetList currentId={datasetId} page="records" />
      </div>
      <div className="data-content records" inert={openIndex !== null}>
        <div className="page-header">
          <div>
            <Link to={`/datasets/${datasetId}`} className="back">
              ← {dataset.data?.name ?? "Dataset"}
            </Link>
            <h1>Records</h1>
            <p className="sub" role="status">
              {data?.status === "ready"
                ? `${formatNumber(data.matching)} of ${formatNumber(data.total)} records`
                : "The article rows of the uploaded files."}
            </p>
          </div>
        </div>
        {records.isPending && <p className="empty">Loading…</p>}
        {records.isError && <ErrorNote error={records.error} />}
        {data?.status === "pending" && (
          <p className="empty">
            <Status status="pending" /> — this takes a few seconds after upload.
          </p>
        )}
        {data?.status === "failed" && (
          <p className="error" role="alert">
            The files could not be analysed: {data.error}
          </p>
        )}
        {data?.status === "ready" && (
          <section aria-label="Records" className="records-body">
            {view.from === "link" && <p className="small muted records-note">{LINK_NOTE}</p>}
            {data.ignored_filter_columns.map((c) => (
              <p key={c} className="small error" role="alert">
                Ignored a filter on an unknown column: {c}.
              </p>
            ))}
            <div className="records-toolbar">
              <ColumnPicker
                columns={columns}
                visible={shown}
                onChange={(next) => choose(next)}
                onReset={() => choose(null)}
              />
              <FilterEditor
                key={params.getAll("f").join("\n")}
                columns={columns}
                applied={applied}
                // New filters are the user's own: the link note no longer applies.
                onApply={(filters) => setView({ filters, from: undefined })}
                onClear={() => setView({ filters: [], from: undefined })}
              />
            </div>
            {data.matching === 0 ? (
              <p className="empty">
                {applied.length ? "No records match these filters." : "No records."}
              </p>
            ) : (
              <RecordsTable
                columns={shown.map((c) => byName.get(c)!)}
                rows={data.rows}
                filters={applied}
                view={view}
                onSort={(c) => setView({ ...nextSort(view, c) })}
                onOpen={(index, row) => {
                  openRow.current = row;
                  setOpenIndex(index);
                }}
              />
            )}
            {data.matching > PAGE_SIZE && (
              <nav className="records-pager" aria-label="Pages">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={view.page <= 1}
                  onClick={() => setView({ ...view, page: view.page - 1 })}
                >
                  Previous
                </button>
                <span className="small muted">
                  Page {view.page} of {pages}
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={view.page >= pages}
                  onClick={() => setView({ ...view, page: view.page + 1 })}
                >
                  Next
                </button>
              </nav>
            )}
          </section>
        )}
      </div>
      {openIndex !== null && (
        <RecordDetail
          datasetId={datasetId}
          index={openIndex}
          columns={columns}
          filters={applied}
          onClose={() => {
            // Render first: the row can't take focus while the page behind is inert.
            flushSync(() => setOpenIndex(null));
            openRow.current?.focus();
          }}
        />
      )}
    </div>
  );
}

function DerivedMark() {
  return (
    <>
      <span className="derived-mark" title={DERIVED_NOTE} aria-hidden="true">
        *
      </span>
      <span className="visually-hidden">{` (${DERIVED_NOTE})`}</span>
    </>
  );
}

function Highlighted({
  text,
  column,
  filters,
}: {
  text: string;
  column: string;
  filters: readonly RecordFilter[];
}) {
  return (
    <>
      {highlight(text, column, filters).map((s, i) =>
        s.mark ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>,
      )}
    </>
  );
}

const cellText = (v: unknown) => (v === undefined || v === null ? "" : String(v));

function RecordsTable({
  columns,
  rows,
  filters,
  view,
  onSort,
  onOpen,
}: {
  columns: RecordColumn[];
  rows: { index: number; values: Record<string, string | number> }[];
  filters: readonly RecordFilter[];
  view: RecordsView;
  onSort: (column: string) => void;
  onOpen: (index: number, row: HTMLTableRowElement) => void;
}) {
  const derived = columns.some((c) => c.derived);
  const open = (e: { currentTarget: HTMLTableRowElement }, index: number) =>
    onOpen(index, e.currentTarget);
  return (
    <>
      <div className="table-scroll records-scroll">
        <table className="table records-table">
          <thead>
            <tr>
              {columns.map((c) => {
                const sorted = view.sort === c.name ? view.order : undefined;
                return (
                  <th
                    key={c.name}
                    scope="col"
                    aria-sort={
                      sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined
                    }
                  >
                    <button
                      type="button"
                      className="th-sort"
                      title={`Sort by ${c.name}`}
                      onClick={() => onSort(c.name)}
                    >
                      <span className="th-name">{c.name}</span>
                      {c.derived && <DerivedMark />}
                      <span className="th-arrow" aria-hidden="true">
                        {sorted === "asc" ? "↑" : sorted === "desc" ? "↓" : ""}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.index}
                className="clickable"
                tabIndex={0}
                aria-label={`Record ${r.index + 1}`}
                onClick={(e) => open(e, r.index)}
                onKeyDown={(e: KeyboardEvent<HTMLTableRowElement>) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    open(e, r.index);
                  }
                }}
              >
                {columns.map((c) => {
                  const text = cellText(r.values[c.name]);
                  return (
                    <td key={c.name} className="cell-clip" title={text}>
                      {text ? (
                        <Highlighted text={text} column={c.name} filters={filters} />
                      ) : (
                        <span className="muted">–</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {derived && (
        <p className="small muted">
          <span aria-hidden="true">* </span>
          {DERIVED_NOTE}: computed from the export as the networks do.
        </p>
      )}
    </>
  );
}

function ColumnPicker({
  columns,
  visible,
  onChange,
  onReset,
}: {
  columns: RecordColumn[];
  visible: string[];
  onChange: (columns: string[]) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const shown = new Set(visible);
  return (
    <div className="records-popover-wrap" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <button
        type="button"
        className="btn btn-sm"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        Columns ({visible.length} of {columns.length})
      </button>
      {open && (
        <div id={id} className="records-popover" role="group" aria-label="Columns">
          <ul className="records-columns">
            {columns.map((c) => {
              const checked = shown.has(c.name);
              return (
                <li key={c.name}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={checked && visible.length === 1}
                      onChange={() =>
                        onChange(
                          checked ? visible.filter((v) => v !== c.name) : [...visible, c.name],
                        )
                      }
                    />
                    <span>
                      {c.name}
                      {c.derived && <span className="muted"> ({DERIVED_NOTE})</span>}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <button type="button" className="btn-link small" onClick={onReset}>
            Reset columns
          </button>
        </div>
      )}
    </div>
  );
}

interface FilterRow {
  column: string;
  op: RecordOperator;
  value: string;
}

/** Rows of (column, operator, value). Nothing filters until Apply; Clear removes all. */
function FilterEditor({
  columns,
  applied,
  onApply,
  onClear,
}: {
  columns: RecordColumn[];
  applied: RecordFilter[];
  onApply: (filters: RecordFilter[]) => void;
  onClear: () => void;
}) {
  const first = columns[0]?.name ?? "";
  const empty = (): FilterRow => ({ column: first, op: "contains", value: "" });
  const [open, setOpen] = useState(applied.length > 0);
  const [rows, setRows] = useState<FilterRow[]>(() =>
    applied.length ? applied.map((f) => ({ ...f, value: f.value ?? "" })) : [empty()],
  );
  const id = useId();
  const set = (i: number, patch: Partial<FilterRow>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const apply = () =>
    onApply(
      rows
        .filter((r) => !takesValue(r.op) || r.value.trim())
        .map((r) => ({ ...r, value: takesValue(r.op) ? r.value : "" })),
    );

  return (
    <div className="records-filters">
      <button
        type="button"
        className="btn btn-sm"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        Filters{applied.length ? ` (${applied.length})` : ""}
      </button>
      {open && (
        <fieldset id={id} className="records-filter-box">
          <legend className="visually-hidden">Filters</legend>
          {rows.map((row, i) => (
            <div className="record-filter-row" key={i}>
              <select
                className="select"
                aria-label={`Filter ${i + 1} column`}
                value={row.column}
                onChange={(e) => set(i, { column: e.target.value })}
              >
                {columns.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select
                className="select"
                aria-label={`Filter ${i + 1} operator`}
                value={row.op}
                onChange={(e) => set(i, { op: e.target.value as RecordOperator })}
              >
                {OPERATORS.map((o) => (
                  <option key={o.op} value={o.op}>
                    {o.label}
                  </option>
                ))}
              </select>
              <input
                className="input"
                aria-label={`Filter ${i + 1} value`}
                placeholder={takesValue(row.op) ? "a; b" : ""}
                disabled={!takesValue(row.op)}
                value={takesValue(row.op) ? row.value : ""}
                onChange={(e) => set(i, { value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    apply();
                  }
                }}
              />
              <button
                type="button"
                className="icon-btn"
                aria-label={`Remove filter ${i + 1}`}
                title="Remove"
                onClick={() => setRows(rows.filter((_, j) => j !== i))}
              >
                −
              </button>
            </div>
          ))}
          <div className="attr-actions">
            <button type="button" className="btn btn-sm" onClick={apply}>
              Apply
            </button>
            <button
              type="button"
              className="btn-link small"
              onClick={() => setRows([...rows, empty()])}
            >
              + Add filter
            </button>
            <button
              type="button"
              className="btn-link small"
              onClick={() => {
                setRows([empty()]);
                onClear();
              }}
            >
              Clear
            </button>
            <span className="small muted">“;” = or · rows = and</span>
          </div>
        </fieldset>
      )}
    </div>
  );
}

/** Keep Tab and Shift+Tab within the dialog. */
function trapFocus(e: KeyboardEvent<HTMLElement>) {
  const focusable = [
    ...e.currentTarget.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select, [tabindex]:not([tabindex="-1"])',
    ),
  ];
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function RecordDetail({
  datasetId,
  index,
  columns,
  filters,
  onClose,
}: {
  datasetId: number;
  index: number;
  columns: RecordColumn[];
  filters: readonly RecordFilter[];
  onClose: () => void;
}) {
  const record = useQuery({
    queryKey: ["record", datasetId, index],
    queryFn: () => api.getRecord(datasetId, index),
  });
  const titleId = useId();
  const values = record.data?.values ?? {};
  const title = cellText(values["Article Title"]) || `Record ${index + 1}`;
  return (
    <div className="records-detail-backdrop" onClick={onClose}>
      <div
        className="records-detail"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Tab") trapFocus(e);
        }}
      >
        <div className="records-detail-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="btn btn-sm" autoFocus onClick={onClose}>
            Close
          </button>
        </div>
        {record.isPending && <p className="empty">Loading…</p>}
        {record.isError && <ErrorNote error={record.error} />}
        {record.data && (
          <dl className="records-fields">
            {columns.map((c) => {
              const text = cellText(values[c.name]);
              return (
                <div key={c.name}>
                  <dt>
                    {c.name}
                    {c.derived && <DerivedMark />}
                  </dt>
                  <dd>
                    {text ? (
                      <Highlighted text={text} column={c.name} filters={filters} />
                    ) : (
                      <span className="muted">(empty)</span>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
      </div>
    </div>
  );
}
