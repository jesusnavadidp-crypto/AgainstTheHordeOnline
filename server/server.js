// Horde Table room server: static files from ../horde/ + WebSocket rooms at /ws (see PROTOCOL.md).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { importDeck } from './importers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(here, '../horde');
const { reduce } = await import(pathToFileURL(path.join(WEB, 'js/game.js')).href);
const { stampLog } = await import(pathToFileURL(path.join(WEB, 'js/stamp.js')).href);

const PORT = process.env.PORT ?? 8787;
const ROOMS_FILE = process.env.ROOMS_FILE ?? path.join(here, 'rooms.json'); // env override is for tests
const IDLE_MS = 12 * 3600e3, MAX_PLAYERS = 8, MAX_UNDO = 40;

// ---------- static files ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webp': 'image/webp' };

// Deck import: GET /api/deck?url=<encoded>, rate-limited per IP.
const importHits = new Map();
async function deckRoute(req, res, u) {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const ip = req.socket.remoteAddress ?? '?', now = Date.now();
  const hits = (importHits.get(ip) ?? []).filter(t => now - t < 60e3);
  if (hits.length >= 20) return send(429, { error: 'Too many imports — wait a minute and try again' });
  hits.push(now); importHits.set(ip, hits);
  if (importHits.size > 5000) importHits.clear();
  try { send(200, await importDeck(u.searchParams.get('url') ?? '')); }
  catch (e) { send(e.status ?? 502, { error: e.status ? e.message : 'Import failed' }); }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/api/deck?')) return deckRoute(req, res, new URL(req.url, 'http://x'));
  const fail = (code) => { res.writeHead(code, { 'Cache-Control': 'no-store' }); res.end(code === 404 ? 'Not found' : 'Bad request'); };
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return fail(400); }
  if (rel.includes('\0')) return fail(400);
  // Keep-alive / health check: an HTTP request Render counts as traffic (see net.js).
  if (rel === '/healthz') { res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end(); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(WEB, '.' + rel);
  // Traversal guard: resolved path must stay inside WEB.
  if (file !== WEB && !file.startsWith(WEB + path.sep)) return fail(404);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return fail(404);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
});

// ---------- rooms ----------
// room: { code, state, seq, undo: [state], players: [{id, name}], idleSince }
// Sockets live in `conns` (runtime only): Map<ws, {room, id, name}>; online = some ws bound to that player.
const rooms = new Map();
const conns = new Map();

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const socketsOf = (room) => [...conns].filter(([, c]) => c.room === room).map(([ws, c]) => [ws, c]);
const isOnline = (room, id) => socketsOf(room).some(([, c]) => c.id === id);
const playerList = (room) => room.players.map(p => ({ id: p.id, name: p.name, online: isOnline(room, p.id) }));
const broadcast = (room, msg) => { for (const [ws] of socketsOf(room)) send(ws, msg); };
const sendPlayers = (room) => broadcast(room, { t: 'players', players: playerList(room) });

let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  const data = [...rooms.values()].map(r => ({ code: r.code, state: r.state, seq: r.seq, undo: r.undo, players: r.players, idleSince: r.idleSince }));
  // Write a temp file and rename it, so a crash mid-write never corrupts rooms.json.
  try { fs.writeFileSync(ROOMS_FILE + '.tmp', JSON.stringify(data)); fs.renameSync(ROOMS_FILE + '.tmp', ROOMS_FILE); }
  catch (e) { console.error('save failed:', e.message); }
}
function saveSoon() { if (!saveTimer) saveTimer = setTimeout(saveNow, 1000); }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (saveTimer) saveNow(); process.exit(0); });

try {
  for (const r of JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'))) {
    rooms.set(r.code, { ...r, undo: r.undo ?? [], idleSince: r.idleSince ?? Date.now() });
  }
} catch { /* no saved rooms (or unreadable): start empty */ }

function newCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O
  for (;;) {
    let c = ''; for (let i = 0; i < 4; i++) c += L[Math.floor(Math.random() * L.length)];
    c += '-' + String(Math.floor(Math.random() * 100)).padStart(2, '0');
    if (!rooms.has(c)) return c;
  }
}

// Reap rooms that have had nobody online for 12h.
setInterval(() => {
  for (const [code, r] of rooms) {
    if (socketsOf(r).length) continue;
    if (Date.now() - r.idleSince > IDLE_MS) { rooms.delete(code); saveSoon(); }
  }
}, 10 * 60e3).unref();

const cleanName = (n) => (typeof n === 'string' ? n.trim().slice(0, 24) : '') || 'Survivor';
// Stamp `by` on every log entry lacking it (create / reset).
const stampAll = (state, name) => { for (const e of state.log ?? []) if (e.by === undefined) e.by = name; return state; };
const isState = (s) => s && typeof s === 'object' && !Array.isArray(s) && s.zones && s.cards && Array.isArray(s.log);

// Reject malformed actions before they reach the reducer (a bad one could corrupt or hang a room).
const ACTIONS = new Set(['MOVE', 'REVEAL', 'DRAW', 'GATHER_CASTS', 'CAST_REVEALED', 'RESOLVE_STACK', 'START_HORDE_TURN', 'PHASE',
  'BEGIN_COMBAT', 'ATTACK', 'BLOCK', 'END_COMBAT', 'END_SURVIVOR_TURN', 'LIFE', 'POISON', 'HORDE_LIFE', 'MILL', 'DAMAGE_HORDE',
  'TAP', 'COUNTER', 'CREATE', 'SHUFFLE', 'ANTHEM', 'NOTE',
  'SEAT', 'SEAT_DECK', 'SEAT_DRAW', 'SEAT_SHUFFLE', 'SEAT_MULLIGAN', 'UNTAP_ALL', 'SURVIVOR_ATTACK', 'GY_TO_LIBRARY', 'SET_OPT', 'ATTACH', 'COMMANDER']);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const num = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6;
const str = (v, max = 500) => typeof v === 'string' && v.length <= max;
const idList = (v) => Array.isArray(v) && v.length <= 5000 && v.every(x => int(x, 0, 1e7));
const SECTIONS = new Set(['commander', 'main', 'side', 'maybe']);
const entry = (e) => e && typeof e === 'object' && str(e.ref, 64) && str(e.name, 200) && (e.section === undefined || SECTIONS.has(e.section))
  && (e.type === undefined || str(e.type, 20));
function validAction(a) {
  if (!a || typeof a !== 'object' || !ACTIONS.has(a.t)) return false;
  for (const k of ['d', 'damage', 'poison']) if (k in a && !num(a[k])) return false;
  if ('v' in a && !num(a.v) && typeof a.v !== 'boolean') return false;          // TAP/BLOCK/ATTACK use booleans
  for (const k of ['ids', 'order', 'kill', 'tap']) if (k in a && !idList(a[k])) return false;
  if ('n' in a && !int(a.n, 0, 500)) return false;
  for (const k of ['id', 'by', 'host']) if (k in a && a[k] !== null && !int(a[k], 0, 1e7)) return false;
  if ('hand' in a && !int(a.hand, 0, 30)) return false;
  if ('aura' in a && typeof a.aura !== 'boolean') return false;
  if (['ATTACH', 'COMMANDER'].includes(a.t) && !int(a.id, 0, 1e7)) return false;
  if (a.t === 'SET_OPT' && !(a.k === 'tokensPersist' && typeof a.v === 'boolean')) return false;
  if ('setupLeft' in a && !int(a.setupLeft, 0, 3)) return false;
  for (const k of ['to', 'pos', 'phase', 'from', 'ref', 'name', 'msg', 'deckName']) if (k in a && !str(a[k])) return false;
  // Seat ids are client ids (UUIDs, or 'local'): never anything like __proto__.
  for (const k of ['seat', 'owner']) if (k in a && a[k] !== undefined && !(typeof a[k] === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(a[k]))) return false;
  if (['END_COMBAT', 'SURVIVOR_ATTACK'].includes(a.t) && !(num(a.damage) && a.damage >= 0)) return false;
  if (['MOVE', 'TAP', 'COUNTER', 'BLOCK', 'ATTACK', 'BEGIN_COMBAT'].includes(a.t) && !Array.isArray(a.ids)) return false;
  if ('entries' in a && !(Array.isArray(a.entries) && a.entries.length <= 400 && a.entries.every(entry))) return false;
  if ('counters' in a && !(Array.isArray(a.counters) && a.counters.length <= 200 && a.counters.every(x => Array.isArray(x) && int(x[0], 0, 1e7) && num(x[1])))) return false;
  return true;
}

function leave(ws) {
  const c = conns.get(ws);
  if (!c) return;
  conns.delete(ws);
  if (!socketsOf(c.room).length) c.room.idleSince = Date.now();
  sendPlayers(c.room);
  saveSoon();
}

function enter(ws, room, id, name) {
  const err = (code, msg) => send(ws, { t: 'error', code, msg });
  let p = room.players.find(x => x.id === id);
  // A reconnecting clientId replaces its previous socket (e.g. refresh before the old one timed out).
  for (const [old, c] of socketsOf(room)) if (c.id === id && old !== ws) { send(old, { t: 'error', code: 'replaced', msg: 'Opened in another tab' }); conns.delete(old); old.close(); }
  if (!p && socketsOf(room).length >= MAX_PLAYERS) return err('room-full', 'Room is full');
  if (conns.has(ws)) leave(ws); // switching rooms
  if (p) p.name = name; else { p = { id, name }; room.players.push(p); }
  room.idleSince = null;
  conns.set(ws, { room, id, name });
  send(ws, { t: 'joined', room: room.code, you: { id, name }, state: room.state, seq: room.seq, players: playerList(room), canUndo: room.undo.length > 0 });
  sendPlayers(room);
  saveSoon();
}

function handle(ws, m) {
  const err = (code, msg) => send(ws, { t: 'error', code, msg });
  const c = conns.get(ws);
  switch (m.t) {
    case 'ping': return send(ws, { t: 'pong' });
    case 'create': case 'join': {
      const id = typeof m.clientId === 'string' ? m.clientId.slice(0, 64) : '';
      if (!id) return err('bad-message', 'clientId required');
      const name = cleanName(m.name);
      if (m.t === 'create') {
        if (!isState(m.state)) return err('bad-message', 'state required');
        const room = { code: newCode(), state: stampAll(m.state, name), seq: 0, undo: [], players: [], idleSince: null };
        rooms.set(room.code, room);
        return enter(ws, room, id, name);
      }
      const room = rooms.get(String(m.room ?? '').trim().toUpperCase());
      if (!room) return err('no-room', 'No such room');
      return enter(ws, room, id, name);
    }
    case 'act': case 'undo': case 'reset': {
      if (!c) return err('not-in-room', 'Join a room first');
      const room = c.room, by = { id: c.id, name: c.name };
      if (m.t === 'act') {
        const bad = (msg) => send(ws, { t: 'error', code: 'bad-action', msg, nonce: m.nonce });
        if (!validAction(m.a)) return bad('Invalid action');
        // Players may only change their own seat (their deck, draws, name).
        if (['SEAT', 'SEAT_DECK', 'SEAT_DRAW', 'SEAT_SHUFFLE', 'SEAT_MULLIGAN', 'UNTAP_ALL', 'COMMANDER'].includes(m.a.t) && m.a.seat !== c.id) return bad('That is another player\'s seat');
        let next;
        try { next = stampLog(reduce(room.state, m.a), c.name); } catch (e) { return bad(String(e.message ?? e)); }
        // Only real changes become undo steps (a no-op, e.g. a duplicate button press, must not).
        if (m.checkpoint && JSON.stringify(next) !== JSON.stringify(room.state)) { room.undo.push(room.state); if (room.undo.length > MAX_UNDO) room.undo.shift(); }
        room.state = next; room.seq++;
        broadcast(room, { t: 'act', a: m.a, by, seq: room.seq, nonce: m.nonce, checkpoint: !!m.checkpoint, canUndo: room.undo.length > 0 });
      } else if (m.t === 'undo') {
        if (!room.undo.length) return err('no-undo', 'Nothing to undo');
        if (room.state.phase === 'horde') return err('busy', 'Wait for the Horde to finish its turn');
        room.state = room.undo.pop(); room.seq++;
        broadcast(room, { t: 'state', state: room.state, seq: room.seq, reason: 'undo', by, canUndo: room.undo.length > 0 });
      } else {
        if (!isState(m.state)) return err('bad-message', 'state required');
        room.state = stampAll(m.state, c.name); room.undo = []; room.seq++;
        broadcast(room, { t: 'state', state: room.state, seq: room.seq, reason: 'reset', by, canUndo: false });
      }
      return saveSoon();
    }
    default: return err('bad-message', 'unknown t');
  }
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2 * 1024 * 1024 });
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 30e3).unref();
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { m = null; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return send(ws, { t: 'error', code: 'bad-message', msg: 'Invalid message' });
    try { handle(ws, m); } catch (e) { send(ws, { t: 'error', code: 'bad-message', msg: String(e.message ?? e) }); }
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

server.listen(PORT, () => console.log(`Horde Table on http://localhost:${PORT}`));
