/** Theme, typeface, size, leading and measure, in one small popover. */
import { Minus, Plus } from "lucide-react";
import type { ThemeName } from "../../../../shared/types";
import { useApp } from "../../store";

export function Typography() {
  const s = useApp((x) => x.settings);
  const set = useApp((x) => x.setSettings);
  const step = (key: "fontSize" | "lineHeight" | "measure", by: number, min: number, max: number) => {
    const v = Math.round((s[key] + by) * 100) / 100;
    void set({ [key]: Math.max(min, Math.min(max, v)) });
  };
  const themes: Array<[ThemeName, string]> = [
    ["light", "Paper"],
    ["sepia", "Sepia"],
    ["dark", "Night"],
    ["system", "Auto"],
  ];
  return (
    <div className="typo">
      <div className="typo-themes">
        {themes.map(([t, label]) => (
          <button key={t} className={`typo-theme th-${t} ${s.theme === t ? "on" : ""}`} onClick={() => void set({ theme: t })}>
            <span className="typo-swatch">Aa</span>
            {label}
          </button>
        ))}
      </div>
      <div className="typo-row">
        <span>Typeface</span>
        <div className="segmented">
          <button className={s.readerFont === "serif" ? "on" : ""} onClick={() => void set({ readerFont: "serif" })} style={{ fontFamily: "var(--font-serif)" }}>
            Serif
          </button>
          <button className={s.readerFont === "sans" ? "on" : ""} onClick={() => void set({ readerFont: "sans" })}>
            Sans
          </button>
        </div>
      </div>
      {(
        [
          ["Size", "fontSize", 1, 14, 28, `${s.fontSize}px`],
          ["Spacing", "lineHeight", 0.05, 1.3, 2.1, s.lineHeight.toFixed(2)],
          ["Width", "measure", 4, 48, 96, `${s.measure}`],
        ] as const
      ).map(([label, key, by, min, max, shown]) => (
        <div className="typo-row" key={key}>
          <span>{label}</span>
          <div className="stepper">
            <button className="icon-btn small" onClick={() => step(key, -by, min, max)} aria-label={`Less ${label.toLowerCase()}`}>
              <Minus size={14} />
            </button>
            <span className="stepper-val">{shown}</span>
            <button className="icon-btn small" onClick={() => step(key, by, min, max)} aria-label={`More ${label.toLowerCase()}`}>
              <Plus size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
