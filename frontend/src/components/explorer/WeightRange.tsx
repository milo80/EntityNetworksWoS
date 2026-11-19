// "Link weight" filter: a two-handle range over the network's distinct link
// weights, with a histogram of how many links have each weight. Weights are
// very skewed (most links often have weight 1), so the bar steps over the
// weights that exist instead of a linear scale: every position is a real value
// and a wide window from 1 to the maximum stays easy to set.
import { useMemo } from "react";

interface Props {
  /** Weight of every link in the network (not only the visible ones). */
  weights: readonly number[];
  range: { min: number; max: number } | null;
  onRange: (range: { min: number; max: number } | null) => void;
  hideUnlinked: boolean;
  onHideUnlinked: (on: boolean) => void;
  /** Links visible with all filters applied. */
  shown: number;
}

const MAX_BARS = 24;

export function WeightRange({
  weights,
  range,
  onRange,
  hideUnlinked,
  onHideUnlinked,
  shown,
}: Props) {
  const { values, bars } = useMemo(() => {
    const counts = new Map<number, number>();
    for (const w of weights) counts.set(w, (counts.get(w) ?? 0) + 1);
    const values = [...counts.keys()].sort((a, b) => a - b);
    // Group consecutive distinct values into at most MAX_BARS bars, so the
    // histogram lines up with the slider positions.
    const per = Math.max(1, Math.ceil(values.length / MAX_BARS));
    const bars: { from: number; to: number; count: number }[] = [];
    for (let i = 0; i < values.length; i += per) {
      const slice = values.slice(i, i + per);
      bars.push({
        from: i,
        to: i + slice.length - 1,
        count: slice.reduce((sum, v) => sum + counts.get(v)!, 0),
      });
    }
    return { values, bars };
  }, [weights]);

  if (values.length <= 1) {
    return (
      <p className="small muted">
        {values.length === 0 ? "No links." : `All links have weight ${values[0]}.`}
      </p>
    );
  }

  const last = values.length - 1;
  const lo = range
    ? Math.max(
        0,
        values.findIndex((v) => v >= range.min),
      )
    : 0;
  const hiFound = range ? values.findLastIndex((v) => v <= range.max) : last;
  const hi = hiFound < 0 ? last : hiFound;
  const set = (nextLo: number, nextHi: number) =>
    onRange(
      nextLo === 0 && nextHi === last ? null : { min: values[nextLo]!, max: values[nextHi]! },
    );
  const maxCount = Math.max(...bars.map((b) => b.count));
  const pct = (i: number) => (i / last) * 100;

  return (
    <div className="weight-range">
      <div className="wr-hist" aria-hidden="true">
        {bars.map((b) => (
          <span
            key={b.from}
            className={b.to >= lo && b.from <= hi ? "in" : ""}
            style={{
              height: `${Math.max(6, (Math.log1p(b.count) / Math.log1p(maxCount)) * 100)}%`,
            }}
            title={`${b.count} links`}
          />
        ))}
      </div>
      <div className="wr-slider">
        <div className="wr-track" />
        <div className="wr-fill" style={{ left: `${pct(lo)}%`, right: `${100 - pct(hi)}%` }} />
        <input
          id="weight-min"
          type="range"
          min={0}
          max={last}
          step={1}
          value={lo}
          aria-label="Lowest link weight shown"
          aria-valuetext={String(values[lo])}
          onChange={(e) => set(Math.min(Number(e.target.value), hi), hi)}
        />
        <input
          id="weight-max"
          type="range"
          min={0}
          max={last}
          step={1}
          value={hi}
          aria-label="Highest link weight shown"
          aria-valuetext={String(values[hi])}
          onChange={(e) => set(lo, Math.max(Number(e.target.value), lo))}
        />
      </div>
      <div className="wr-scale small muted">
        <span>{values[0]}</span>
        <span>{values[last]}</span>
      </div>
      <p className="small" role="status">
        Showing weight <b>{values[lo]}</b>–<b>{values[hi]}</b> · {shown.toLocaleString("en-US")} of{" "}
        {weights.length.toLocaleString("en-US")} links
        {range && (
          <>
            {" "}
            <button type="button" className="btn-link small" onClick={() => onRange(null)}>
              Reset
            </button>
          </>
        )}
      </p>
      <label className="check">
        <input
          id="hide-unlinked"
          type="checkbox"
          checked={hideUnlinked}
          onChange={(e) => onHideUnlinked(e.target.checked)}
        />
        Hide nodes without visible links
      </label>
      <p className="small muted">
        Weight = shared articles (or matched article pairs) behind a link.
      </p>
    </div>
  );
}
