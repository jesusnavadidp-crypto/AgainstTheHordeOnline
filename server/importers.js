// Deck URL importers (server side). importDeck(url) -> { name, source, cards, warnings }
// Security: the user's URL is only parsed for a host + deck id; we build the upstream URL ourselves
// from a fixed allow-list of hosts (https only), so it can never point anywhere else (no SSRF).
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const { parseDecklist } = await import(pathToFileURL(path.join(here, '../horde/js/decklist.js')).href);

const UA = 'HordeTable/1.0 (deck import)';
const TIMEOUT_MS = 10_000, MAX_BYTES = 3 * 1024 * 1024, CACHE_MS = 10 * 60_000, CACHE_MAX = 200;

export class ImportError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

// ---------- URL -> { site, id } ----------
const UNSUPPORTED = 'Unsupported site — paste the deck list as text instead';
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function identify(input) {
  let u;
  try { u = new URL(String(input ?? '').trim()); } catch { throw new ImportError('That does not look like a link — paste the deck list as text instead', 400); }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) throw new ImportError(UNSUPPORTED, 400);
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const seg = u.pathname.split('/').filter(Boolean);
  if (host === 'archidekt.com') {
    const i = seg.indexOf('decks');
    if (seg[0] === 'decks' && /^\d{1,10}$/.test(seg[1] ?? '')) return { site: 'archidekt', id: seg[1] };
    if (seg[0] === 'api' && i === 1 && /^\d{1,10}$/.test(seg[2] ?? '')) return { site: 'archidekt', id: seg[2] };
  } else if (host === 'moxfield.com') {
    if (seg[0] === 'decks' && ID_RE.test(seg[1] ?? '')) return { site: 'moxfield', id: seg[1] };
  } else if (host === 'mtggoldfish.com') {
    if (seg[0] === 'deck' && /^\d{1,10}$/.test(seg[1] ?? '')) return { site: 'mtggoldfish', id: seg[1] };
    if (seg[0] === 'deck' && seg[1] === 'download' && /^\d{1,10}$/.test(seg[2] ?? '')) return { site: 'mtggoldfish', id: seg[2] };
  } else if (host === 'tappedout.net') {
    if (seg[0] === 'mtg-decks' && /^[A-Za-z0-9_-]{1,120}$/.test(seg[1] ?? '')) return { site: 'tappedout', id: seg[1] };
  }
  throw new ImportError(UNSUPPORTED, 400);
}

// ---------- fetch with timeout, size cap, same-host https redirects only ----------
async function get(urlStr, accept, siteLabel) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let url = new URL(urlStr);
    const host = url.hostname;
    for (let hop = 0; hop < 4; hop++) {
      const res = await fetch(url, { signal: ctl.signal, redirect: 'manual', headers: { 'User-Agent': UA, Accept: accept } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location'), url);
        if (next.protocol !== 'https:' || next.hostname !== host) throw new ImportError(`${siteLabel} redirected somewhere unexpected`, 502);
        url = next; continue;
      }
      if (res.status === 404 || res.status === 410) throw new ImportError('Deck not found or private', 404);
      if (res.status === 401) throw new ImportError('Deck not found or private', 404);
      if (res.status === 403 || res.status === 429 || res.status === 503) {
        const hint = siteLabel === 'Moxfield' ? ' — in Moxfield use Export → Copy as plain text and paste it here'
          : ' — export the deck as text on the site and paste it here';
        throw new ImportError(`${siteLabel} did not allow the request${hint}`, 502);
      }
      if (!res.ok) throw new ImportError(`${siteLabel} returned an error (${res.status})`, 502);
      const len = Number(res.headers.get('content-length'));
      if (len > MAX_BYTES) throw new ImportError('Deck response too large', 502);
      const chunks = []; let total = 0;
      for await (const ch of res.body) {
        total += ch.length;
        if (total > MAX_BYTES) { ctl.abort(); throw new ImportError('Deck response too large', 502); }
        chunks.push(ch);
      }
      return Buffer.concat(chunks).toString('utf8');
    }
    throw new ImportError(`${siteLabel} redirected too many times`, 502);
  } catch (e) {
    if (e instanceof ImportError) throw e;
    if (e?.name === 'AbortError') throw new ImportError(`${siteLabel} took too long to respond`, 502);
    throw new ImportError(`Could not reach ${siteLabel}`, 502);
  } finally { clearTimeout(timer); }
}

async function getJson(url, label) {
  const body = await get(url, 'application/json', label);
  if (/^\s*</.test(body)) throw new ImportError(`${label} did not allow the request — paste the deck list as text instead`, 502);
  try { return JSON.parse(body); } catch { throw new ImportError(`${label} sent an unreadable response`, 502); }
}

async function getText(url, label) {
  const body = await get(url, 'text/plain', label);
  if (/^\s*<(!doctype|html)/i.test(body)) throw new ImportError(`${label} did not allow the request — paste the deck list as text instead`, 502);
  return body;
}

// ---------- sites ----------
const SCRY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mergeCards(cards) {
  const idx = new Map(), out = [];
  for (const c of cards) {
    const k = c.section + '\0' + c.name.toLowerCase();
    const hit = idx.get(k);
    if (hit) hit.count += c.count; else { idx.set(k, c); out.push(c); }
  }
  return out;
}

async function archidekt(id) {
  const d = await getJson(`https://archidekt.com/api/decks/${id}/`, 'Archidekt');
  if (!d || !Array.isArray(d.cards)) throw new ImportError('Deck not found or private', 404);
  const excluded = new Map(); // category name -> section for categories not part of the main deck
  for (const c of d.categories ?? []) if (c.includedInDeck === false) excluded.set(c.name, /maybe|consider/i.test(c.name) ? 'maybe' : 'side');
  const cards = [];
  for (const c of d.cards) {
    if (c.deletedAt) continue;
    const oc = c.card?.oracleCard;
    if (!oc?.name) continue;
    const cats = c.categories ?? [];
    let section = 'main';
    if (cats.includes('Commander')) section = 'commander';
    else if (c.companion) section = 'side';
    else { const ex = cats.map(n => excluded.get(n)).find(Boolean); if (ex) section = ex; }
    const e = { count: c.quantity ?? 1, name: oc.name };
    if (c.card.edition?.editioncode) e.set = String(c.card.edition.editioncode).toLowerCase();
    if (c.card.collectorNumber) e.collector = String(c.card.collectorNumber);
    e.section = section;
    if (SCRY_ID.test(c.card.uid ?? '')) e.scryfallId = c.card.uid.toLowerCase();
    cards.push(e);
  }
  return { name: d.name || 'Archidekt deck', cards: mergeCards(cards), warnings: [] };
}

async function moxfield(id) {
  const d = await getJson(`https://api2.moxfield.com/v3/decks/all/${id}`, 'Moxfield');
  const boards = d?.boards;
  if (!boards) throw new ImportError('Deck not found or private', 404);
  const map = { commanders: 'commander', mainboard: 'main', sideboard: 'side', maybeboard: 'maybe', companions: 'side' };
  const cards = [];
  for (const [board, section] of Object.entries(map)) {
    for (const v of Object.values(boards[board]?.cards ?? {})) {
      const c = v?.card; if (!c?.name) continue;
      const e = { count: v.quantity ?? 1, name: c.name };
      if (c.set) e.set = String(c.set).toLowerCase();
      if (c.cn) e.collector = String(c.cn);
      e.section = section;
      if (SCRY_ID.test(c.scryfall_id ?? '')) e.scryfallId = c.scryfall_id.toLowerCase();
      cards.push(e);
    }
  }
  return { name: d.name || 'Moxfield deck', cards: mergeCards(cards), warnings: [] };
}

async function textSite(url, label, fallbackName) {
  const text = await getText(url, label);
  const r = parseDecklist(text);
  if (!r.cards.length) throw new ImportError(`${label} deck was empty or unreadable`, 502);
  return { name: fallbackName, cards: r.cards, warnings: r.warnings };
}

const SITES = {
  archidekt: { label: 'Archidekt', run: archidekt },
  moxfield: { label: 'Moxfield', run: moxfield },
  mtggoldfish: { label: 'MTGGoldfish', run: id => textSite(`https://www.mtggoldfish.com/deck/download/${id}`, 'MTGGoldfish', `MTGGoldfish deck ${id}`) },
  tappedout: { label: 'TappedOut', run: id => textSite(`https://tappedout.net/mtg-decks/${id}/?fmt=txt`, 'TappedOut', id.replace(/-/g, ' ')) },
};

// ---------- cache + entry point ----------
const cache = new Map(); // key -> { at, value }

export async function importDeck(url) {
  const { site, id } = identify(url);
  const key = site + ':' + id;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return structuredClone(hit.value);
  const r = await SITES[site].run(id);
  if (!r.cards.length) throw new ImportError('Deck is empty', 404);
  const value = { name: r.name, source: site, cards: r.cards, warnings: r.warnings };
  cache.set(key, { at: Date.now(), value });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return structuredClone(value);
}
