// Small shared presentational pieces.

const STATUS_ICON: Record<string, string> = {
  succeeded: "✓",
  ready: "✓",
  failed: "✕",
  running: "◌",
  queued: "…",
  pending: "…",
};
const STATUS_LABEL: Record<string, string> = {
  succeeded: "Ready",
  ready: "Ready",
  failed: "Failed",
  running: "Building",
  queued: "Queued",
  pending: "Analysing",
};

/** Status is always icon + text, never color alone. */
export function Status({ status, title }: { status: string; title?: string | null }) {
  return (
    <span className={`status status-${status}`} title={title ?? undefined}>
      <span aria-hidden="true">{STATUS_ICON[status] ?? "•"}</span>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
export const formatDate = (iso: string) => dateFmt.format(new Date(iso));

const numFmt = new Intl.NumberFormat();
export const formatNumber = (n: number) => numFmt.format(n);

export function ErrorNote({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : "Something went wrong";
  return (
    <p className="error" role="alert">
      {message}
    </p>
  );
}
