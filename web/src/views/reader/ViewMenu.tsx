/** Theme, one page or two, size and the page-turn, in one small popover. */
import { Minus, Plus } from "lucide-react";
import type { PageLayout, ThemeName } from "../../../../shared/types";
import { useApp } from "../../store";

export function ViewMenu() {
  const s = useApp((x) => x.settings);
  const set = useApp((x) => x.setSettings);
  const zoomTo = (z: number) => void set({ pageZoom: Math.round(Math.max(1, Math.min(3, z)) * 100) / 100 });
  const themes: Array<[ThemeName, string]> = [
    ["light", "Paper"],
    ["sepia", "Sepia"],
    ["dark", "Night"],
    ["system", "Auto"],
  ];
  const layouts: Array<[PageLayout, string]> = [
    ["auto", "Auto"],
    ["spread", "Two pages"],
    ["single", "One page"],
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
        <span>Pages</span>
        <div className="segmented">
          {layouts.map(([l, label]) => (
            <button key={l} className={s.pageLayout === l ? "on" : ""} onClick={() => void set({ pageLayout: l })}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="typo-row">
        <span>Size</span>
        <div className="stepper">
          <button className="icon-btn small" onClick={() => zoomTo(s.pageZoom - 0.25)} disabled={s.pageZoom <= 1} aria-label="Smaller  (-)" title="Smaller  (-)">
            <Minus size={14} />
          </button>
          <button className="stepper-val" onClick={() => zoomTo(1)} title="Fit the window  (0)">
            {s.pageZoom <= 1 ? "Fit" : `${Math.round(s.pageZoom * 100)}%`}
          </button>
          <button className="icon-btn small" onClick={() => zoomTo(s.pageZoom + 0.25)} disabled={s.pageZoom >= 3} aria-label="Larger  (+)" title="Larger  (+)">
            <Plus size={14} />
          </button>
        </div>
      </div>
      <label className="typo-row typo-check">
        <span>Trim the margins</span>
        <input type="checkbox" checked={s.pageTrim} onChange={(e) => void set({ pageTrim: e.target.checked })} />
      </label>
      <label className="typo-row typo-check">
        <span>Turn pages like paper</span>
        <input type="checkbox" checked={s.pageTurn} onChange={(e) => void set({ pageTurn: e.target.checked })} />
      </label>
      <label className="typo-row typo-check">
        <span>Darken pages at night</span>
        <input type="checkbox" checked={s.nightPages} onChange={(e) => void set({ nightPages: e.target.checked })} />
      </label>
    </div>
  );
}
