/** Settings: how the book looks, which model helps, how reviews are paced. */
import { CircleCheck, CircleX, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { ThemeName } from "../../../../shared/types";
import { Switch } from "../../components/ui";
import { mod } from "../../lib/format";
import { useApp } from "../../store";
import "../../styles/settings.css";

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-title">{title}</div>
        {hint && <div className="set-hint">{hint}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

export function Settings() {
  const s = useApp((x) => x.settings);
  const set = useApp((x) => x.setSettings);
  const ai = useApp((x) => x.ai);
  const refreshAi = useApp((x) => x.refreshAi);
  const [checking, setChecking] = useState(false);
  const [style, setStyle] = useState(s.explanationStyle);
  useEffect(() => setStyle(s.explanationStyle), [s.explanationStyle]);

  const providers = [...new Set(ai?.models.map((m) => m.provider) ?? [])];
  const themes: Array<[ThemeName, string]> = [
    ["light", "Paper"],
    ["sepia", "Sepia"],
    ["dark", "Night"],
    ["system", "Match system"],
  ];

  return (
    <div className="settings">
      <div className="settings-inner">
        <h1>Settings</h1>

        <section>
          <h2>Reading</h2>
          <Row title="Theme">
            <div className="segmented">
              {themes.map(([t, label]) => (
                <button key={t} className={s.theme === t ? "on" : ""} onClick={() => void set({ theme: t })}>
                  {label}
                </button>
              ))}
            </div>
          </Row>
          <Row title="Typeface" hint="Literata is drawn for long reading on screens.">
            <div className="segmented">
              <button className={s.readerFont === "serif" ? "on" : ""} onClick={() => void set({ readerFont: "serif" })}>
                Literata (serif)
              </button>
              <button className={s.readerFont === "sans" ? "on" : ""} onClick={() => void set({ readerFont: "sans" })}>
                Inter (sans)
              </button>
            </div>
          </Row>
          <Row title="Text size" hint={`${s.fontSize}px`}>
            <input type="range" min={14} max={28} step={1} value={s.fontSize} onChange={(e) => void set({ fontSize: Number(e.target.value) })} />
          </Row>
          <Row title="Line spacing" hint={s.lineHeight.toFixed(2)}>
            <input type="range" min={1.3} max={2.1} step={0.05} value={s.lineHeight} onChange={(e) => void set({ lineHeight: Number(e.target.value) })} />
          </Row>
          <Row title="Column width" hint={`${s.measure} characters`}>
            <input type="range" min={48} max={96} step={2} value={s.measure} onChange={(e) => void set({ measure: Number(e.target.value) })} />
          </Row>
        </section>

        <section>
          <h2>AI</h2>
          <div className={`ai-status ${ai?.available ? "ok" : "off"}`}>
            {ai?.available ? <CircleCheck size={18} /> : <CircleX size={18} />}
            <div style={{ flex: 1 }}>
              <strong>{ai === null ? "Checking…" : ai.available ? `Connected through yagami · ${providers.join(", ")}` : "No model available"}</strong>
              <p>
                {ai?.available
                  ? "apprentice drives the coding-agent CLIs already signed in on this computer. No API key; your own subscriptions."
                  : (ai?.reason ?? "Looking for signed-in CLIs (Claude Code, Codex, Gemini, OpenCode…).")}
              </p>
            </div>
            <button
              className="btn small"
              onClick={async () => {
                setChecking(true);
                await refreshAi(true);
                setChecking(false);
              }}
            >
              {checking ? <span className="spinner" /> : <RefreshCw size={13} />} Check again
            </button>
          </div>
          <Row title="Model for questions and rewrites">
            <select className="input" value={s.model ?? ""} onChange={(e) => void set({ model: e.target.value || null })} disabled={!ai?.available}>
              <option value="">yagami's default</option>
              {ai?.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.provider}
                </option>
              ))}
            </select>
          </Row>
          <Row title="Model for background work" hint="Cards and concept maps written when you finish a chapter. A faster model is fine here.">
            <select className="input" value={s.backgroundModel ?? ""} onChange={(e) => void set({ backgroundModel: e.target.value || null })} disabled={!ai?.available}>
              <option value="">Same as above</option>
              {ai?.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.provider}
                </option>
              ))}
            </select>
          </Row>
          <Row title="Write cards when I finish a chapter" hint="They join your reviews right away.">
            <Switch on={s.aiCards} onChange={(v) => void set({ aiCards: v })} label="Write cards when I finish a chapter" />
          </Row>
          <Row title="Map concepts when I finish a chapter" hint="Adds the chapter's ideas and how they depend on each other to the knowledge map.">
            <Switch on={s.aiConcepts} onChange={(v) => void set({ aiConcepts: v })} label="Map concepts when I finish a chapter" />
          </Row>
          <Row title="Offer to rewrite passages" hint="After an explanation, offer to rewrite the passage you asked about in its light.">
            <Switch on={s.offerRewrites} onChange={(v) => void set({ offerRewrites: v })} label="Offer to rewrite passages" />
          </Row>
          <div className="set-block">
            <div className="set-title">How I like things explained</div>
            <div className="set-hint">Given to every question and rewrite. For example: “Intuition first, then the formal version. I know calculus well; go slow on proofs.”</div>
            <textarea
              className="textarea"
              rows={3}
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              onBlur={() => style !== s.explanationStyle && void set({ explanationStyle: style })}
              placeholder="Anything about how you learn best…"
            />
          </div>
        </section>

        <section>
          <h2>Reviews</h2>
          <Row title="Target recall" hint={`Schedule each card to be reviewed when you'd remember it with ${Math.round(s.desiredRetention * 100)}% probability. Higher means more reviews.`}>
            <input
              type="range"
              min={0.75}
              max={0.97}
              step={0.01}
              value={s.desiredRetention}
              onChange={(e) => void set({ desiredRetention: Number(e.target.value) })}
            />
          </Row>
          <Row title="New cards per day" hint={`${s.newCardsPerDay}`}>
            <input type="range" min={5} max={150} step={5} value={s.newCardsPerDay} onChange={(e) => void set({ newCardsPerDay: Number(e.target.value) })} />
          </Row>
        </section>

        <section>
          <h2>Keys</h2>
          <div className="keys">
            {[
              [`${mod} K`, "Command palette — books, chapters, search"],
              ["/", "Search the open book"],
              ["[  ]", "Previous / next chapter"],
              [`${mod} \\`, "Contents"],
              [`${mod} J`, "Study panel"],
              ["H · N · A · C", "With text selected: highlight, note, ask, card"],
              ["Space · 1–4 · Z", "Reviews: show, rate, undo"],
              [`${mod} 1 · 2 · 3`, "Library · Review · Map"],
            ].map(([k, v]) => (
              <div key={k} className="key-row">
                <span className="kbd">{k}</span>
                <span>{v}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
