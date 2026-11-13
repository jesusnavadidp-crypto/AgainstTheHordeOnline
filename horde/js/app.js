import { DECKS, parseDeck, buildLibrary, shuffle } from './deck.js?v=6';
import { db, ensure, resolveNames, searchTokens } from './scryfall.js?v=6';
import { initState, reduce, zoneOf, canAttack, status, PILES } from './game.js?v=6';
import { render, resetView, power, esc } from './view.js?v=6';
import { stampLog } from './stamp.js?v=6';
import { connectNet, clientId } from './net.js?v=6';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const wait = ms => new Promise(r => setTimeout(r, ms));
const SAVE = 'horde.save.v1';

let state = null;
let history = [];
const history_ = window.history;  // the browser's, since `history` is our undo stack
let busy = false;
let dismissed = {};

/* =================== setup screen =================== */
const OPTS = [
  { k: 'players', label: 'Survivors', vals: [[1, '1'], [2, '2'], [3, '3'], [4, '4']] },
  { k: 'life', label: 'Shared starting life', vals: [[20, '20'], [40, '40'], [60, '60'], [80, '80']] },
  { k: 'size', label: 'Horde deck size', vals: [[0.5, '50%'], [0.75, '75%'], [1, '100%'], [2, '200%']] },
  { k: 'draws', label: 'Non-token cards revealed per Horde turn', vals: [[1, '1'], [2, '2'], [3, '3']] },
  { k: 'tokenMult', label: 'Token multiplier', vals: [[1, '×1'], [2, '×2'], [3, '×3'], [4, '×4']] },
  { k: 'safeZoneSize', label: 'Safe zone (no bombs early, even waves)', vals: [[0, 'Off'], [0.2, 'Short'], [0.3, 'Default']] },
];
const TOGGLES = [
  { k: 'hordeLife', label: 'Horde has 20 life (only mills once it hits 0)' },
  { k: 'tokensPersist', label: 'Tokens may go to hand, graveyard and exile' },
];
const opts = { players: 1, life: 20, size: 0.5, draws: 1, tokenMult: 1, safeZoneSize: 0.3, hordeLife: false, tokensPersist: false };
const PRESET_SIZE = { 1: 0.5, 2: 0.75, 3: 1, 4: 1 };
let selDeck = DECKS[0].key;
const deckText = {};

function renderOpts() {
  $('#opts').innerHTML = OPTS.map(o => `<div class="opt"><label>${o.label}</label><div class="seg">${
    o.vals.map(([v, t]) => `<button data-k="${o.k}" data-v="${v}" class="${opts[o.k] === v ? 'on' : ''}">${t}</button>`).join('')}</div></div>`).join('')
    + `<div class="opt">${TOGGLES.map(t => `<label class="toggle"><input type="checkbox" data-t="${t.k}" ${opts[t.k] ? 'checked' : ''}>${t.label}</label>`).join('')}</div>`;
}
function renderDecks() {
  $('#deck-grid').innerHTML = DECKS.map(d => {
    const art = d.feature && db[d.feature]?.art;
    return `<button class="deck ${selDeck === d.key ? 'sel' : ''}" data-deck="${d.key}" style="${art ? `background-image:url('${art}')` : ''}"><span>${d.name}</span></button>`;
  }).join('') + `<button class="deck custom-tile ${selDeck === 'custom' ? 'sel' : ''}" data-deck="custom"><span>Custom list</span></button>`;
  const d = DECKS.find(x => x.key === selDeck);
  $('#custom-box').hidden = selDeck !== 'custom';
  $('#setup-rules').innerHTML = d ? `<b>${d.name}.</b> ${esc(d.intro)}<br><b>Special rules:</b> ${esc(d.rules)}`
    : '<b>Custom Horde.</b> All creatures controlled by the Horde have haste.';
}
$('#opts').addEventListener('click', e => {
  const b = e.target.closest('button[data-k]');
  if (!b) return;
  const k = b.dataset.k, v = +b.dataset.v;
  opts[k] = v;
  if (k === 'players') { opts.life = 20 * v; opts.size = PRESET_SIZE[v]; }
  renderOpts();
});
$('#opts').addEventListener('change', e => { if (e.target.dataset.t) opts[e.target.dataset.t] = e.target.checked; });
$('#deck-grid').addEventListener('click', e => {
  const b = e.target.closest('[data-deck]');
  if (b) { selDeck = b.dataset.deck; renderDecks(); }
});

async function loadDeckArt() {
  try {
    await Promise.all(DECKS.map(async d => {
      deckText[d.key] = await fetch(d.file).then(r => r.text());
      const s = parseDeck(deckText[d.key]);
      d.feature = (s.strong[0] || s.main.find(e => e.type === 'creature') || s.main[0])?.ref;
    }));
    await ensure(DECKS.map(d => d.feature));
  } catch (err) { console.warn(err); }
  renderDecks();
}

function showSetup() {
  $('#setup').classList.remove('off');
  $('#btn-continue').hidden = !localStorage.getItem(SAVE);
  $('#setup-status').textContent = '';
  renderOpts(); renderDecks();
}

$('#btn-start').addEventListener('click', startGame);
$('#btn-continue').addEventListener('click', async () => {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVE));
    $('#setup-status').textContent = 'Loading cards…';
    await ensure(Object.values(saved.cards).map(c => c.ref));
    beginWith(saved);
  } catch (err) { $('#setup-status').textContent = 'Could not load the saved game.'; console.error(err); }
});

async function startGame() {
  const btn = $('#btn-start');
  btn.disabled = true;
  const status = $('#setup-status');
  status.textContent = 'Loading cards from Scryfall…';
  try {
    let def = DECKS.find(d => d.key === selDeck);
    let text;
    if (def) text = deckText[def.key] || await fetch(def.file).then(r => r.text());
    else {
      text = $('#custom-text').value;
      def = { key: 'custom', name: 'Custom', haste: 'all', rules: 'All creatures controlled by the Horde have haste.' };
    }
    const sec = parseDeck(text);
    const all = [...sec.main, ...sec.strong, ...sec.tokens];
    if (!sec.main.length) throw new Error('The deck list is empty.');
    if (all.some(e => !e.ref)) await resolveNames(all);
    await ensure(all.map(e => e.ref));
    const missing = [];
    for (const e of all) {
      const d = db[e.ref];
      if (!d) { missing.push(e.name); continue; }
      if (!e.type) e.type = d.token ? 'token' : 'card';
      e.creature = /Creature/.test(d.type);
      e.spell = /\b(Instant|Sorcery)\b/.test(d.type) && !e.creature;
      e.name = e.type === 'token' ? d.name.replace(/ Token$/, '') : e.name;
    }
    sec.main = sec.main.filter(e => db[e.ref]);
    const entries = buildLibrary(sec, { ...opts, safeZone: opts.safeZoneSize > 0 });
    const tokenRefs = [...new Set([...sec.main, ...sec.tokens].filter(e => e.type === 'token' && db[e.ref]?.token !== false).map(e => e.ref))];
    const s = initState({
      deck: { key: def.key, name: def.name, rules: def.rules, haste: def.haste, poison: !!def.poison, tokenRefs },
      entries, opts: { ...opts },
    });
    if (missing.length) s.log.push({ turn: 0, msg: `Could not find: ${missing.join(', ')}` });
    launch(s);
  } catch (err) {
    console.error(err);
    createWith = null;
    status.textContent = err.message || 'Something went wrong loading the deck.';
  } finally { btn.disabled = false; }
}

function beginWith(s) {
  state = s; history = []; dismissed = {}; busy = false;
  resetView();
  $('#setup').classList.add('off');
  $('#deck-title').textContent = `${s.deck.name} Horde`;
  $('#rules-chip').textContent = s.deck.rules;
  $('#rules-chip').title = s.deck.rules;
  renderAll(null);
  if (s.phase === 'setup' && s.turn === 0 && s.setupLeft === 3) banner('SURVIVORS PREPARE');
}

/* =================== state plumbing =================== */
// Apply an action. Offline it applies at once; in a room it goes to the server,
// which sends it back to everyone. Resolves with { before } = the state it was applied to.
function dispatch(a, undoable = true) {
  if (!state) return Promise.resolve({ before: null });
  if (online) {
    const nonce = `${online.me.id}:${++nonceN}`;
    return new Promise(res => { pending.set(nonce, res); net.send({ t: 'act', a, checkpoint: undoable, nonce }); });
  }
  if (undoable) { history.push(state); if (history.length > 100) history.shift(); }
  const prev = state;
  state = reduce(state, a);
  try { localStorage.setItem(SAVE, JSON.stringify(state)); } catch {}
  renderAll(prev);
  return Promise.resolve({ before: prev });
}
const step = a => dispatch(a, false);
function undo() {
  if (busy) return;
  if (online) { if (online.canUndo) net.send({ t: 'undo' }); return; }
  if (!history.length) return;
  const prev = state;
  state = history.pop();
  localStorage.setItem(SAVE, JSON.stringify(state));
  renderAll(prev);
}

/* =================== online rooms =================== */
let net = null, online = null, nonceN = 0, netStatus = '';
const pending = new Map();
let inbox = Promise.resolve();
let resync = false;         // a gap in seq: ignore updates until the fresh `joined`
let lastActAt = 0;          // when the last action arrived (to tell a stalled Horde turn from a running one)
// Settle every in-flight action as "lost" so awaiting code (the Horde turn) stops instead of hanging.
function dropPending() { for (const res of pending.values()) res({ before: null }); pending.clear(); }
let createWith = null;      // state to open a new room with, once connected

function myName() { return ($('#net-name').value.trim() || 'Survivor').slice(0, 24); }
function ensureNet() {
  if (net) return net;
  net = connectNet({
    onMessage: m => { inbox = inbox.then(() => handleNet(m)).catch(err => console.error(err)); },
    onStatus: st => { netStatus = st; if (st !== 'online') dropPending(); renderRoom(); if (st === 'unreachable' && !online) setNetMsg('Can\'t reach the room server. Online play needs it running (see README).'); },
  });
  return net;
}
function setNetMsg(t) { $('#net-msg').textContent = t; }
function saveName() { try { localStorage.setItem('horde.name', myName()); } catch {} }

async function withCards(s) { await ensure([...new Set(Object.values(s.cards).map(c => c.ref))]); return s; }

async function handleNet(m) {
  switch (m.t) {
    case 'joined': {
      dropPending(); resync = false; lastActAt = 0;
      online = { room: m.room, me: m.you, players: m.players, canUndo: m.canUndo, seq: m.seq };
      net.rejoinWith({ t: 'join', clientId: clientId(), name: m.you.name, room: m.room });
      const u = new URL(location.href); u.searchParams.set('room', m.room); history_.replaceState(null, '', u);
      setNetMsg('');
      $('#setup-status').textContent = 'Loading cards…';
      beginWith(await withCards(m.state));
      renderRoom();
      break;
    }
    case 'act': {
      if (!online || !state || resync) break;
      if (m.seq !== online.seq + 1) { resync = true; dropPending(); net.send({ t: 'join', clientId: clientId(), name: online.me.name, room: online.room }); break; }
      lastActAt = Date.now();
      online.seq = m.seq; online.canUndo = m.canUndo;
      const mine = pending.has(m.nonce);
      if (!mine && m.a.t === 'END_COMBAT' && state.phase === 'combat') await strikeAnimation();
      if (m.a.t === 'CREATE' && !db[m.a.ref]) await ensure([m.a.ref]).catch(() => {});
      const prev = state;
      state = stampLog(reduce(state, m.a), m.by.name);
      renderAll(prev);
      if (!mine) cueRemote(m.a, prev);
      if (mine) { pending.get(m.nonce)({ before: prev }); pending.delete(m.nonce); }
      break;
    }
    case 'state': {
      if (!online || resync) break;
      if (m.seq !== online.seq + 1) { resync = true; dropPending(); net.send({ t: 'join', clientId: clientId(), name: online.me.name, room: online.room }); break; }
      online.seq = m.seq; online.canUndo = m.canUndo;
      if (m.reason === 'reset') { beginWith(await withCards(m.state)); toast(`${m.by?.name || 'Someone'} started a new game.`); }
      else { const prev = state; state = m.state; renderAll(prev); if (m.reason === 'undo') toast(`${m.by?.name || 'Someone'} pressed undo.`); }
      break;
    }
    case 'players': if (online) { online.players = m.players; renderRoom(); } break;
    case 'error':
      if (m.code === 'no-room') {
        online = null; net.rejoinWith(null);
        const u = new URL(location.href); u.searchParams.delete('room'); history_.replaceState(null, '', u);
        showSetup(); setNetMsg('That room doesn\'t exist (or has expired). Check the code.');
      } else if (m.code === 'room-full') setNetMsg('That room is full.');
      else if (m.code === 'no-undo') toast('Nothing to undo.');
      else if (m.code === 'busy') toast(m.msg);
      else if (m.code === 'bad-action') { if (pending.has(m.nonce)) { pending.get(m.nonce)({ before: null }); pending.delete(m.nonce); } else dropPending(); console.warn('server rejected an action:', m.msg); }
      else if (m.code === 'not-in-room') dropPending();
      else if (m.code === 'replaced') { net.close(); net = null; online = null; dropPending(); renderRoom(); showSetup(); setNetMsg('This game was opened in another tab.'); }
      else console.warn('server:', m);
      break;
  }
}

// What a player sees when someone else drives the game.
function cueRemote(a, prev) {
  if (a.t === 'START_HORDE_TURN' && prev.phase === 'horde-ready') banner(`HORDE TURN ${state.turn}`);
  else if (a.t === 'BEGIN_COMBAT' && a.ids.length && prev.phase !== 'combat') banner('THE HORDE ATTACKS');
  else if (a.t === 'END_SURVIVOR_TURN' && state.phase === 'setup') banner(`SETUP TURN ${4 - state.setupLeft}`);
  else if (a.t === 'PHASE' && a.phase === 'main' && madeTokenRefs().length) openTokens();
}

function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = text;
  document.body.appendChild(t);
  t.animate([{ opacity: 0, transform: 'translate(-50%, 10px)' }, { opacity: 1, transform: 'translate(-50%, 0)', offset: .1 }, { opacity: 1, offset: .85 }, { opacity: 0 }],
    { duration: 2600 }).onfinish = () => t.remove();
}

function renderRoom() {
  const chip = $('#room-chip');
  chip.hidden = !online;
  document.body.classList.toggle('in-room', !!online);
  if (!online) return;
  chip.querySelector('.code').textContent = online.room;
  chip.querySelector('.dot').className = 'dot ' + (netStatus === 'online' ? 'ok' : 'bad');
  chip.querySelector('.dot').title = netStatus === 'online' ? 'Connected' : 'Reconnecting…';
  $('#room-players').innerHTML = online.players.map(p =>
    `<span class="pl ${p.online ? '' : 'off'} ${p.id === online.me.id ? 'me' : ''}" title="${esc(p.name)}${p.online ? '' : ' (offline)'}">${esc(p.name.slice(0, 1).toUpperCase())}</span>`).join('');
  $('#btn-start').textContent = 'Start a new game for the room';
  $('#btn-create-room').hidden = true;
  $('#join-row').hidden = true;
  $('#btn-leave').hidden = false;
  $('#net-in').textContent = `You're in room ${online.room} as ${online.me.name}.`;
}

function leaveRoom() {
  if (net) { net.close(); net = null; }
  online = null; dropPending();
  const u = new URL(location.href); u.searchParams.delete('room'); history_.replaceState(null, '', u);
  $('#btn-start').textContent = 'Start game';
  $('#btn-create-room').hidden = false; $('#join-row').hidden = false; $('#btn-leave').hidden = true;
  $('#net-in').textContent = '';
  renderRoom();
  showSetup();
}

function joinRoom(code) {
  code = code.trim().toUpperCase();
  if (!code) return;
  saveName();
  setNetMsg('Joining…');
  ensureNet().send({ t: 'join', clientId: clientId(), name: myName(), room: code });
}

// Called by startGame with a freshly built state.
function launch(s) {
  if (online) { net.send({ t: 'reset', state: s }); return; }
  if (createWith) {
    createWith = null; saveName();
    setNetMsg('Creating room…');
    ensureNet().send({ t: 'create', clientId: clientId(), name: myName(), state: s });
    return;
  }
  beginWith(s);
}

$('#btn-create-room').addEventListener('click', () => { createWith = true; startGame(); });
$('#btn-join').addEventListener('click', () => joinRoom($('#net-code').value));
$('#net-code').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom($('#net-code').value); });
$('#btn-leave').addEventListener('click', () => { if (confirm('Leave this room? The game keeps going for the others.')) leaveRoom(); });
$('#room-chip').addEventListener('click', async () => {
  const link = location.href;
  try { await navigator.clipboard.writeText(link); toast('Invite link copied'); } catch { prompt('Invite link:', link); }
});
try { $('#net-name').value = localStorage.getItem('horde.name') || ''; } catch {}
{
  const code = new URL(location.href).searchParams.get('room');
  if (code) { $('#net-code').value = code; if ($('#net-name').value) setTimeout(() => joinRoom(code), 0); else setNetMsg('Enter your name, then press Join.'); }
}

/* =================== rendering =================== */
const PHASE_TEXT = {
  setup: s => `Setup · Survivors turn ${4 - s.setupLeft} of 3`,
  'horde-ready': s => `Horde turn ${s.turn + 1} is coming`,
  horde: s => `Horde turn ${s.turn}`,
  resolve: s => `Horde turn ${s.turn} · resolve spells`,
  main: s => `Horde turn ${s.turn} · main phase · add tokens and effects, then attack`,
  combat: s => `Horde turn ${s.turn} · combat · declare blockers`,
  survivors: s => `Survivors turn ${s.turn}`,
};

// Combat keywords read from the card's own keyword line in its rules text.
function kw(c) {
  const t = db[c.ref]?.text || '';
  const line = name => new RegExp(`^(?:[\\w' -]+, )*${name}\\b`, 'im');
  return {
    infect: line('infect').test(t),
    toxic: +(t.match(new RegExp(`^(?:[\\w' -]+, )*toxic (\\d+)`, 'im'))?.[1] || 0),
    poisonous: +(t.match(/^Poisonous (\d+)/im)?.[1] || 0),
  };
}

// What the unblocked attackers do to the Survivors.
function combatHits() {
  let damage = 0, poison = 0;
  for (const id of state.zones.battlefield) {
    const c = state.cards[id];
    if (!c.attacking || c.blocked) continue;
    const p = Math.max(0, power(state, db, c).p);
    const k = kw(c);
    if (k.infect) poison += p; else damage += p;
    if (p > 0) poison += k.toxic + k.poisonous;
  }
  return { damage, poison };
}
function incoming() { return combatHits().damage; }

// The Horde's turn is mid-way but nobody is driving it (this player isn't, and no action
// has arrived for a few seconds): offer to resume it.
let stallTimer = 0;
function hordeStalled() { return state?.phase === 'horde' && !busy && Date.now() - lastActAt > 4000; }

// Unblocked attackers lunge at the Survivors' life total along a curved path.
async function strikeAnimation() {
  const target = $('#life-box').getBoundingClientRect();
  const tx = target.left + target.width / 2, ty = target.top + target.height / 2;
  const els = [...document.querySelectorAll('#attack-lane .card')]
    .filter(el => el._ids?.some(id => state.cards[id] && !state.cards[id].blocked));
  if (!els.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const DUR = 620, GAP = Math.min(140, 700 / els.length);
  els.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    const dx = tx - (r.left + r.width / 2), dy = ty - (r.top + r.height / 2);
    const lift = -Math.min(180, Math.hypot(dx, dy) * 0.45);           // arc height
    const side = dx >= 0 ? 1 : -1;
    const frames = [{ transform: 'none', offset: 0 },
      { transform: `translate(${-dx * 0.06}px, ${-dy * 0.06 + 14}px) scale(1.12) rotate(${-side * 6}deg)`, offset: 0.28, easing: 'cubic-bezier(.5,0,.9,.5)' }];
    for (let k = 1; k <= 6; k++) {                                   // quadratic bezier: start -> lifted midpoint -> target
      const t = k / 6, u = 1 - t;
      const x = 2 * u * t * (dx / 2) + t * t * dx;
      const y = 2 * u * t * (dy / 2 + lift) + t * t * dy;
      frames.push({ transform: `translate(${x}px, ${y}px) scale(${1.12 - 0.35 * t}) rotate(${side * 14 * t}deg)`, offset: 0.28 + 0.72 * t });
    }
    el.style.zIndex = 50;
    el.animate(frames, { duration: DUR, delay: i * GAP, fill: 'forwards' });
    setTimeout(() => impact(tx, ty), i * GAP + DUR);
  });
  await wait((els.length - 1) * GAP + DUR + 60);
}
function impact(x, y) {
  const fx = document.createElement('div');
  fx.className = 'impact';
  fx.style.left = x + 'px'; fx.style.top = y + 'px';
  document.body.appendChild(fx);
  fx.animate([{ transform: 'translate(-50%,-50%) scale(.2)', opacity: 1 }, { transform: 'translate(-50%,-50%) scale(1.8)', opacity: 0 }],
    { duration: 420, easing: 'ease-out' }).onfinish = () => fx.remove();
  const box = $('#life-box');
  box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
}

async function resolveCombat() {
  if (busy) return;
  const hits = combatHits();
  busy = true;
  renderAll(state);
  await strikeAnimation();
  try { await dispatch({ t: 'END_COMBAT', damage: hits.damage, poison: hits.poison }); } finally { busy = false; renderAll(state); }
}

function renderAll(prev) {
  const s = state;
  render(s, db);
  document.body.className = document.body.className.replace(/\bphase-\S+/g, '').trim();
  document.body.classList.add('phase-' + s.phase);
  document.body.classList.toggle('has-board', s.zones.battlefield.length + s.zones.hand.length > 0);

  // life
  const ln = $('#life-num');
  ln.textContent = s.life;
  ln.classList.toggle('low', s.life <= Math.max(5, s.opts.life * 0.25));
  if (prev && prev.life !== s.life) floatNum(ln, s.life - prev.life);
  $('#poison-box').classList.toggle('on', s.deck.poison || s.poison > 0);
  $('#poison-num').textContent = s.poison;
  if (prev && prev.poison !== s.poison) floatNum($('#poison-num'), s.poison - prev.poison, true);
  $('#hlife-box').classList.toggle('on', s.hordeLife !== null);
  $('#hlife-num').textContent = s.hordeLife ?? '';
  $('#anthem-num').textContent = (s.anthem >= 0 ? '+' : '') + s.anthem;
  $('#dmg-sub').textContent = s.hordeLife ? `Hits Horde life first (${s.hordeLife})` : `Mills 1 card per damage · ${s.zones.library.length} left`;

  // phase + primary button
  $('#phase').textContent = PHASE_TEXT[s.phase]?.(s) || '';
  const btn = $('#btn-primary');
  btn.classList.remove('danger');
  btn.disabled = false;
  clearTimeout(stallTimer);
  if (!busy && s.phase === 'horde' && hordeStalled()) btn.textContent = 'Resume the Horde\'s turn';
  else if (busy || s.phase === 'horde') {
    btn.textContent = 'The Horde is playing…'; btn.disabled = true;
    if (!busy && s.phase === 'horde') stallTimer = setTimeout(() => state && renderAll(state), 1500);
  }
  else if (s.phase === 'setup') btn.textContent = s.setupLeft > 1 ? `End setup turn ${4 - s.setupLeft}` : 'End setup — the Horde awakens';
  else if (s.phase === 'resolve') { btn.textContent = 'Resolve the spells to continue'; btn.disabled = s.zones.stack.length > 0; if (!s.zones.stack.length) btn.textContent = 'Continue'; }
  else if (s.phase === 'main') btn.textContent = 'To combat ⚔';
  else if (s.phase === 'combat') {
    const { damage: n, poison: pz } = combatHits();
    const atk = s.zones.battlefield.some(id => s.cards[id].attacking);
    const parts = [n && `${n} damage`, pz && `${pz} poison`].filter(Boolean).join(' + ');
    btn.textContent = !atk ? 'No attackers — your turn' : parts ? `Take ${parts}` : 'All blocked — your turn';
    if (parts) btn.classList.add('danger');
  }
  else if (s.phase === 'survivors') btn.textContent = 'End turn — the Horde moves';
  else if (s.phase === 'horde-ready') btn.textContent = 'Start Horde turn';

  // spotlight
  const z = s.zones;
  $('#spot-title').textContent = z.reveal.length ? 'The Horde reveals…' : z.stack.length ? (z.stack.length > 1 ? 'Spells on the stack' : 'Spell on the stack') : '';

  if ($('#drawer-log').classList.contains('on')) renderLog();
  if ($('#drawer-tokens').classList.contains('on')) renderTokens();
  if ($('#viewer').classList.contains('on')) renderViewer();
  $('#btn-undo').disabled = busy || (online ? !online.canUndo || s.phase === 'horde' : !history.length);

  const st = status(s);
  if (st && !dismissed[st] && !busy) showResult(st);
}

function floatNum(anchor, d, good) {
  const r = anchor.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'float-num' + (d > 0 || good ? ' good' : '');
  el.textContent = (d > 0 ? '+' : '') + d;
  el.style.left = r.left + r.width / 2 - 20 + 'px';
  el.style.top = r.top - 10 + 'px';
  document.body.appendChild(el);
  el.animate([{ transform: 'translateY(0) scale(.6)', opacity: 0 }, { transform: 'translateY(-20px) scale(1.2)', opacity: 1, offset: .25 }, { transform: 'translateY(-60px)', opacity: 0 }],
    { duration: 1200, easing: 'ease-out' }).onfinish = () => el.remove();
  if (d < 0 && !good) {
    $('#vignette').animate([{ opacity: 0 }, { opacity: Math.min(1, -d / 8 + .3) }, { opacity: 0 }], { duration: 700 });
    const box = $('#life-box');
    box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
  }
}

function banner(text) {
  const b = $('#banner');
  b.querySelector('span').textContent = text;
  b.classList.remove('go-anim'); void b.offsetWidth; b.classList.add('go-anim');
}

function showResult(st) {
  $('#result-title').textContent = st === 'win' ? 'The Horde is defeated' : 'The Survivors have fallen';
  $('#result-title').style.color = st === 'win' ? 'var(--gold2)' : 'var(--blood2)';
  $('#result-text').textContent = st === 'win'
    ? `The library is empty and no attackers remain. You held out for ${state.turn} Horde turns.`
    : `The Horde overran you on turn ${state.turn}.`;
  $('#result').classList.add('on');
  $('#result').dataset.st = st;
}
$('#btn-keep').addEventListener('click', () => { dismissed[$('#result').dataset.st] = true; $('#result').classList.remove('on'); });
$('#btn-again').addEventListener('click', () => { $('#result').classList.remove('on'); localStorage.removeItem(SAVE); showSetup(); });

/* =================== the Horde's turn =================== */
const INTERRUPTED = new Error('interrupted');
// Like step(), but stops the sequence if the action was lost (disconnect, rejoin, rejected).
async function go(a, checkpoint = false) {
  const r = await dispatch(a, checkpoint);
  if (!r.before) throw INTERRUPTED;
  return r;
}

// Runs the Horde's turn. With resume=true it picks up a turn that stopped halfway
// (the player driving it disconnected or refreshed).
async function hordeTurn(resume = false) {
  if (busy) return;
  busy = true;
  renderAll(state);
  try {
    if (!resume) {
      const r = await go({ t: 'START_HORDE_TURN' }, true);    // one undo step for the whole turn
      if (r.before.phase !== 'horde-ready') return;            // someone else already started it
      banner(`HORDE TURN ${state.turn}`);
      await wait(1000);
      if (state.zones.hand.length || state.zones.graveyard.some(id => state.cards[id].flashback)) {
        await go({ t: 'GATHER_CASTS' });
        await wait(700);
      }
    }
    const isToken = id => state.cards[id]?.token;
    let done = resume ? state.zones.reveal.filter(id => !isToken(id)).length : 0;   // non-token reveals so far
    for (let d = done; d < state.opts.draws; d++) {
      while (state.zones.library.length) {
        await go({ t: 'REVEAL' });
        await wait(state.zones.reveal.length > 6 ? 200 : 380);
        if (!isToken(state.zones.reveal.at(-1))) break;
      }
    }
    await wait(700);
    await go({ t: 'CAST_REVEALED' });
    await wait(650);
    if (state.phase !== 'horde') return;
    if (state.zones.stack.length) await go({ t: 'PHASE', phase: 'resolve', from: 'horde' });
    else await enterMain('horde');
  } catch (err) {
    if (err !== INTERRUPTED) throw err;
  } finally { busy = false; renderAll(state); }
}

// Pause after casting so the Survivors can apply what the new cards do
// (tokens, counters, anthems) before the Horde attacks.
function openTokens() {
  $$('.drawer').forEach(x => x.classList.remove('on'));
  $('#drawer-tokens').classList.add('on');
  renderTokens();
}
async function enterMain(from = state.phase) {
  const r = await step({ t: 'PHASE', phase: 'main', from });
  if (r.before?.phase === from && madeTokenRefs().length) openTokens();
}

async function beginCombat() {
  const ids = state.zones.battlefield.filter(id => canAttack(state, state.cards[id]));
  const r = await step({ t: 'BEGIN_COMBAT', ids });
  if (ids.length && r.before?.phase !== 'combat') banner('THE HORDE ATTACKS');
}

async function primary() {
  if (busy || !state) return;
  const p = state.phase;
  if (p === 'setup' || p === 'survivors') {
    busy = true;
    let r;
    try { r = await dispatch({ t: 'END_SURVIVOR_TURN', setupLeft: state.setupLeft }); } finally { busy = false; renderAll(state); }
    if (r.before?.phase !== p || r.before.setupLeft !== state.setupLeft + (p === 'setup' ? 1 : 0)) return; // someone else pressed it first
    if (state.phase === 'horde-ready') hordeTurn();
    else banner(`SETUP TURN ${4 - state.setupLeft}`);
  }
  else if (p === 'horde-ready') hordeTurn();
  else if (p === 'horde' && hordeStalled()) hordeTurn(true);
  else if (p === 'resolve' && !state.zones.stack.length) enterMain('resolve');
  else if (p === 'main') { $('#drawer-tokens').classList.remove('on'); beginCombat(); }
  else if (p === 'combat') resolveCombat();
}
$('#btn-primary').addEventListener('click', primary);

/* =================== HUD controls =================== */
document.querySelector('.hud').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || !state) return;
  const mult = e.shiftKey ? 5 : 1;
  if (b.dataset.life) dispatch({ t: 'LIFE', d: +b.dataset.life * mult });
  else if (b.dataset.poison) dispatch({ t: 'POISON', d: +b.dataset.poison });
  else if (b.dataset.hlife) dispatch({ t: 'HORDE_LIFE', d: +b.dataset.hlife * mult });
  else if (b.dataset.anthem) dispatch({ t: 'ANTHEM', d: +b.dataset.anthem });
  else if (b.dataset.dmg) { const i = $('#dmg-num'); i.value = Math.max(1, (+i.value || 1) + +b.dataset.dmg * mult); }
  else if (b.id === 'btn-dmg') { const n = Math.max(1, +$('#dmg-num').value || 1); dispatch({ t: 'DAMAGE_HORDE', n }); $('#dmg-num').value = 1; }
  else if (b.id === 'btn-block-all') dispatch({ t: 'BLOCK', ids: state.zones.battlefield.filter(id => state.cards[id].attacking), v: true });
  else if (b.id === 'btn-block-none') dispatch({ t: 'BLOCK', ids: state.zones.battlefield.filter(id => state.cards[id].attacking), v: false });
});
$('#life-box').addEventListener('wheel', e => { e.preventDefault(); if (state) dispatch({ t: 'LIFE', d: e.deltaY < 0 ? 1 : -1 }); }, { passive: false });

/* =================== card actions =================== */
function castIds(ids) {
  const spells = ids.filter(id => state.cards[id].spell), perms = ids.filter(id => !state.cards[id].spell);
  const done = [];
  if (spells.length) done.push(dispatch({ t: 'MOVE', ids: spells, to: 'stack' }));
  if (perms.length) done.push(dispatch({ t: 'MOVE', ids: perms, to: 'battlefield' }));
  return Promise.all(done);
}

function afterResolve() {
  if (state.phase === 'resolve' && !state.zones.stack.length) setTimeout(() => { if (state.phase === 'resolve' && !state.zones.stack.length) enterMain('resolve'); }, 450);
}

document.addEventListener('click', e => {
  const b = e.target.closest('.act');
  if (!b || !state) return;
  e.stopPropagation();
  const card = b.closest('.card');
  const ids = card._ids;
  const c = state.cards[ids[0]];
  switch (b.dataset.act) {
    case 'block': dispatch({ t: 'BLOCK', ids: [ids[0]], v: true }); break;
    case 'unblock': dispatch({ t: 'BLOCK', ids: [ids[0]], v: false }); break;
    case 'kill': dispatch({ t: 'MOVE', ids: [ids[0]], to: 'graveyard' }); break;
    case 'resolve': dispatch({ t: 'RESOLVE_STACK', id: c.id }).then(afterResolve); break;
    case 'counter': dispatch({ t: 'RESOLVE_STACK', id: c.id, countered: true }).then(afterResolve); break;
  }
});

function itemsFor(ids, zone) {
  const c = state.cards[ids[0]];
  const I = (label, fn, extra = {}) => ({ label, fn, ...extra });
  const mv = (to, pos) => k => dispatch({ t: 'MOVE', ids: ids.slice(0, k), to, pos });
  const out = [];
  if (!c.token && db[c.ref]?.parts?.length) out.push(I('Create its tokens…', () => openTokens()));
  if (zone === 'battlefield') {
    out.push(I(c.tapped ? 'Untap' : 'Tap', k => dispatch({ t: 'TAP', ids: ids.slice(0, k), v: !c.tapped }), { kbd: 'T' }));
    if (c.creature) {
      out.push(I('Add +1/+1 counter', k => dispatch({ t: 'COUNTER', ids: ids.slice(0, k), d: 1 })));
      if (c.counters) out.push(I(c.counters > 0 ? 'Remove +1/+1 counter' : 'Remove −1/−1 counter', k => dispatch({ t: 'COUNTER', ids: ids.slice(0, k), d: c.counters > 0 ? -1 : 1 })));
      else out.push(I('Add −1/−1 counter', k => dispatch({ t: 'COUNTER', ids: ids.slice(0, k), d: -1 })));
    }
    if (state.phase === 'combat' && c.creature) {
      out.push(c.attacking
        ? I('Remove from combat', k => dispatch({ t: 'ATTACK', ids: ids.slice(0, k), v: false }))
        : I('Add to the attack', k => dispatch({ t: 'ATTACK', ids: ids.slice(0, k), v: true })));
      if (c.attacking) out.push(I(c.blocked ? 'Unblock' : 'Block', k => dispatch({ t: 'BLOCK', ids: ids.slice(0, k), v: !c.blocked })));
    }
    out.push('sep');
    out.push(I(c.creature ? 'Destroy' : 'Destroy / sacrifice', mv('graveyard'), { danger: true, kbd: 'D' }));
    out.push(I('Exile', mv('exile'), { kbd: 'E' }));
    out.push(I('Return to Horde hand', mv('hand'), { hint: 'recast next turn' }));
    out.push(I('Put on top of library', mv('library', 'top')));
    out.push(I('Put on bottom of library', mv('library', 'bottom')));
    if (c.token) { out.push('sep'); out.push(I('Create more of this token', k => dispatch({ t: 'CREATE', ref: c.ref, name: c.name, creature: c.creature, n: k }))); }
  } else if (zone === 'stack') {
    out.push(I('Resolved', () => { dispatch({ t: 'RESOLVE_STACK', id: c.id }).then(afterResolve); }));
    out.push(I('Countered', () => { dispatch({ t: 'RESOLVE_STACK', id: c.id, countered: true }).then(afterResolve); }));
    out.push(I('Exile it', () => { dispatch({ t: 'MOVE', ids: [c.id], to: 'exile' }).then(afterResolve); }));
  } else if (zone === 'reveal') {
    return [];
  } else {
    // hand, graveyard, exile, library
    out.push(I(c.spell ? 'Cast it now' : 'Put onto the battlefield', k => castIds(ids.slice(0, k))));
    if (zone !== 'hand') out.push(I("Put into Horde's hand", mv('hand')));
    if (zone !== 'graveyard') out.push(I(zone === 'hand' ? 'Discard' : 'Put into graveyard', mv('graveyard'), { danger: zone === 'hand' }));
    if (zone !== 'exile') out.push(I('Exile', mv('exile')));
    out.push(I('Put on top of library', mv('library', 'top')));
    out.push(I('Put on bottom of library', mv('library', 'bottom')));
  }
  return out;
}

/* =================== menus =================== */
let menuState = null;
function openMenu(x, y, { title, max = 1, items }) {
  if (!items.length) return;
  const m = $('#menu');
  menuState = { amt: 1, max, items };
  const draw = () => {
    m.innerHTML = `<h5><span>${esc(title)}</span>${max > 1 ? `<span>×${max}</span>` : ''}</h5>` +
      (max > 1 ? `<div class="amt">Apply to <button class="step sm" data-amt="-1">−</button><b>${menuState.amt}</b><button class="step sm" data-amt="1">+</button><button class="chip" data-amt="all">All</button></div>` : '') +
      items.map((it, i) => it === 'sep' ? '<div class="sep"></div>'
        : `<button class="mi ${it.danger ? 'danger' : ''}" data-i="${i}"><span>${esc(it.label)}</span>${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : it.kbd ? `<kbd>${it.kbd}</kbd>` : ''}</button>`).join('');
  };
  draw();
  m._draw = draw;
  m.classList.add('on');
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
}
function closeMenu() { $('#menu').classList.remove('on'); menuState = null; }
$('#menu').addEventListener('click', e => {
  const a = e.target.closest('[data-amt]');
  if (a) {
    const v = a.dataset.amt;
    menuState.amt = v === 'all' ? menuState.max : Math.max(1, Math.min(menuState.max, menuState.amt + +v * (e.shiftKey ? 5 : 1)));
    $('#menu')._draw();
    return;
  }
  const b = e.target.closest('.mi');
  if (!b) return;
  const it = menuState.items[+b.dataset.i];
  const k = menuState.amt;
  closeMenu();
  it.fn(k);
});
document.addEventListener('pointerdown', e => { if (!e.target.closest('#menu')) closeMenu(); }, true);

function openCardMenu(card, x, y) {
  if (busy) return;
  const ids = card._ids;
  const c = state.cards[ids[0]];
  const zone = zoneOf(state, ids[0]);
  openMenu(x, y, { title: c.name, max: ids.length, items: itemsFor(ids, zone) });
}

/* piles */
$('#pile-library').addEventListener('click', e => {
  if (!state || busy) return;
  const n = state.zones.library.length;
  if (!n) return;
  openMenu(e.clientX, e.clientY, {
    title: 'Horde library', max: n, items: [
      { label: 'Mill', fn: k => dispatch({ t: 'MILL', n: k }), kbd: 'M' },
      { label: 'Exile from the top', fn: k => dispatch({ t: 'MOVE', ids: state.zones.library.slice(0, k), to: 'exile' }) },
      { label: 'Draw into Horde hand', fn: k => dispatch({ t: 'DRAW', n: k }), hint: 'cast next turn' },
      { label: 'Reveal and cast now', fn: async k => {
        busy = true;
        try {
          for (let i = 0; i < k; i++) { await dispatch({ t: 'REVEAL' }, i === 0); await wait(350); }
          await wait(500); await step({ t: 'CAST_REVEALED' });
        } finally { busy = false; renderAll(state); }
      } },
      'sep',
      { label: 'Search the library', fn: () => openViewer('library') },
      { label: 'Shuffle', fn: () => dispatch({ t: 'SHUFFLE', order: shuffle(state.zones.library) }) },
    ],
  });
});
$('#pile-graveyard').addEventListener('click', () => state && openViewer('graveyard'));
$('#pile-exile').addEventListener('click', () => state && openViewer('exile'));

/* zone viewer */
let viewerZone = null;
function openViewer(zone) {
  viewerZone = zone;
  $('#viewer').classList.add('on');
  renderViewer();
}
function renderViewer() {
  const z = viewerZone;
  const ids = z === 'library' ? state.zones.library : [...state.zones[z]].reverse();
  $('#viewer-title').textContent = { library: 'Horde library (top first)', graveyard: 'Horde graveyard', exile: 'Exile' }[z] + ` · ${ids.length}`;
  $('#viewer-grid').innerHTML = ids.length ? ids.map(id => {
    const c = state.cards[id], d = db[c.ref];
    return `<div class="vcard" data-id="${id}">${d?.img ? `<img src="${d.img}" alt="${esc(c.name)}" loading="lazy">` : ''}<span>${esc(c.name)}</span></div>`;
  }).join('') : '<p style="color:var(--ink3)">Empty.</p>';
}
$('#viewer-grid').addEventListener('click', e => {
  const v = e.target.closest('.vcard');
  if (!v) return;
  const id = +v.dataset.id;
  openMenu(e.clientX, e.clientY, { title: state.cards[id].name, items: itemsFor([id], viewerZone) });
});

/* =================== drawers =================== */
function toggleDrawer(id) {
  const d = $(id);
  const on = !d.classList.contains('on');
  $$('.drawer').forEach(x => x.classList.remove('on'));
  if (on) { d.classList.add('on'); id === '#drawer-log' ? renderLog() : renderTokens(); }
}
$('#btn-tokens').addEventListener('click', () => state && toggleDrawer('#drawer-tokens'));
$('#btn-tokens-hud').addEventListener('click', () => state && toggleDrawer('#drawer-tokens'));
$('#btn-log').addEventListener('click', () => state && toggleDrawer('#drawer-log'));
$('#btn-undo').addEventListener('click', undo);
$('#btn-menu').addEventListener('click', () => { if (confirm('Leave this game and set up a new one? (Your current game stays saved until you start another.)')) showSetup(); });
document.addEventListener('click', e => {
  if (e.target.closest('[data-close]')) {
    e.target.closest('.drawer, .modal').classList.remove('on');
  } else if (e.target.classList.contains('modal') && e.target.id === 'viewer') e.target.classList.remove('on');
});

function renderLog() {
  let last = -1, html = '';
  for (const l of state.log) {
    if (l.turn !== last) { html += `<li class="turn">${l.turn ? 'Horde turn ' + l.turn : 'Setup'}</li>`; last = l.turn; }
    html += `<li>${l.by ? `<b class="by">${esc(l.by)}:</b> ` : ''}${esc(l.msg)}</li>`;
  }
  const ol = $('#log-list');
  ol.innerHTML = html;
  ol.scrollTop = ol.scrollHeight;
}

let tokenSearch = [];
// Tokens that non-token cards on the battlefield (or cast this turn) can create.
function madeTokenRefs() {
  if (!state) return [];
  const srcIds = [...state.zones.battlefield, ...(state.lastCast || [])];
  const out = new Map();
  for (const id of srcIds) {
    const c = state.cards[id];
    if (!c || c.token) continue;
    for (const r0 of db[c.ref]?.parts || []) {
      // Prefer an identical token the deck already uses, so they share one stack.
      const t = db[r0];
      const same = t && [...(state.deck.tokenRefs || []), ...state.zones.battlefield.map(i => state.cards[i].ref)]
        .find(d => db[d] && db[d].name === t.name && db[d].power === t.power && db[d].toughness === t.toughness && db[d].type === t.type);
      const r = same || r0;
      if (!out.has(r)) out.set(r, new Set());
      out.get(r).add(c.name);
    }
  }
  return [...out].map(([ref, from]) => ({ ref, from: [...from].join(', ') }));
}

function tokenRow(ref, from) {
  const d = db[ref];
  if (!d) return from ? `<p class="drawer-sub">Loading a token made by ${esc(from)}…</p>` : '';
  const onBoard = state.zones.battlefield.filter(id => state.cards[id].ref === ref).length;
  const pt = d.power != null ? `${d.power}/${d.toughness} ` : '';
  return `<div class="tok" data-ref="${ref}"><img src="${d.art || d.img || ''}" alt="">
    <div><div class="nm">${esc(d.name)}</div>${from ? `<div class="from">from ${esc(from)}</div>` : ''}<div class="ty">${esc(pt + d.type.replace(/^Token /, ''))}${onBoard ? ` · <b style="color:var(--gold2)">${onBoard} in play</b>` : ''}</div></div>
    <div class="btns"><button data-n="-1" title="Remove one">−1</button><button data-n="1">+1</button><button data-n="5">+5</button><button data-n="10">+10</button></div></div>`;
}
function renderTokens() {
  const deckRefs = state.deck.tokenRefs || [];
  const boardRefs = [...new Set(state.zones.battlefield.map(id => state.cards[id]).filter(c => c.token).map(c => c.ref))].filter(r => !deckRefs.includes(r));
  const made = madeTokenRefs();
  const missing = made.map(m => m.ref).filter(r => !db[r]);
  if (missing.length) ensure(missing).then(() => $('#drawer-tokens').classList.contains('on') && renderTokens()).catch(() => {});
  let html = '';
  if (made.length) html += `<div class="tok-section hot">Made by cards in play or just cast</div>` +
    made.map(m => tokenRow(m.ref, m.from)).join('');
  if (deckRefs.length) html += `<div class="tok-section">This Horde's tokens</div>` + deckRefs.map(r => tokenRow(r)).join('');
  if (boardRefs.length) html += `<div class="tok-section">Other tokens in play</div>` + boardRefs.map(r => tokenRow(r)).join('');
  if (tokenSearch.length) html += `<div class="tok-section">Search results</div>` + tokenSearch.map(c => tokenRow(c.id)).join('');
  $('#token-list').innerHTML = html;
}
$('#token-list').addEventListener('click', e => {
  const b = e.target.closest('button[data-n]');
  if (!b) return;
  const ref = b.closest('.tok').dataset.ref;
  const n = +b.dataset.n;
  const d = db[ref];
  if (n > 0) dispatch({ t: 'CREATE', ref, name: d.name.replace(/ Token$/, ''), creature: /Creature/.test(d.type), n });
  else {
    const id = state.zones.battlefield.find(i => state.cards[i].ref === ref && !state.cards[i].attacking) ?? state.zones.battlefield.find(i => state.cards[i].ref === ref);
    if (id) dispatch({ t: 'MOVE', ids: [id], to: 'graveyard' });
  }
});
async function doTokenSearch() {
  const q = $('#token-q').value.trim();
  if (!q) return;
  $('#token-go').textContent = '…';
  tokenSearch = await searchTokens(q).catch(() => []);
  $('#token-go').textContent = 'Search';
  if (!tokenSearch.length) { $('#token-list').insertAdjacentHTML('afterbegin', '<p class="drawer-sub">No tokens found.</p>'); return; }
  renderTokens();
}
$('#token-go').addEventListener('click', doTokenSearch);
$('#token-q').addEventListener('keydown', e => { if (e.key === 'Enter') doTokenSearch(); });

/* =================== zoom preview =================== */
let zoomFor = null, zoomTimer = 0;
function cardIdOf(t) {
  if (t.classList.contains('card')) return t._ids?.[0];
  if (t.classList.contains('vcard')) return +t.dataset.id;
  const pile = t.closest('.pile');
  if (pile && state) { const z = state.zones[pile.id.replace('pile-', '')]; return z.at(-1); }
}
function showZoom(t) {
  const id = cardIdOf(t);
  const c = state?.cards[id];
  if (!c) return;
  const d = db[c.ref] || {};
  const z = $('#zoom');
  const img = z.querySelector('img');
  if (d.large || d.img) img.src = d.large || d.img; else img.removeAttribute('src');
  const tags = [];
  const n = t._ids?.length || 1;
  if (n > 1) tags.push(`<span class="tag hot">${n} in this stack</span>`);
  if (c.token) tags.push('<span class="tag">Token</span>');
  const zone = zoneOf(state, id);
  if (c.creature && zone === 'battlefield') {
    const { p, t: tt } = power(state, db, c);
    tags.push(`<span class="tag hot">${p}/${tt}</span>`);
    if (c.cantAttack) tags.push('<span class="tag">Can\'t attack or block</span>');
    else if (!canAttack(state, { ...c, tapped: false })) tags.push('<span class="tag">Summoning sick</span>');
    else tags.push('<span class="tag">Haste</span>');
  }
  if (c.flashback) tags.push('<span class="tag">Recast from graveyard</span>');
  z.querySelector('.zoom-info').innerHTML = `<h4>${esc(d.name || c.name)} <span class="t">${esc(d.cost || '')}</span></h4><div class="t">${esc(d.type || '')}</div>${d.text ? `<div class="o">${esc(d.text)}</div>` : ''}<div class="tags">${tags.join('')}</div>`;
  const r = t.getBoundingClientRect();
  z.classList.toggle('left', r.left + r.width / 2 > innerWidth * 0.58);
  z.classList.add('on');
}
function hideZoom() { $('#zoom').classList.remove('on'); zoomFor = null; clearTimeout(zoomTimer); }
const ZOOMABLE = '.card:not(.ghost), .vcard, #pile-graveyard .pile-top.has, #pile-exile .pile-top.has';
document.addEventListener('pointerover', e => {
  if (e.pointerType === 'touch') return;
  const t = e.target.closest(ZOOMABLE);
  if (!t || t === zoomFor || drag?.started || $('#menu').classList.contains('on')) return;
  zoomFor = t;
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => zoomFor === t && showZoom(t), 140);
});
document.addEventListener('pointerout', e => {
  const t = e.target.closest(ZOOMABLE);
  if (t && !t.contains(e.relatedTarget)) hideZoom();
});

/* =================== drag & drop =================== */
let drag = null;
document.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !state) return;
  const card = e.target.closest('.card');
  if (!card || card.classList.contains('ghost') || e.target.closest('.act')) return;
  drag = { card, x: e.clientX, y: e.clientY, started: false, shift: e.shiftKey, touch: e.pointerType === 'touch', t0: Date.now() };
  if (drag.touch) drag.lp = setTimeout(() => { if (drag && !drag.started) { showZoom(card); drag.zoomed = true; } }, 450);
});
document.addEventListener('pointermove', e => {
  if (!drag) return;
  if (!drag.started) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 7) return;
    clearTimeout(drag.lp);
    if (busy || drag.card._ent.cont === 'reveal-lane') { drag = null; return; }
    startDrag();
  }
  const g = drag.ghost;
  g.style.left = e.clientX - drag.ox + 'px';
  g.style.top = e.clientY - drag.oy + 'px';
  const hot = dropTarget(e.clientX, e.clientY);
  if (hot !== drag.hot) { drag.hot?.classList.remove('drop-hot'); hot?.classList.add('drop-hot'); drag.hot = hot; }
});
function startDrag() {
  hideZoom(); closeMenu();
  const r = drag.card.getBoundingClientRect();
  const g = document.createElement('div');
  g.className = 'drag-ghost';
  g.style.width = r.width + 'px';
  const src = drag.card.querySelector('img')?.src;
  g.innerHTML = src ? `<img src="${src}" style="width:100%;border-radius:5px;display:block">` : `<div class="card" style="--cw:${r.width}px">${drag.card.innerHTML}</div>`;
  if (drag.card._ids.length > 1) g.insertAdjacentHTML('beforeend', `<div class="badge count" style="display:block">${drag.shift ? '×' + drag.card._ids.length : '×1'}</div>`);
  document.body.appendChild(g);
  drag.ghost = g; drag.ox = drag.x - r.left; drag.oy = drag.y - r.top;
  drag.started = true;
  drag.card.style.opacity = drag.card._ids.length > 1 && !drag.shift ? '' : '.3';
  document.body.classList.add('dragging');
}
function dropTarget(x, y) {
  const el = document.elementFromPoint(x, y);
  return el?.closest('[data-drop]') || null;
}
document.addEventListener('pointerup', e => {
  if (!drag) return;
  const d = drag;
  drag = null;
  clearTimeout(d.lp);
  if (!d.started) {
    if (d.zoomed) { hideZoom(); return; }
    if (!e.target.closest('.act')) openCardMenu(d.card, e.clientX, e.clientY);
    return;
  }
  document.body.classList.remove('dragging');
  d.hot?.classList.remove('drop-hot');
  const gr = d.ghost.getBoundingClientRect();
  d.ghost.remove();
  d.card.style.opacity = '';
  const target = dropTarget(e.clientX, e.clientY);
  if (!target) return;
  const to = target.dataset.drop;
  const ids = d.shift ? d.card._ids : [d.card._ids[0]];
  const from = zoneOf(state, ids[0]);
  if (to === from) return;
  // Start the FLIP from where the card was dropped.
  if (ids.length === d.card._ids.length) {
    const cr = d.card.getBoundingClientRect();
    d.card.style.transform = `translate(${gr.left - cr.left}px, ${gr.top - cr.top}px)`;
  }
  (to === 'battlefield' && from !== 'battlefield' ? castIds(ids) : dispatch({ t: 'MOVE', ids, to, pos: 'top' })).then(afterResolve);
});

/* =================== keyboard =================== */
document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea')) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (e.key === 'Escape') { closeMenu(); hideZoom(); $$('.drawer.on, #viewer.on').forEach(x => x.classList.remove('on')); return; }
  if ((e.key === ' ' || e.key === 'Enter') && state && $('#setup').classList.contains('off') && !$('#result').classList.contains('on')) {
    e.preventDefault(); primary();
  }
});

/* =================== boot =================== */
showSetup();
loadDeckArt();
