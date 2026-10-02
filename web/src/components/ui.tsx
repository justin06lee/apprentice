/**
 * Small shared pieces: anchored popovers, modals, toasts, progress rings.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../store";

export interface Anchor {
  x: number;
  y: number;
  /** The anchor's own height, so a popover can sit below it when there is no room above. */
  h?: number;
}

/**
 * A popover pinned to a point. It measures itself and stays on screen —
 * above the anchor when it fits, below otherwise — and closes on Escape or
 * a click anywhere outside it.
 */
export function Popover({
  anchor,
  onClose,
  children,
  className = "",
  placement = "above",
  style,
}: {
  anchor: Anchor;
  onClose(): void;
  children: ReactNode;
  className?: string;
  placement?: "above" | "below";
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    let left = anchor.x - r.width / 2;
    left = Math.max(margin, Math.min(window.innerWidth - r.width - margin, left));
    const aboveTop = anchor.y - r.height - 10;
    const belowTop = anchor.y + (anchor.h ?? 0) + 10;
    const useAbove = placement === "above" ? aboveTop > margin : belowTop + r.height > window.innerHeight - margin;
    const top = Math.max(margin, Math.min(window.innerHeight - r.height - margin, useAbove ? aboveTop : belowTop));
    setPos({ left, top, origin: useAbove ? "bottom center" : "top center" });
  }, [anchor.x, anchor.y, anchor.h, placement]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    // Registered after the click that opened it has finished.
    const t = setTimeout(() => window.addEventListener("pointerdown", down, true), 0);
    window.addEventListener("keydown", key, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className={`popover ${className}`}
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        visibility: pos ? "visible" : "hidden",
        ["--origin" as string]: pos?.origin,
        ...style,
      }}
      // Keep the reader's text selection alive while they use the menu —
      // except in fields, which need the click to take focus.
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) e.preventDefault();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export function Modal({ onClose, children, width }: { onClose(): void; children: ReactNode; width?: number }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  return createPortal(
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width: `min(${width}px, calc(100vw - 48px))` } : undefined}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismiss);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <span style={{ flex: 1 }}>{t.text}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function Ring({ value, size = 18, stroke = 2.5, color = "var(--accent)" }: { value: number; size?: number; stroke?: number; color?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flex: "none", transform: "rotate(-90deg)" }} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
      {v > 0 && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={v >= 0.999 ? "var(--good)" : color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * v} ${c}`}
          style={{ transition: "stroke-dasharray 320ms cubic-bezier(.2,.8,.2,1)" }}
        />
      )}
    </svg>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange(v: boolean): void; label?: string }) {
  return <button className={`switch ${on ? "on" : ""}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />;
}

/** Run `fn` when the window is resized or the element changes size. */
export function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}
