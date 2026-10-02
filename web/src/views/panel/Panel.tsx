/** The study panel beside the text, one tab per tool. */
import { Brain, Layers, MessageCircle, PenLine, StickyNote, X } from "lucide-react";
import { lazy, Suspense } from "react";
import { useReader, type PanelTab } from "../reader/state";
import { Ask } from "./Ask";
import { Cards } from "./Cards";
import { Concepts } from "./Concepts";
import { Notes } from "./Notes";

const SketchTab = lazy(() => import("./SketchTab").then((m) => ({ default: m.SketchTab })));

const TABS: Array<[PanelTab, string, React.ReactNode]> = [
  ["ask", "Ask", <MessageCircle size={14} key="a" />],
  ["notes", "Notes", <StickyNote size={14} key="n" />],
  ["cards", "Cards", <Layers size={14} key="c" />],
  ["concepts", "Concepts", <Brain size={14} key="k" />],
  ["sketch", "Sketch", <PenLine size={14} key="s" />],
];

export function Panel() {
  const panel = useReader((s) => s.panel);
  const setPanel = useReader((s) => s.setPanel);
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="tabs panel-tabs">
          {TABS.map(([id, label, icon]) => (
            <button key={id} className={`tab ${panel === id ? "on" : ""}`} onClick={() => setPanel(id)} title={label}>
              {icon}
              <span className="tab-label">{label}</span>
            </button>
          ))}
        </div>
        <button className="icon-btn small" onClick={() => setPanel(null)} aria-label="Close panel">
          <X size={15} />
        </button>
      </div>
      <div className="panel-body">
        {panel === "ask" && <Ask />}
        {panel === "notes" && <Notes />}
        {panel === "cards" && <Cards />}
        {panel === "concepts" && <Concepts />}
        {panel === "sketch" && (
          <Suspense fallback={null}>
            <SketchTab />
          </Suspense>
        )}
      </div>
    </div>
  );
}
