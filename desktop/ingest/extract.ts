/**
 * Page extraction: MuPDF's character stream → styled lines, images and
 * vector shapes, as plain data.
 *
 * Nothing here decides what anything *is* — heading, footnote, figure. That
 * needs the whole book in view (a body font is only "the body font" once
 * every page has voted), so it happens in analyze.ts. This file's job is to
 * read each page once, fast, and keep everything that decision will need:
 * per-character font, size and position folded into spans, superscripts
 * found by baseline, and the math alphabets folded back into letters.
 */
import * as mupdf from "mupdf";

export type Rect = [number, number, number, number];

/** Character style flags. The low six match MarkFlag in shared/types.ts. */
export const F = {
  BOLD: 1,
  ITALIC: 2,
  MONO: 4,
  SUP: 8,
  SUB: 16,
  MATH: 32,
} as const;

export interface XSpan {
  text: string;
  size: number;
  flags: number;
  font: number;
}

export interface XLine {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  baseline: number;
  /** Dominant font size: the size most of the line's characters are set in. */
  size: number;
  /** Dominant font, as an index into the document's font table. */
  font: number;
  spans: XSpan[];
  text: string;
  /** Index of the MuPDF block the line came in, unique within the page. */
  block: number;
  /** Order of the line in the page's content stream, across blocks. */
  order: number;
  /** Non-space character counts, overall and by style. */
  n: number;
  bold: number;
  italic: number;
  mono: number;
  math: number;
  /** Average advance of a character, for turning x positions into columns. */
  charWidth: number;
  /** How many cells the line spans: pieces of one row with real gaps between them. */
  cells: number;
}

export interface XImage {
  bbox: Rect;
  /** Native pixel size. */
  w: number;
  h: number;
  order: number;
}

export interface XVector {
  bbox: Rect;
  stroked: boolean;
  rect: boolean;
}

export interface XPage {
  index: number;
  label: string;
  width: number;
  height: number;
  lines: XLine[];
  images: XImage[];
  vectors: XVector[];
}

export interface FontInfo {
  name: string;
  flags: number;
}

const BOLD_NAME = /bold|black|heavy|semibold|demibold|[-_]demi|cmbx|cmb\d|bx\d|[-_]bd\b|medium(?!italic)/i;
const ITALIC_NAME = /italic|oblique|cmti|cmsl|cmmi|slanted|[-_]it\b|ital\b|kursiv/i;
const MONO_NAME =
  /mono|courier|consol|inconsolata|cmtt|sftt|typewriter|menlo|lettergothic|ocr[ab]|lucidaconsole|tt\d{2,}|sourcecode|firacode|jetbrains|codenew|hack\b|txtt|pcrr|beramono|lmmono|nimbusmono|cousine/i;
const MATH_NAME =
  /cmmi|cmsy|cmex|cmbsy|msam|msbm|rtxmi|rtxsy|rtxex|txsy|txex|txmi|pxsy|pxex|pxmi|math|^symbol|stix|euler|eufm|eusm|eurm|eusb|wasy|lasy|stmary|zeur|rsfs|esint|cambriamath|xits|asana|mnsymbol|fourier.*(?:mi|sy)|lmmath|ntxmi|ntxsy|newtxmath|mtpro|mt2/i;

/** Not a style: marks a font whose Hangul is really Hangul. Kept out of the low bits. */
const KOREAN = 1 << 10;
const KOREAN_NAME = /batang|gulim|dotum|gungsuh|malgun|nanum|myeongjo|gothic.*(kr|korea)|kr\b|hangul|cjk|unbatang|baekmuk|sandoll|yoon|spoqa/i;

function stripSubset(name: string): string {
  // "HWQHFW+LinLibertineO" → "LinLibertineO"
  return name.replace(/^[A-Z]{6}\+/, "");
}

/**
 * The styled Unicode math alphabets (𝐀, 𝑉, 𝒙 …) back into plain letters,
 * with the style moved to flags, so "𝑉 denotes a vector space" reads, copies
 * and searches as "V denotes a vector space" with V in italics. Script,
 * fraktur and double-struck letters mean something different from their
 * plain forms (𝔽 is not F), so those are left alone.
 */
function mathLetter(cp: number): { ch: string; flags: number } | null {
  if (cp === 0x210e) return { ch: "h", flags: F.ITALIC | F.MATH };
  if (cp < 0x1d400 || cp > 0x1d7ff) return null;
  let flags: number | null = null;
  if (cp < 0x1d6a4) {
    const style = Math.floor((cp - 0x1d400) / 52);
    flags = (
      [F.BOLD, F.ITALIC, F.BOLD | F.ITALIC, null, null, null, null, null, 0, F.BOLD, F.ITALIC, F.BOLD | F.ITALIC, F.MONO] as const
    )[style] ?? null;
  } else if (cp >= 0x1d6a8 && cp < 0x1d7ca) {
    const style = Math.floor((cp - 0x1d6a8) / 58);
    flags = ([F.BOLD, F.ITALIC, F.BOLD | F.ITALIC, F.BOLD, F.BOLD | F.ITALIC] as const)[style] ?? null;
  } else if (cp >= 0x1d7ce) {
    const style = Math.floor((cp - 0x1d7ce) / 10);
    flags = ([F.BOLD, null, 0, F.BOLD, F.MONO] as const)[style] ?? null;
  }
  if (flags === null) return null;
  return { ch: String.fromCodePoint(cp).normalize("NFKC"), flags: flags | F.MATH };
}

/**
 * Linux Libertine and Biolinum — the faces of a great many LaTeX books —
 * put their small capitals, old-style figures and some ligatures in the
 * Private Use Area, and PDFs pass those code points through as text. Read
 * raw they are empty boxes ("this □□□□ book", "□e idea"); here they become
 * the letters they draw. Small capitals come back as capitals. Private
 * glyphs in any other face are dropped: an unknown glyph is still unknown,
 * and a box helps nobody.
 */
const LIBERTINE_LIGATURES: Record<number, string> = {
  0xe039: "ft",
  0xe03a: "ck",
  0xe03b: "ch",
  0xe03c: "tt",
  0xe048: "Qu",
  0xe049: "Th",
  0xe050: "&",
  0xe06d: "-",
  0xe0e0: "f",
};

function privateUse(cp: number, font: string): string | null {
  if (cp < 0xe000 || cp > 0xf8ff) return null;
  if (!/libertine|biolinum|libertinus/i.test(font)) return "";
  const lig = LIBERTINE_LIGATURES[cp];
  if (lig) return lig;
  if (cp >= 0xe051 && cp <= 0xe06a) return String.fromCharCode(65 + cp - 0xe051);
  if (cp >= 0xe118 && cp <= 0xe121) return String.fromCharCode(48 + cp - 0xe118);
  // Brace and bracket pieces, swash variants: nothing to read.
  return "";
}

/** Code points that only turn up in mathematics. */
function isMathSymbol(cp: number): boolean {
  return (
    (cp >= 0x2200 && cp <= 0x22ff) || // operators
    (cp >= 0x2190 && cp <= 0x21ff) || // arrows
    (cp >= 0x27c0 && cp <= 0x27ef) ||
    (cp >= 0x2980 && cp <= 0x2aff) ||
    (cp >= 0x1d400 && cp <= 0x1d7ff) ||
    (cp >= 0x2032 && cp <= 0x2037) || // primes
    cp === 0x00b1 ||
    cp === 0x00d7 ||
    cp === 0x00f7
  );
}

interface RawChar {
  c: string;
  font: number;
  size: number;
  flags: number;
  ox: number;
  oy: number;
  x0: number;
  x1: number;
}

export class Extractor {
  readonly fonts: FontInfo[] = [];
  private fontIndex = new Map<number, number>();

  constructor(readonly doc: mupdf.Document) {}

  private font(font: mupdf.Font): number {
    const key = font.pointer as unknown as number;
    const known = this.fontIndex.get(key);
    if (known !== undefined) return known;
    const name = stripSubset(font.getName());
    let flags = 0;
    if (font.isBold() || BOLD_NAME.test(name)) flags |= F.BOLD;
    if (font.isItalic() || ITALIC_NAME.test(name)) flags |= F.ITALIC;
    if (font.isMono() || MONO_NAME.test(name)) flags |= F.MONO;
    if (MATH_NAME.test(name)) flags |= F.MATH;
    if (KOREAN_NAME.test(name)) flags |= KOREAN;
    // A math font's letters are italic by convention, but its operators are
    // not; that is decided per character below, so keep only the math bit.
    if (flags & F.MATH) flags &= ~F.ITALIC;
    const index = this.fonts.length;
    this.fonts.push({ name, flags });
    this.fontIndex.set(key, index);
    return index;
  }

  page(index: number): XPage {
    const page = this.doc.loadPage(index);
    const [bx0, by0, bx1, by1] = page.getBounds();
    const lines: XLine[] = [];
    const images: XImage[] = [];
    const vectors: XVector[] = [];
    let block = -1;
    let order = 0;
    let chars: RawChar[] = [];
    let lineBox: Rect = [0, 0, 0, 0];

    const stext = page.toStructuredText("preserve-images,vectors");
    stext.walk({
      onImageBlock: (bbox, _matrix, image) => {
        images.push({ bbox: [...bbox] as Rect, w: image.getWidth(), h: image.getHeight(), order: order++ });
      },
      onVector: (bbox, flags) => {
        const f = flags as { isStroked?: boolean; isRectangle?: boolean };
        vectors.push({ bbox: [...bbox] as Rect, stroked: !!f.isStroked, rect: !!f.isRectangle });
      },
      beginTextBlock: () => {
        block++;
      },
      beginLine: (bbox) => {
        chars = [];
        lineBox = [...bbox] as Rect;
      },
      onChar: (c, origin, font, size, quad) => {
        const fi = this.font(font);
        let flags = this.fonts[fi]!.flags;
        let ch = c;
        let cp = c.codePointAt(0) ?? 0;
        // MuPDF.js hands characters over as UTF-16 code units cut to 16
        // bits, so the math alphabets (U+1D400…) arrive as Hangul (U+D400…).
        // Outside a Korean font, that is what they are.
        if (cp >= 0xd400 && cp <= 0xd7ff && !(this.fonts[fi]!.flags & KOREAN)) {
          cp += 0x10000;
          ch = String.fromCodePoint(cp);
        }
        const folded = mathLetter(cp);
        if (folded) {
          ch = folded.ch;
          flags = (flags & ~(F.BOLD | F.ITALIC | F.MONO)) | folded.flags;
        } else if (flags & F.MATH) {
          // In a math font, Latin letters are variables and set in italic.
          if (/[A-Za-z]/.test(ch)) flags |= F.ITALIC;
        } else if (isMathSymbol(cp)) {
          flags |= F.MATH;
        }
        if (ch === "\u00a0") ch = " ";
        if (ch === "\u00ad") return; // soft hyphen: a break opportunity, not a character
        const x0 = Math.min(quad[0], quad[4]);
        const x1 = Math.max(quad[2], quad[6]);
        const pua = privateUse(cp, this.fonts[fi]!.name);
        if (pua !== null) {
          // One glyph, several letters: share its width out between them.
          const w = (x1 - x0) / Math.max(1, pua.length);
          [...pua].forEach((c, i) =>
            chars.push({ c, font: fi, size, flags: flags & 63, ox: origin[0] + w * i, oy: origin[1], x0: x0 + w * i, x1: x0 + w * (i + 1) }),
          );
          return;
        }
        chars.push({ c: ch, font: fi, size, flags: flags & 63, ox: origin[0], oy: origin[1], x0, x1 });
      },
      endLine: () => {
        const line = this.finishLine(chars, lineBox, block, order++);
        if (line) lines.push(line);
      },
    });
    stext.destroy();
    let label = "";
    try {
      label = page.getLabel();
    } catch {
      // unlabeled pages fall back to their number
    }
    page.destroy();
    return {
      index,
      label: label || String(index + 1),
      width: bx1 - bx0,
      height: by1 - by0,
      lines,
      images,
      vectors,
    };
  }

  private finishLine(chars: RawChar[], box: Rect, block: number, order: number): XLine | null {
    // Trim, but keep interior spaces: they are how MuPDF marks word gaps.
    let a = 0;
    let b = chars.length;
    while (a < b && chars[a]!.c.trim() === "") a++;
    while (b > a && chars[b - 1]!.c.trim() === "") b--;
    if (a === b) return null;
    const cs = chars.slice(a, b);

    // Dominant size by character count, then the baseline of the characters
    // set at it. Anything smaller and raised off that baseline is a
    // superscript — a footnote mark, an exponent — and lowered, a subscript.
    const bySize = new Map<number, number>();
    for (const ch of cs) {
      if (ch.c === " ") continue;
      const k = Math.round(ch.size * 4) / 4;
      bySize.set(k, (bySize.get(k) ?? 0) + 1);
    }
    let size = 0;
    let best = -1;
    for (const [k, count] of bySize) {
      if (count > best || (count === best && k > size)) {
        best = count;
        size = k;
      }
    }
    const ys: number[] = [];
    for (const ch of cs) if (ch.c !== " " && Math.abs(ch.size - size) < 0.6) ys.push(ch.oy);
    ys.sort((p, q) => p - q);
    const baseline = ys.length ? ys[Math.floor(ys.length / 2)]! : box[3];

    const fontCount = new Map<number, number>();
    let n = 0;
    let bold = 0;
    let italic = 0;
    let mono = 0;
    let math = 0;
    let widthSum = 0;
    for (const ch of cs) {
      if (ch.size < size * 0.86) {
        if (ch.oy < baseline - size * 0.18) ch.flags |= F.SUP;
        else if (ch.oy > baseline + size * 0.08) ch.flags |= F.SUB;
      }
      if (ch.c === " ") continue;
      n++;
      widthSum += ch.x1 - ch.x0;
      if (ch.flags & F.BOLD) bold++;
      if (ch.flags & F.ITALIC) italic++;
      if (ch.flags & F.MONO) mono++;
      if (ch.flags & F.MATH) math++;
      fontCount.set(ch.font, (fontCount.get(ch.font) ?? 0) + 1);
    }
    let font = 0;
    best = -1;
    for (const [k, count] of fontCount) {
      if (count > best) {
        best = count;
        font = k;
      }
    }

    // Fold characters into spans of one style. A space takes the style of
    // what came before it so that it does not split a bold phrase in two.
    // MuPDF infers word spaces from glyph advances, which some math fonts
    // report wrongly — "Tis called" for "T is called". A gap wider than a
    // fifth of an em between two glyphs is a space, whatever MuPDF thought.
    for (let i = 1; i < cs.length; i++) {
      const a = cs[i - 1]!;
      const b = cs[i]!;
      if (a.c === " " || b.c === " ") continue;
      const gap = b.x0 - a.x1;
      const em = Math.max(a.size, b.size);
      if (gap > em * 0.2 && gap < em * 6 && !(b.flags & (F.SUP | F.SUB)) && !(a.flags & (F.SUP | F.SUB))) {
        cs.splice(i, 0, { ...a, c: " ", x0: a.x1, x1: b.x0 });
        i++;
      }
    }

    const spans: XSpan[] = [];
    let text = "";
    for (const ch of cs) {
      const last = spans[spans.length - 1];
      const flags = ch.c === " " && last ? last.flags : ch.flags;
      if (last && last.flags === flags && (ch.c === " " || (last.font === ch.font && Math.abs(last.size - ch.size) < 0.3))) {
        last.text += ch.c;
      } else {
        spans.push({ text: ch.c, size: ch.size, flags, font: ch.font });
      }
      text += ch.c;
    }

    return {
      x0: Math.min(...cs.map((c) => c.x0)),
      y0: box[1],
      x1: Math.max(...cs.map((c) => c.x1)),
      y1: box[3],
      baseline,
      size,
      font,
      spans,
      text,
      block,
      order,
      n,
      bold,
      italic,
      mono,
      math,
      charWidth: n ? widthSum / n : size * 0.5,
      cells: 1,
    };
  }
}
