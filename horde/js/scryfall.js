// Card data from Scryfall (https://scryfall.com/docs/api), cached in localStorage.
const KEY = 'horde.scryfall.v3'; // v3: back faces of double-faced cards, loyalty
try { localStorage.removeItem('horde.scryfall.v2'); } catch {}
export const db = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } })();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function slim(c) {
  const f0 = c.card_faces?.[0] || {};
  const iu = c.image_uris || f0.image_uris || {};
  // Double-faced cards (transform, modal, meld) have an image per face; the back is kept apart.
  const f1 = c.card_faces?.[1];
  const back = !c.image_uris && f1?.image_uris ? {
    name: f1.name, type: f1.type_line || '', text: f1.oracle_text || '', cost: f1.mana_cost || '',
    power: f1.power ?? null, toughness: f1.toughness ?? null, loyalty: f1.loyalty ?? null,
    img: f1.image_uris.normal || null, large: f1.image_uris.large || f1.image_uris.normal || null, art: f1.image_uris.art_crop || null,
  } : null;
  return {
    id: c.id, name: c.name, back,
    loyalty: c.loyalty ?? f0.loyalty ?? null,
    type: (back ? f0.type_line : c.type_line) || f0.type_line || '',
    text: back ? f0.oracle_text || '' : c.oracle_text ?? (c.card_faces || []).map(f => `${f.name}\n${f.oracle_text || ''}`).join('\n\n'),
    cost: c.mana_cost ?? f0.mana_cost ?? '',
    power: c.power ?? f0.power ?? null,
    toughness: c.toughness ?? f0.toughness ?? null,
    cmc: c.cmc || 0,
    img: iu.normal || null, large: iu.large || iu.normal || null, art: iu.art_crop || null,
    token: /token/i.test(c.layout || '') || /\bToken\b/.test(c.type_line || ''),
    // Tokens this card creates, from Scryfall's related-cards list.
    parts: (c.all_parts || []).filter(p => p.component === 'token' && p.id !== c.id).map(p => p.id),
  };
}

async function collection(identifiers) {
  const out = [];
  for (let i = 0; i < identifiers.length; i += 75) {
    if (i) await sleep(120);
    const res = await fetch('https://api.scryfall.com/cards/collection', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifiers: identifiers.slice(i, i + 75) }),
    });
    if (!res.ok) throw new Error('Scryfall error ' + res.status);
    out.push(...(await res.json()).data);
  }
  return out;
}

/** Make sure every Scryfall id is in the db. */
export async function ensure(ids) {
  const need = [...new Set(ids)].filter(id => id && !db[id]);
  if (!need.length) return;
  for (const c of await collection(need.map(id => ({ id })))) db[c.id] = slim(c);
  save();
}

/** Resolve plain-text deck entries (no ids) by name. Mutates entries. */
export async function resolveNames(entries) {
  const cards = entries.filter(e => !e.ref && e.type !== 'token');
  const toks = entries.filter(e => !e.ref && e.type === 'token');
  if (cards.length) {
    const found = await collection([...new Set(cards.map(e => e.name))].map(name => ({ name })));
    const byName = new Map(found.map(c => [c.name.toLowerCase(), c]));
    for (const c of found) db[c.id] = slim(c);
    for (const e of cards) {
      const c = byName.get(e.name.toLowerCase()) || found.find(c => c.name.toLowerCase().startsWith(e.name.toLowerCase()));
      if (c) e.ref = c.id;
    }
  }
  for (const e of toks) {
    const r = await searchTokens(`!"${e.name}"`);
    if (r[0]) e.ref = r[0].id;
    await sleep(120);
  }
  save();
}

export async function searchTokens(q) {
  const url = 'https://api.scryfall.com/cards/search?unique=art&order=name&q=' + encodeURIComponent(`t:token ${q}`);
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = (await res.json()).data || [];
  const out = data.slice(0, 40).map(slim);
  for (const c of out) db[c.id] = c;
  save();
  return out;
}

/**
 * Look up a player's deck: cards are { name, set?, collector?, scryfallId? }.
 * Prefers the exact printing, falls back to the name. Sets `ref` on each card found
 * and returns the names that could not be found.
 */
export async function resolveDeck(cards) {
  const front = n => n.split(' // ')[0];
  const key = (set, num) => `${String(set).toLowerCase()}|${num}`;
  const idf = c => c.scryfallId ? { id: c.scryfallId }
    : c.set && c.collector ? { set: c.set, collector_number: String(c.collector) } : { name: front(c.name) };
  const index = found => {
    for (const f of found) db[f.id] = slim(f);
    const m = new Map();
    for (const f of found) {
      m.set('id:' + f.id, f); m.set('sc:' + key(f.set, f.collector_number), f);
      m.set('n:' + f.name.toLowerCase(), f); m.set('n:' + front(f.name).toLowerCase(), f);
    }
    return m;
  };
  const pick = (m, c) => m.get('id:' + c.scryfallId) || (c.set && m.get('sc:' + key(c.set, c.collector)))
    || m.get('n:' + c.name.toLowerCase()) || m.get('n:' + front(c.name).toLowerCase());
  let m = index(await collection(cards.map(idf)));
  let missing = cards.filter(c => { const f = pick(m, c); if (f) c.ref = f.id; return !f; });
  if (missing.length) {                    // second chance by name (unknown printing, typo in set code…)
    m = index(await collection([...new Set(missing.map(c => front(c.name)))].map(name => ({ name }))));
    missing = missing.filter(c => { const f = pick(m, c); if (f) c.ref = f.id; return !f; });
  }
  save();
  return missing.map(c => c.name);
}
