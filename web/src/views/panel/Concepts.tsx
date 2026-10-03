/**
 * The chapter's concepts and how well each is known — read about, being
 * learned, known, fading — with where else each appears.
 */
import { Brain, ChevronDown, Sparkles, Waypoints } from "lucide-react";
import { useEffect, useState } from "react";
import type { Concept, ConceptDetail, KnowledgeGraph } from "../../../../shared/types";
import { api, errorText, on } from "../../api";
import { percent } from "../../lib/format";
import { useApp } from "../../store";
import { useReader, useUnitId } from "../reader/state";

export const STATE_LABEL: Record<Concept["state"], string> = {
  unseen: "Not met yet",
  seen: "Read",
  learning: "Learning",
  known: "Known",
  fading: "Fading",
};

function Detail({ id }: { id: number }) {
  const [d, setD] = useState<ConceptDetail | null>(null);
  useEffect(() => {
    void api.knowledge.concept(id).then(setD);
  }, [id]);
  if (!d) return <div className="concept-detail muted">…</div>;
  return (
    <div className="concept-detail">
      {d.concept.definition && <p className="concept-def">{d.concept.definition}</p>}
      <div className="concept-stats muted">
        Read {percent(d.concept.exposure)} of its mentions
        {d.concept.recall !== null ? ` · recall ${percent(d.concept.recall)}` : d.cards.length ? " · cards not reviewed yet" : " · no cards yet"}
      </div>
      {d.neighbors.length > 0 && (
        <div className="concept-neighbors">
          {d.neighbors.slice(0, 8).map((n) => (
            <span key={n.concept.id} className={`chip cs-${n.concept.state}`} title={n.label ?? "related"}>
              <i className="state-dot" />
              {n.concept.name}
            </span>
          ))}
        </div>
      )}
      <div className="concept-mentions">
        {d.mentions.slice(0, 5).map((m) => (
          <button key={m.blockId} className="mention" onClick={() => void useReader.getState().goToBlock(m.blockId, [d.concept.name])}>
            <span className="mention-where">
              {m.isDefinition ? "Defined · " : ""}
              {m.unitTitle} · p. {m.page + 1}
            </span>
            <span className="mention-text">{m.snippet}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function Concepts() {
  const bookId = useReader((s) => s.bookId)!;
  const unitId = useUnitId();
  const ai = useApp((s) => s.ai);
  const go = useApp((s) => s.go);
  const toast = useApp((s) => s.toast);
  const jobs = useApp((s) => s.jobs);
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const load = () => {
    if (unitId) void api.knowledge.unit(unitId).then(setGraph);
  };
  useEffect(load, [unitId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => on("knowledge.changed", (e) => e.bookId === bookId && load()), [bookId, unitId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => on("cards.changed", () => load()), [unitId]); // eslint-disable-line react-hooks/exhaustive-deps

  const mapping = jobs.some((j) => j.state === "running" && j.bookId === bookId && j.label.startsWith("Mapping"));
  const nodes = [...(graph?.nodes ?? [])].sort((a, b) => b.importance - a.importance);
  const counts = nodes.reduce<Record<string, number>>((m, n) => ((m[n.state] = (m[n.state] ?? 0) + 1), m), {});

  return (
    <div className="concepts">
      <div className="concepts-head">
        <div className="label">In this chapter</div>
        <div className="concepts-summary">
          {(["known", "learning", "fading", "seen", "unseen"] as const).map((s) =>
            counts[s] ? (
              <span key={s} className={`chip cs-${s}`}>
                <i className="state-dot" />
                {counts[s]} {STATE_LABEL[s].toLowerCase()}
              </span>
            ) : null,
          )}
        </div>
        <div className="cards-actions">
          <button className="btn small" onClick={() => go({ name: "map", bookId })}>
            <Waypoints size={13} /> Open the map
          </button>
          {ai?.available && unitId && (
            <button
              className="btn small"
              disabled={mapping}
              onClick={async () => {
                try {
                  await api.ai.mapConcepts(bookId, unitId);
                  toast("Mapping this chapter's concepts in the background…");
                } catch (e) {
                  toast(errorText(e), "error");
                }
              }}
            >
              {mapping ? <span className="spinner" /> : <Sparkles size={13} />} {mapping ? "Mapping…" : "Map with AI"}
            </button>
          )}
        </div>
      </div>
      <div className="concept-list">
        {graph && !nodes.length && (
          <div className="empty">
            <Brain size={24} />
            <h3>No concepts found here</h3>
            <p>This chapter didn't name its key terms in a way apprentice could see. A model can map them for you.</p>
          </div>
        )}
        {nodes.map((n) => (
          <div key={n.id} className={`concept-row ${open === n.id ? "open" : ""}`}>
            <button className="concept-head" onClick={() => setOpen(open === n.id ? null : n.id)}>
              <i className={`state-dot cs-${n.state}`} title={STATE_LABEL[n.state]} />
              <span className="concept-name">{n.name}</span>
              <span className="mastery" title={`Mastery ${percent(n.mastery)}`}>
                <i style={{ transform: `scaleX(${n.mastery})` }} className={`cs-${n.state}`} />
              </span>
              <ChevronDown size={14} className="concept-caret" />
            </button>
            {open === n.id && <Detail id={n.id} />}
          </div>
        ))}
      </div>
    </div>
  );
}
