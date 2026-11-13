// Self-contained test: spawns server.js on a free port, drives it with two ws clients.
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const { initState } = await import(pathToFileURL(path.join(here, '../horde/js/game.js')).href);

const port = await new Promise(r => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'horde-test-'));
const child = spawn('node', ['server.js'], { cwd: here, env: { ...process.env, PORT: port, ROOMS_FILE: path.join(tmp, 'rooms.json') }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => child.stdout.on('data', d => String(d).includes('Horde Table on') && r()));

// A client queues incoming messages; next(pred) resolves with the first matching one.
function client() {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const q = [], waiters = [];
  ws.on('message', d => {
    const m = JSON.parse(d); const i = waiters.findIndex(w => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].res(m); else q.push(m);
  });
  const next = (pred = () => true, ms = 3000) => {
    const i = q.findIndex(pred); if (i >= 0) return Promise.resolve(q.splice(i, 1)[0]);
    return new Promise((res, rej) => { waiters.push({ pred, res }); setTimeout(() => rej(new Error('timeout')), ms); });
  };
  const open = new Promise(r => ws.on('open', r));
  return { ws, next, open, send: o => ws.send(typeof o === 'string' ? o : JSON.stringify(o)) };
}
const is = t => m => m.t === t;

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, '-', e.message); }
}

const state = initState({ deck: { name: 'Test', haste: 'all', key: 't' }, entries: [{ ref: 'x', name: 'Zombie', type: 'token', creature: true }], opts: { life: 20 } });
const A = client(), B = client();
await Promise.all([A.open, B.open]);
let code, seq0;

await check('create -> joined with code format', async () => {
  A.send({ t: 'create', clientId: 'ca', name: 'Alice', state });
  const j = await A.next(is('joined'));
  code = j.room; seq0 = j.seq;
  assert.match(code, /^[A-HJ-NP-Z]{4}-\d{2}$/);
  assert.equal(j.you.id, 'ca'); assert.equal(j.canUndo, false);
  assert.equal(j.state.life, 20);
  assert.ok(j.state.log.every(e => e.by === 'Alice'), 'create stamps log');
});

await check('second client joins by lowercase code', async () => {
  B.send({ t: 'join', clientId: 'cb', name: 'Bob', room: code.toLowerCase() });
  const j = await B.next(is('joined'));
  assert.equal(j.room, code); assert.equal(j.players.length, 2);
  const p = await A.next(m => m.t === 'players' && m.players.length === 2); assert.equal(p.players.length, 2);
});

await check('act broadcast to both with same seq; log stamped', async () => {
  A.send({ t: 'act', a: { t: 'NOTE', msg: 'hello' }, checkpoint: false, nonce: 'n1' });
  const [a, b] = await Promise.all([A.next(is('act')), B.next(is('act'))]);
  assert.equal(a.seq, b.seq); assert.equal(a.seq, seq0 + 1);
  assert.equal(a.nonce, 'n1'); assert.equal(b.by.name, 'Alice');
  assert.deepEqual(a.a, { t: 'NOTE', msg: 'hello' });
  // Verify server-side stamping via a fresh join.
  const C = client(); await C.open;
  C.send({ t: 'join', clientId: 'cc', name: 'Cy', room: code });
  const j = await C.next(is('joined'));
  assert.equal(j.state.log.at(-1).msg, 'hello'); assert.equal(j.state.log.at(-1).by, 'Alice');
  C.ws.close();
  const quiet = m => m.t === 'players' && m.players.length === 3 && !m.players[2].online;
  await A.next(quiet); await B.next(quiet); // Cy left
});

await check('LIFE action with checkpoint, then undo restores', async () => {
  B.send({ t: 'act', a: { t: 'LIFE', d: -3 }, checkpoint: true, nonce: 'n2' });
  const a = await A.next(is('act')); await B.next(is('act'));
  assert.equal(a.canUndo, true); assert.equal(a.checkpoint, true);
  A.send({ t: 'undo' });
  const s = await B.next(is('state')); await A.next(is('state'));
  assert.equal(s.reason, 'undo'); assert.equal(s.state.life, 20); assert.equal(s.canUndo, false);
  A.send({ t: 'undo' });
  const e = await A.next(is('error')); assert.equal(e.code, 'no-undo');
});

await check('bad action -> bad-action to sender only', async () => {
  A.send({ t: 'act', a: { t: 'MOVE' }, checkpoint: false, nonce: 'x' });
  const e = await A.next(is('error')); assert.equal(e.code, 'bad-action');
});

await check('bad JSON -> bad-message, still connected', async () => {
  A.send('{nope');
  const e = await A.next(is('error')); assert.equal(e.code, 'bad-message');
  A.send({ t: 'ping' }); await A.next(is('pong'));
  assert.equal(A.ws.readyState, WebSocket.OPEN);
});

await check('act before join -> not-in-room', async () => {
  const D = client(); await D.open;
  D.send({ t: 'act', a: { t: 'LIFE', d: 1 } });
  assert.equal((await D.next(is('error'))).code, 'not-in-room');
  D.ws.close();
});

await check('join unknown room -> no-room', async () => {
  const D = client(); await D.open;
  D.send({ t: 'join', clientId: 'cd', name: 'D', room: 'ZZZZ-99' });
  assert.equal((await D.next(is('error'))).code, 'no-room');
  D.ws.close();
});

await check('disconnect -> players online:false; reconnect keeps one entry', async () => {
  B.ws.close();
  let p = await A.next(m => m.t === 'players' && m.players.find(x => x.id === 'cb')?.online === false);
  const B2 = client(); await B2.open;
  B2.send({ t: 'join', clientId: 'cb', name: 'Bob', room: code });
  const j = await B2.next(is('joined'));
  assert.equal(j.players.length, 3);
  assert.equal(j.players.filter(x => x.id === 'cb').length, 1);
  assert.equal(j.players.find(x => x.id === 'cb').online, true);
  p = await A.next(m => m.t === 'players' && m.players.find(x => x.id === 'cb')?.online === true);
  B2.ws.close();
});

await check('reset replaces state, clears undo', async () => {
  A.send({ t: 'reset', state: { ...state, life: 40 } });
  const s = await A.next(is('state'));
  assert.equal(s.reason, 'reset'); assert.equal(s.state.life, 40); assert.equal(s.canUndo, false);
});

const get = (p) => fetch(`http://localhost:${port}${p}`);
await check('static: / serves index.html', async () => {
  const r = await get('/'); assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(await r.text(), /<html/i);
});
await check('static: js content type', async () => {
  const r = await get('/js/game.js'); assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/); await r.arrayBuffer();
});
await check('static: traversal blocked (404)', async () => {
  for (const p of ['/../server/server.js', '/%2e%2e/server/server.js', '/..%2fserver/server.js']) {
    const r = await get(p); assert.equal(r.status, 404, p); await r.arrayBuffer();
  }
  // raw request so the client does not normalise the path
  const status = await new Promise(res => {
    const s = net.connect(port, 'localhost', () => s.write('GET /../server/server.js HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    let d = ''; s.on('data', c => d += c); s.on('end', () => res(+d.split(' ')[1]));
  });
  assert.equal(status, 404);
});
await check('static: missing file 404', async () => { const r = await get('/nope.txt'); assert.equal(r.status, 404); await r.arrayBuffer(); });
await check('healthz: 204 keep-alive', async () => { const r = await get('/healthz'); assert.equal(r.status, 204); await r.arrayBuffer(); });

A.ws.close();
child.kill();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
