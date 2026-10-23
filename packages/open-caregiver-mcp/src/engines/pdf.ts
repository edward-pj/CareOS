import type { PdfBlock } from "./careSummary.js";

// A small, dependency-free PDF writer: Letter pages, Helvetica-Bold headings and Courier body text. Courier is monospaced,
// so wrapping is exact (no font metrics to get wrong). Enough for a one- or two-page clinical summary; not a layout engine.

const PAGE = { w: 612, h: 792, margin: 54 };
const BODY = { size: 10, lead: 14, charW: 6 }; // Courier is 0.6 em wide
const MAX_COLS = Math.floor((PAGE.w - PAGE.margin * 2) / BODY.charW);

/** Winansi can show these; map the few typographic characters we produce, and replace anything else. */
function latin1(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/·/g, "-")
    .replace(/[^\x20-\x7E°]/g, "?");
}
const esc = (s: string) => latin1(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

function wrap(text: string, cols: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    let line = "";
    const indent = /^\s*/.exec(raw)![0];
    for (const word of raw.trim().split(/\s+/)) {
      if (word === "") continue;
      const next = line ? `${line} ${word}` : indent + word;
      if (next.length > cols && line) { out.push(line); line = indent + word; } else line = next;
      while (line.length > cols) { out.push(line.slice(0, cols)); line = indent + line.slice(cols); }
    }
    out.push(line);
  }
  return out;
}

export function buildPdf(blocks: PdfBlock[]): Uint8Array {
  type Op = { font: "F1" | "F2"; size: number; text: string; gapAfter: number };
  const ops: Op[] = [];
  for (const b of blocks) {
    if (b.type === "gap") ops.push({ font: "F2", size: 6, text: "", gapAfter: 0 });
    else if (b.type === "title") ops.push({ font: "F1", size: 18, text: b.text, gapAfter: 8 });
    else if (b.type === "heading") ops.push({ font: "F1", size: 12, text: b.text, gapAfter: 4 });
    else for (const l of wrap(b.text, b.type === "mono" ? MAX_COLS : MAX_COLS)) ops.push({ font: "F2", size: BODY.size, text: l, gapAfter: 0 });
  }

  const pages: string[] = [];
  let y = PAGE.h - PAGE.margin;
  let cur: string[] = [];
  const flush = () => { pages.push(cur.join("\n")); cur = []; y = PAGE.h - PAGE.margin; };
  for (const op of ops) {
    const lead = op.font === "F1" ? op.size + 6 : op.text === "" ? op.size : BODY.lead;
    if (y - lead < PAGE.margin) flush();
    y -= lead;
    if (op.text) cur.push(`BT /${op.font} ${op.size} Tf ${PAGE.margin} ${y} Td (${esc(op.text)}) Tj ET`);
    y -= op.gapAfter;
  }
  flush();

  // Objects: 1 catalog, 2 pages, 3 Helvetica-Bold, 4 Courier, then (page, content) pairs.
  const objs: string[] = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objs[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`;
  objs[4] = `<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>`;
  pages.forEach((content, i) => {
    const id = 5 + i * 2;
    objs[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${id + 1} 0 R >>`;
    objs[id + 1] = `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
  });

  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets: number[] = [];
  let pos = parts[0]!.length;
  for (let id = 1; id < objs.length; id++) {
    offsets[id] = pos;
    const buf = Buffer.from(`${id} 0 obj\n${objs[id]}\nendobj\n`, "latin1");
    parts.push(buf);
    pos += buf.length;
  }
  const xref = [`xref\n0 ${objs.length}\n0000000000 65535 f \n`, ...offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`, "latin1"));
  return new Uint8Array(Buffer.concat(parts));
}
