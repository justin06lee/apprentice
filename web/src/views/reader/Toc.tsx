/**
 * The contents: chapters (units) with how much of each is read, and the
 * sections inside the open one. Contents pages, indexes and bibliographies
 * stay in the list but recede — they are part of the book, not the reading.
 *
 * The section on screen changes many times a second while scrolling, so
 * each row subscribes to whether *it* is the one; a change re-renders two
 * rows, not the tree.
 */
import { ChevronRight } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Section } from "../../../../shared/types";
import { Ring } from "../../components/ui";
import { useReader } from "./state";

const QUIET = new Set(["contents", "index", "bibliography", "front"]);

const SectionRow = memo(function SectionRow({ section, unitId, indent }: { section: Section; unitId: number; indent: number }) {
  const active = useReader((s) => s.activeSection === section.id);
  return (
    <div
      className={`toc-sec ${active ? "active" : ""}`}
      style={{ paddingLeft: indent }}
      onClick={() => section.blockId && void useReader.getState().loadUnit(unitId, { blockId: section.blockId, flash: false })}
      title={section.title}
    >
      {section.title}
    </div>
  );
});

const UnitRow = memo(function UnitRow({
  unit,
  subs,
  current,
  expanded,
  indent,
  onToggle,
}: {
  unit: Section;
  subs: Section[];
  current: boolean;
  expanded: boolean;
  indent: number;
  onToggle(id: number): void;
}) {
  const quiet = QUIET.has(unit.kind);
  return (
    <div className={`toc-group ${quiet ? "quiet" : ""}`}>
      <div
        className={`toc-unit ${current ? "current" : ""}`}
        style={{ paddingLeft: indent }}
        onClick={() => void useReader.getState().loadUnit(unit.id)}
        title={unit.title}
      >
        {subs.length > 0 ? (
          <button
            className={`toc-twist ${expanded ? "open" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(unit.id);
            }}
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            <ChevronRight size={13} />
          </button>
        ) : (
          <span className="toc-twist" />
        )}
        <span className="toc-title">{unit.title}</span>
        {!quiet && <Ring value={unit.readFraction} size={15} stroke={2.2} />}
      </div>
      {expanded && (
        <div className="toc-subs">
          {subs.map((s) => (
            <SectionRow key={s.id} section={s} unitId={unit.id} indent={36 + Math.max(0, s.level - unit.level - 1) * 12} />
          ))}
        </div>
      )}
    </div>
  );
});

export const Toc = memo(function Toc() {
  const sections = useReader((s) => s.sections);
  const unitId = useReader((s) => s.unitId);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);

  const units = useMemo(() => sections.filter((s) => s.isUnit), [sections]);
  const inside = useMemo(() => {
    const m = new Map<number, Section[]>();
    for (const s of sections) {
      if (s.isUnit) continue;
      const l = m.get(s.unitId);
      if (l) l.push(s);
      else m.set(s.unitId, [s]);
    }
    return m;
  }, [sections]);
  // Parts above their chapters: a unit's depth in the outline, for indent.
  const minLevel = useMemo(() => Math.min(...units.map((u) => u.level)), [units]);
  const none = useMemo<Section[]>(() => [], []);

  useEffect(() => {
    if (unitId) setOpen((o) => (o.has(unitId) ? o : new Set(o).add(unitId)));
    requestAnimationFrame(() => listRef.current?.querySelector(".toc-unit.current")?.scrollIntoView({ block: "nearest" }));
  }, [unitId]);

  const toggle = useMemo(
    () => (id: number) =>
      setOpen((o) => {
        const n = new Set(o);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    [],
  );

  return (
    <div className="toc" ref={listRef}>
      <div className="toc-head label">Contents</div>
      {units.map((u) => {
        const subs = inside.get(u.id) ?? none;
        return (
          <UnitRow
            key={u.id}
            unit={u}
            subs={subs}
            current={u.id === unitId}
            expanded={open.has(u.id) && subs.length > 0}
            indent={10 + (u.level - minLevel) * 12}
            onToggle={toggle}
          />
        );
      })}
    </div>
  );
});
