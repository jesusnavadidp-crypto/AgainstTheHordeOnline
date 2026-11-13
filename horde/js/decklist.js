// Plain-text deck list parser (browser + Node, no dependencies).
// parseDecklist(text) -> { cards: [{ count, name, set?, collector?, section }], warnings: [] }
// section: 'commander' | 'main' | 'side' | 'maybe'
// Handles MTG Arena, MTGO, Moxfield/Archidekt text exports, "SIDEBOARD:" style headers,
// "// Commander" headers, "SB: 2 Name" lines, DFC names ("A // B"), and lines without a count.

const HEADERS = {
  commander: 'commander', commanders: 'commander',
  deck: 'main', main: 'main', mainboard: 'main', 'main deck': 'main', maindeck: 'main',
  sideboard: 'side', side: 'side', companion: 'side',
  maybeboard: 'maybe', maybe: 'maybe', considering: 'maybe',
};

function headerOf(line) {
  let s = line.trim().replace(/^(\/\/|#)+\s*/, '').replace(/[:\s]+$/, '');
  s = s.replace(/\s*[\(\[]\s*\d+\s*[\)\]]$/, '').replace(/^\*+|\*+$/g, '').trim(); // "Mainboard (60)"
  return HEADERS[s.toLowerCase()] ?? null;
}

const MAX_LINE = 200;

export function parseDecklist(text) {
  const warnings = [];
  const entries = []; // { count, name, set, collector, section, block, explicit }
  let section = 'main', explicit = false, block = 0, sawBlank = false;

  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    let line = raw.trim();
    if (!line) { sawBlank = true; return; }
    const hdr = headerOf(line);
    if (hdr && !/^\d/.test(line)) { section = hdr; explicit = true; sawBlank = false; return; }
    if (line.startsWith('#') || line.startsWith('//')) return; // comment
    if (sawBlank) { block++; sawBlank = false; }

    let sec = section;
    const sb = line.match(/^SB:\s*(.*)$/i);
    if (sb) { sec = 'side'; line = sb[1]; explicit = true; }

    const m = line.match(/^(\d{1,3})\s*[x×]?\s+(.+)$/i) || line.match(/^(\d{1,3})[x×]\s*(.+)$/i);
    let count = 1, rest = line;
    if (m) { count = parseInt(m[1], 10); rest = m[2]; }

    // Strip decoration: foil markers, ^tags^, [Category], trailing (SET) collector.
    rest = rest.replace(/\s*\*[FfEe]\*\s*/g, ' ').replace(/\s*\^[^^]*\^/g, '').trim();
    let set, collector;
    const sc = rest.match(/^(.*?)\s+[\(\[]([A-Za-z0-9]{2,6})[\)\]](?:\s+([A-Za-z0-9★†\-]+))?(?:\s+\*?[FfEe]\*?)?(?:\s+\[[^\]]*\])*$/);
    if (sc && sc[1]) { rest = sc[1]; set = sc[2].toLowerCase(); collector = sc[3]; }
    rest = rest.replace(/\s*\[[^\]]*\]\s*$/, '').replace(/\s+/g, ' ').trim();

    if (!rest || rest.length > MAX_LINE || !/[A-Za-z]/.test(rest) || /^[{}<>=|]/.test(rest) || /^\d+$/.test(rest) ||
        (!m && /^(about|name|total|cards?)\b.*[:=]/i.test(rest)) || (!m && rest.split(' ').length > 12 && !rest.includes('//'))) {
      warnings.push(`Ignored line ${i + 1}: "${raw.trim().slice(0, 60)}"`);
      return;
    }
    if (count < 1) { warnings.push(`Ignored line ${i + 1}: zero count`); return; }
    entries.push({ count, name: rest, set, collector, section: sec, block, explicit: sec !== 'main' });
  });

  // MTGO style: with no explicit headers, a trailing block (after a blank line) of <= 15 cards is the sideboard.
  if (!explicit && block >= 1) {
    const last = entries.filter(e => e.block === block);
    const n = last.reduce((a, e) => a + e.count, 0);
    if (last.length && n <= 15 && last.length < entries.length) for (const e of last) e.section = 'side';
  }

  const cards = [], index = new Map();
  for (const e of entries) {
    const key = e.section + '\0' + e.name.toLowerCase();
    const hit = index.get(key);
    if (hit) { hit.count += e.count; continue; }
    const c = { count: e.count, name: e.name };
    if (e.set) c.set = e.set;
    if (e.collector) c.collector = e.collector;
    c.section = e.section;
    index.set(key, c); cards.push(c);
  }
  return { cards, warnings };
}
