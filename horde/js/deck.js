import { COMMUNITY } from './community.js?v=19';
// Deck definitions + parsing + library building.
// Deck .txt files use the against-the-horde.com format:
//   <count> <set> <type> <flag> <name...> <oracle_id> <scryfall_id>
// Plain lists ("12 Zombie token", "1 Grave Titan") are also accepted.

export const DECKS = [
  { key: 'zombie', name: 'Zombie', file: 'decks/zombie.txt', haste: 'all',
    intro: 'The original horde deck by Peter Knudson.',
    rules: 'All creatures controlled by the Horde have haste.' },
  { key: 'dinosaur', name: 'Dinosaur', file: 'decks/dinosaur.txt', haste: 'all',
    intro: 'A modified version of the Dinosaur Rage deck by TenkayCrit.',
    rules: 'All creatures controlled by the Horde have haste.' },
  { key: 'nature', name: 'Nature', file: 'decks/nature.txt', haste: 'tokens',
    intro: 'For token lovers.',
    rules: 'All tokens controlled by the Horde have haste.' },
  { key: 'sliver', name: 'Sliver', file: 'decks/sliver.txt', haste: 'all',
    intro: 'A modified version of the Sliver Hive deck by TenkayCrit.',
    rules: 'All creatures controlled by the Horde have haste. All of the artifact slivers in the Horde deck are treated as tokens.' },
  { key: 'human', name: 'Human', file: 'decks/human.txt', haste: 'all',
    intro: 'A modified version of the Armies of Men deck by TenkayCrit.',
    rules: 'All creatures controlled by the Horde have haste and are Humans in addition to their other creature types. All tokens controlled by the Horde are white.' },
  { key: 'phyrexian', name: 'Phyrexian', file: 'decks/phyrexian.txt', haste: 'all', poison: true,
    intro: 'A modified version of the Phyrexian Perfection deck by TenkayCrit.',
    rules: 'All creatures controlled by the Horde have haste. The Survivors share poison counters and do not lose for having 10 or more. Every time the Survivors gain poison counters, each Survivor exiles 1 card from the top of their library face down per counter.' },
  { key: 'eldrazi', name: 'Eldrazi', file: 'decks/eldrazi.txt', haste: 'tokens',
    intro: 'A modified version of the Eldrazi Horror deck by TenkayCrit.',
    rules: 'All tokens controlled by the Horde have haste. Eldrazi Spawn the Horde controls cannot attack or block. If the Horde controls 10 Eldrazi Spawn at the start of its precombat main phase, they are sacrificed, and the Horde casts the three Eldrazi titans from exile.' },
];

// Community Hordes (see community.js) come after the official ones.
DECKS.push(...COMMUNITY);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseLine(line) {
  const f = line.split(/\s+/);
  if (f.length >= 7 && /^\d+$/.test(f[0]) && UUID.test(f[f.length - 1])) {
    const flag = f[3];
    let flashback = false, flashbackExile = true, cantAttack = false;
    if (flag === 'YES' || flag === 'NO') flashback = flag === 'YES';
    else { flashback = flag.includes('f'); flashbackExile = !flag.includes('e'); cantAttack = flag.includes('d'); }
    return { count: +f[0], type: f[2].toLowerCase(), flashback, flashbackExile, cantAttack,
      name: f.slice(4, -2).join(' '), ref: f[f.length - 1] };
  }
  // Plain format: "12 Zombie token", "1x Grave Titan", "Grave Titan"
  const m = line.match(/^(?:(\d+)x?\s+)?(.+?)$/i);
  if (!m) return null;
  let name = m[2].replace(/\s*\([A-Z0-9]{2,6}\)\s*\S*$/i, '').trim(); // strip "(SET) 123"
  let type = null;
  if (/\s+token$/i.test(name)) { type = 'token'; name = name.replace(/\s+token$/i, ''); }
  return { count: m[1] ? +m[1] : 1, type, flashback: false, flashbackExile: true, cantAttack: false, name, ref: null };
}

export function parseDeck(text) {
  const s = { main: [], strong: [], tokens: [], weak: [], powerful: [] };
  let cur = 'main';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('##')) {
      const l = line.toLowerCase();
      cur = l.includes('too strong') ? 'strong' : l.includes('available tokens') ? 'tokens'
        : l.includes('weak') ? 'weak' : l.includes('powerful') ? 'powerful' : 'main';
      continue;
    }
    const e = parseLine(line);
    if (e) s[cur].push(e);
  }
  return s;
}

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function scale(list, f) {
  const out = [];
  for (let k = 0; k < Math.floor(f); k++) out.push(...list);
  const frac = f - Math.floor(f);
  if (frac > 0) out.push(...shuffle(list).slice(0, Math.round(list.length * frac)));
  return out;
}

/** Returns an ordered list of deck entries (top of library first). */
export function buildLibrary(sections, opts) {
  const strongNames = new Set(sections.strong.map(e => e.name));
  let tokens = [], spells = [];
  for (const e of sections.main) {
    const n = e.type === 'token' ? e.count * opts.tokenMult : e.count;
    for (let i = 0; i < n; i++) (e.type === 'token' ? tokens : spells).push(e);
  }
  tokens = shuffle(scale(tokens, opts.size));
  spells = shuffle(scale(spells, opts.size));
  if (!opts.safeZone) return shuffle([...tokens, ...spells]);

  // Safe zone: the first part of the library has no "too strong" cards and
  // tokens spread evenly between non-token cards, so early waves are fair.
  const total = tokens.length + spells.length;
  const S = Math.round(total * opts.safeZoneSize);
  const weak = spells.filter(e => !strongNames.has(e.name));
  const strong = spells.filter(e => strongNames.has(e.name));
  const st = Math.min(tokens.length, Math.round(S * tokens.length / Math.max(1, total)));
  const ss = Math.min(weak.length, S - st);
  const safeTok = tokens.slice(0, st), safeSp = weak.slice(0, ss);
  const safe = [];
  const gap = st / Math.max(1, ss);
  let ti = 0;
  for (let k = 0; k < ss; k++) {
    const until = Math.round((k + 1) * gap);
    while (ti < until) safe.push(safeTok[ti++]);
    safe.push(safeSp[k]);
  }
  while (ti < st) safe.push(safeTok[ti++]);
  return [...safe, ...shuffle([...tokens.slice(st), ...weak.slice(ss), ...strong])];
}
