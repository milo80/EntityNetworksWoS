// Draggable divider between two panels; also operable with the arrow keys.
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

interface Props {
  label: string;
  /** Current width of the panel this divider sizes, in px. */
  value: number;
  min: number;
  max: number;
  /** +1 when dragging right grows the panel (left panel), -1 otherwise (right panel). */
  direction: 1 | -1;
  onChange: (px: number) => void;
}

const STEP = 24;

export function Resizer({ label, value, min, max, direction, onChange }: Props) {
  const start = useRef<{ x: number; value: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (v: number) => Math.round(Math.max(min, Math.min(max, v)));

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, value };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!start.current) return;
    onChange(clamp(start.current.value + direction * (e.clientX - start.current.x)));
  };
  const onPointerUp = () => {
    start.current = null;
    setDragging(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const delta = e.key === "ArrowRight" ? STEP : e.key === "ArrowLeft" ? -STEP : 0;
    if (delta) {
      e.preventDefault();
      onChange(clamp(value + direction * delta));
    }
  };

  return (
    <button
      type="button"
      className={`resizer${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}
