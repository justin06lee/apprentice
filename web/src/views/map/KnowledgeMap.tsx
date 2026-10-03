/**
 * The knowledge map: every concept the books teach, linked to what it
 * relates to, colored by how well it is known. Beside it, what to study
 * next — the central concepts that are least known — and the detail of
 * whichever concept is picked.
 */
import { ArrowRight, BookOpen, Maximize2, Search, Waypoints, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Concept, ConceptDetail, ConceptState, KnowledgeGraph } from "../../../../shared/types";
import { api, on } from "../../api";
import { percent, plural } from "../../lib/format";
import { useApp } from "../../store";
import { STATE_LABEL } from "../panel/Concepts";
import { GraphCanvas, type GraphCanvasHandle } from "./GraphCanvas";
import "../../styles/map.css";

const STATES: ConceptState[] = ["known", "learning", "fading", "seen", "unseen"];

function Detail({ id, onSelect, onClose }: { id: number; onSelect(id: number): void; onClose(): void }) {
  const go = useApp((s) => s.go);
  const [d, setD] = useState<ConceptDetail | null>(null);
  useEffect(() => {
    setD(null);
    void api.knowledge.concept(id).then(setD);
  }, [id]);
  if (!d) return <div className="map-detail" />;
  const c = d.concept;
  return (
    <div className="map-detail">
      <div className="map-detail-head">
        <span className={`chip cs-${c.state}`}>
          <i className="state-dot" />
          {STATE_LABEL[c.state]}
        </span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn small" onClick={onClose} aria-label="Close">
          <X size={15} />
        </button>
      </div>
      <h2>{c.name}</h2>
      {c.definition && <p className="map-def">{c.definition}</p>}
      <div className="map-meters">
        <div>
          <span className="label">Read</span>
          <div className="meter">
            <i style={{ transform: `scaleX(${c.exposure})` }} />
          </div>
          <span className="muted">{percent(c.exposure)} of mentions</span>
        </div>
        <div>
          <span className="label">Recall</span>
          <div className="meter">
            <i style={{ transform: `scaleX(${c.recall ?? 0})` }} />
          </div>
          <span className="muted">{c.recall === null ? (d.cards.length ? "not reviewed yet" : "no cards") : percent(c.recall)}</span>
        </div>
      </div>
      {d.neighbors.length > 0 && (
        <section>
          <div className="label">Related</div>
          <div className="map-neighbors">
            {d.neighbors.map((n) => (
              <button key={n.concept.id} className={`chip-btn cs-${n.concept.state}`} onClick={() => onSelect(n.concept.id)} title={n.label ?? "appears alongside"}>
                <i className="state-dot" /> {n.concept.name}
                {n.label && <span className="muted"> · {n.label}</span>}
              </button>
            ))}
          </div>
        </section>
      )}
      <section>
        <div className="label">Where it appears · {plural(d.mentions.length, "passage")}</div>
        <div className="map-mentions">
          {d.mentions.slice(0, 12).map((m) => (
            <button key={m.blockId} className="mention" onClick={() => go({ name: "reader", bookId: m.bookId, blockId: m.blockId, terms: [d.concept.name] })}>
              <span className="mention-where">
                {m.isDefinition ? "Defined · " : ""}
                {m.bookTitle} · {m.unitTitle}
                {m.read ? "" : " · unread"}
              </span>
              <span className="mention-text">{m.snippet}</span>
            </button>
          ))}
        </div>
      </section>
      {d.cards.length > 0 && (
        <section>
          <div className="label">{plural(d.cards.length, "card")}</div>
          <div className="map-cards">
            {d.cards.slice(0, 6).map((card) => (
              <div key={card.id} className="map-card">
                {card.front.replace(/\{\{c\d+::(.*?)(::.*?)?\}\}/g, "[$1]").slice(0, 160)}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function KnowledgeMap({ bookId, conceptId }: { bookId: string | null; conceptId: number | null }) {
  const books = useApp((s) => s.books);
  const go = useApp((s) => s.go);
  const [scope, setScope] = useState<string | null>(bookId);
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [selected, setSelected] = useState<number | null>(conceptId);
  const [q, setQ] = useState("");
  const [states, setStates] = useState<Set<ConceptState>>(new Set(STATES));
  const canvas = useRef<GraphCanvasHandle>(null);

  useEffect(() => {
    let live = true;
    const load = () => void api.knowledge.graph(scope).then((g) => live && setGraph(g));
    load();
    const offs = [on("knowledge.changed", load), on("cards.changed", load)];
    return () => {
      live = false;
      offs.forEach((o) => o());
    };
  }, [scope]);

  const shown = useMemo<KnowledgeGraph | null>(() => {
    if (!graph) return null;
    if (states.size === STATES.length) return graph;
    const nodes = graph.nodes.filter((n) => states.has(n.state));
    const ids = new Set(nodes.map((n) => n.id));
    return { nodes, edges: graph.edges.filter((e) => ids.has(e.a) && ids.has(e.b)) };
  }, [graph, states]);

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle || !shown) return null;
    return new Set(shown.nodes.filter((n) => n.name.toLowerCase().includes(needle)).map((n) => n.id));
  }, [q, shown]);

  const counts = useMemo(() => {
    const m: Record<ConceptState, number> = { known: 0, learning: 0, fading: 0, seen: 0, unseen: 0 };
    for (const n of graph?.nodes ?? []) m[n.state]++;
    return m;
  }, [graph]);

  // What to study next: central concepts that are least secure. Things
  // already read but slipping come first; then ones not met yet.
  const next = useMemo(() => {
    const rank = (n: Concept) => n.importance * (1 - n.mastery) * (n.state === "fading" ? 1.6 : n.state === "seen" ? 1.3 : n.state === "learning" ? 1.1 : 1);
    return [...(graph?.nodes ?? [])]
      .filter((n) => n.state !== "known")
      .sort((a, b) => rank(b) - rank(a))
      .slice(0, 8);
  }, [graph]);

  const select = (id: number | null) => {
    setSelected(id);
    if (id !== null) canvas.current?.focus(id);
  };

  const total = graph?.nodes.length ?? 0;
  const ready = books.filter((b) => b.status === "ready");

  return (
    <div className="map">
      <div className="map-canvas">
        {shown && shown.nodes.length > 0 && <GraphCanvas ref={canvas} graph={shown} selectedId={selected} onSelect={setSelected} highlight={matches} />}
        {graph && total === 0 && (
          <div className="empty map-empty">
            <Waypoints size={30} />
            <h3>The map fills in as you add books</h3>
            <p>Concepts come from what each book defines and names. As you read and review, each one is colored by how well you know it.</p>
            <button className="btn" onClick={() => go({ name: "library" })}>
              <BookOpen size={15} /> Go to the library
            </button>
          </div>
        )}
      </div>

      <div className="map-top">
        <div className="map-title">
          <h1>Knowledge map</h1>
          <span className="muted">{plural(total, "concept")}</span>
        </div>
        <select className="input map-scope" value={scope ?? ""} onChange={(e) => (setScope(e.target.value || null), setSelected(null))}>
          <option value="">All books</option>
          {ready.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
            </option>
          ))}
        </select>
        <div className="map-search">
          <Search size={14} />
          <input
            placeholder="Find a concept"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches?.size) select([...matches][0]!);
            }}
          />
        </div>
        <button className="icon-btn" onClick={() => canvas.current?.fit()} title="Fit to view" aria-label="Fit to view">
          <Maximize2 size={16} />
        </button>
      </div>

      <aside className="map-side">
        {selected !== null ? (
          <Detail id={selected} onSelect={select} onClose={() => setSelected(null)} />
        ) : (
          <div className="map-summary">
            <div className="map-tiles">
              {STATES.map((s) => (
                <button
                  key={s}
                  className={`map-tile cs-${s} ${states.has(s) ? "" : "off"}`}
                  onClick={() =>
                    setStates((cur) => {
                      const n = new Set(cur);
                      if (n.has(s) && n.size > 1) n.delete(s);
                      else n.add(s);
                      return n;
                    })
                  }
                  title={states.has(s) ? "Hide these on the map" : "Show these on the map"}
                >
                  <span className="map-tile-n">{counts[s]}</span>
                  <span className="map-tile-label">
                    <i className="state-dot" /> {STATE_LABEL[s]}
                  </span>
                </button>
              ))}
            </div>
            {next.length > 0 && (
              <section>
                <div className="label">Study next</div>
                <p className="muted map-next-note">Central to what you're reading, and not yet secure.</p>
                <div className="map-next">
                  {next.map((n) => (
                    <button key={n.id} className="map-next-row" onClick={() => select(n.id)}>
                      <i className={`state-dot cs-${n.state}`} />
                      <span className="map-next-name">{n.name}</span>
                      <span className="muted">{STATE_LABEL[n.state].toLowerCase()}</span>
                      <ArrowRight size={13} />
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
