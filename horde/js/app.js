import { DECKS, parseDeck, buildLibrary, shuffle } from './deck.js?v=18';
import { db, ensure, resolveNames, searchTokens, resolveDeck } from './scryfall.js?v=18';
import { parseDecklist } from './decklist.js?v=18';
import { initState, reduce, zoneOf, canAttack, status, PILES, survivorSick, seatOf } from './game.js?v=18';
import { render, resetView, power, esc, hasKw, face, isWalker, autoLane } from './view.js?v=18';
import { stampLog } from './stamp.js?v=18';
import { connectNet, clientId } from './net.js?v=18';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const wait = ms => new Promise(r => setTimeout(r, ms));
const SAVE = 'horde.save.v1';

let state = null;
let history = [];
const history_ = window.history;  // the browser's, since `history` is our undo stack
let busy = false;
let dismissed = {};
let viewSeat = null;          // whose Survivor board the dock shows
let tokOwner = 'horde';       // who the Tokens drawer creates tokens for
function mySeat() { return online ? online.me.id : 'local'; }
function myDisplayName() { return online ? online.me.name : (($('#net-name').value || '').trim() || 'You'); }

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

// Custom Hordes the player saved (this browser only): [{ key: 'u:…', name, text }]
const SAVED_KEY = 'horde.customDecks';
let savedDecks = [];
try { savedDecks = JSON.parse(localStorage.getItem(SAVED_KEY)) || []; } catch {}
function storeSaved() { try { localStorage.setItem(SAVED_KEY, JSON.stringify(savedDecks)); } catch {} }
const savedOf = key => savedDecks.find(d => d.key === key);
const deckText = {};

function renderOpts() {
  $('#opts').innerHTML = OPTS.map(o => `<div class="opt"><label>${o.label}</label><div class="seg">${
    o.vals.map(([v, t]) => `<button data-k="${o.k}" data-v="${v}" class="${opts[o.k] === v ? 'on' : ''}">${t}</button>`).join('')}</div></div>`).join('')
    + `<div class="opt">${TOGGLES.map(t => `<label class="toggle"><input type="checkbox" data-t="${t.k}" ${opts[t.k] ? 'checked' : ''}>${t.label}</label>`).join('')}</div>`;
}
// Every choice, in carousel order: the original Hordes, community ones, saved custom lists, a new list.
function deckOrder() {
  return [...DECKS.filter(d => !d.community).map(d => d.key), ...DECKS.filter(d => d.community).map(d => d.key), ...savedDecks.map(d => d.key), 'custom'];
}
function renderDecks() {
  // the mini pictures: every Horde, then saved lists and a new custom list
  const tile = (key, name, art, mark = '') =>
    `<button class="deck ${selDeck === key ? 'sel' : ''} ${art ? '' : 'custom-tile'}" data-deck="${esc(key)}" title="${esc(name)}" style="${art ? `background-image:url('${art}')` : ''}">${mark}</button>`;
  const html = DECKS.filter(d => !d.community).map(d => tile(d.key, d.name, d.feature && db[d.feature]?.art)).join('')
    + `<span class="thumb-sep"></span>`
    + DECKS.filter(d => d.community).map(d => tile(d.key, `${d.name} (by ${d.author})`, d.feature && db[d.feature]?.art)).join('')
    + `<span class="thumb-sep"></span>`
    + savedDecks.map(d => tile(d.key, d.name, null, `<b>${esc(d.name.slice(0, 1).toUpperCase())}</b>`)).join('')
    + tile('custom', 'Custom list', null, '<b>+</b>');
  if ($('#deck-grid').innerHTML !== html) $('#deck-grid').innerHTML = html;
  const sel = $('#deck-grid .sel');
  if (sel) {                       // keep the chosen one centred in the strip
    const g = $('#deck-grid'), gr = g.getBoundingClientRect(), r = sel.getBoundingClientRect();
    g.scrollTo({ left: g.scrollLeft + (r.left + r.width / 2) - (gr.left + gr.width / 2), behavior: 'smooth' });
  }

  // the big picture, cross-faded
  const d = DECKS.find(x => x.key === selDeck), sv = savedOf(selDeck);
  const art = d?.feature ? db[d.feature]?.art || '' : '';
  const hero = $('#hero');
  hero.classList.toggle('plain', !art);
  if (hero.dataset.key !== selDeck || hero.dataset.art !== art) {
    const first = !hero.dataset.key;
    hero.dataset.key = selDeck; hero.dataset.art = art;
    const front = hero.dataset.front || 'a', next = first ? front : front === 'a' ? 'b' : 'a';
    $('#art-' + next).style.backgroundImage = art ? `url('${art}')` : '';
    if (!first) { $('#art-' + next).classList.remove('out'); $('#art-' + front).classList.add('out'); hero.dataset.front = next; }
    else hero.dataset.front = front;
  }
  $('#hero-name').textContent = d ? d.name : sv ? sv.name : 'Custom list';
  $('#hero-credit').innerHTML = d?.community ? `by ${esc(d.author || 'unknown')}${d.source ? ` · <a href="${d.source}" target="_blank" rel="noopener">original deck</a>` : ''}` : '';

  $('#custom-box').hidden = selDeck !== 'custom' && !sv;
  $('#custom-del').hidden = !sv;
  if (sv && $('#custom-box').dataset.for !== sv.key) { $('#custom-name').value = sv.name; $('#custom-text').value = sv.text; }
  if (selDeck === 'custom' && $('#custom-box').dataset.for !== 'custom') { $('#custom-name').value = ''; $('#custom-text').value = ''; }
  $('#custom-box').dataset.for = selDeck;
}
function selectDeck(key) {
  selDeck = key;
  const def = DECKS.find(x => x.key === selDeck);
  if (def?.preset) { Object.assign(opts, def.preset); renderOpts(); }   // e.g. a deck that needs Horde life
  renderDecks();
}
function stepDeck(d) {
  const order = deckOrder();
  selectDeck(order[(order.indexOf(selDeck) + d + order.length) % order.length]);
}
$('#hero').addEventListener('click', e => { const b = e.target.closest('[data-nav]'); if (b) stepDeck(+b.dataset.nav); });
// swipe on touch screens
let swipeX = null;
$('#hero').addEventListener('pointerdown', e => { if (e.pointerType === 'touch' && !e.target.closest('.s-settings, .s-custom, .s-thumbs')) swipeX = e.clientX; });
$('#hero').addEventListener('pointerup', e => { if (swipeX != null && Math.abs(e.clientX - swipeX) > 50) stepDeck(e.clientX < swipeX ? 1 : -1); swipeX = null; });
document.addEventListener('keydown', e => {
  if ($('#setup').classList.contains('off') || e.target.matches?.('input, textarea, select')) return;
  if (e.key === 'ArrowRight') stepDeck(1); else if (e.key === 'ArrowLeft') stepDeck(-1);
});
$('#opts').addEventListener('click', e => {
  const b = e.target.closest('button[data-k]');
  if (!b) return;
  const k = b.dataset.k, v = +b.dataset.v;
  opts[k] = v;
  if (k === 'players') { opts.life = 20 * v; opts.size = PRESET_SIZE[v]; }
  renderOpts();
});
$('#opts').addEventListener('change', e => { if (e.target.dataset.t) opts[e.target.dataset.t] = e.target.checked; });
$('#custom-del').addEventListener('click', () => {
  const sv = savedOf(selDeck);
  if (!sv || !confirm(`Delete the saved Horde "${sv.name}"?`)) return;
  savedDecks = savedDecks.filter(d => d !== sv); storeSaved();
  selDeck = 'custom'; renderDecks();
});
$('#deck-grid').addEventListener('click', e => { const b = e.target.closest('[data-deck]'); if (b) selectDeck(b.dataset.deck); });

async function loadDeckArt() {
  try {
    await Promise.all(DECKS.map(async d => {
      deckText[d.key] = await fetch(d.file).then(r => r.text());
      const s = parseDeck(deckText[d.key]);
      d.feature = d.art || (s.strong[0] || s.main.find(e => e.type === 'creature') || s.main[0])?.ref;
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

// One button: create a room with this Horde (or, already in a room, start a new game for it).
$('#btn-start').addEventListener('click', () => { if (!online) createWith = true; startGame(); });
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
      const nm = $('#custom-name').value.trim();
      def = { key: 'custom', name: nm || 'Custom', haste: 'all', rules: 'All creatures controlled by the Horde have haste.' };
      if (nm && text.trim()) {             // save / update this Horde for next time
        const sv = savedOf(selDeck) || savedDecks.find(d => d.name === nm);
        if (sv) { sv.name = nm; sv.text = text; } else savedDecks.push({ key: 'u:' + Date.now().toString(36), name: nm, text });
        storeSaved();
      }
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
      if (!state.seats?.[m.you.id]) dispatch({ t: 'SEAT', seat: m.you.id, name: m.you.name }, false);
      break;
    }
    case 'act': {
      if (!online || !state || resync) break;
      if (m.seq !== online.seq + 1) { resync = true; dropPending(); net.send({ t: 'join', clientId: clientId(), name: online.me.name, room: online.room }); break; }
      lastActAt = Date.now();
      online.seq = m.seq; online.canUndo = m.canUndo;
      const mine = pending.has(m.nonce);
      if (!mine && m.a.t === 'END_COMBAT' && state.phase === 'combat') await strikeAnimation();
      if (!mine && m.a.t === 'SURVIVOR_ATTACK') { banner('THE SURVIVORS STRIKE'); await survivorStrike(m.a.ids || []); }
      if (m.a.t === 'CREATE' && !db[m.a.ref]) await ensure([m.a.ref]).catch(() => {});
      if (m.a.t === 'SEAT_DECK') await ensure([...new Set(m.a.entries.map(e => e.ref))]).catch(() => {});
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
  $('#join-row').hidden = true;
  $('#btn-leave').hidden = false;
  $('#net-in').textContent = `You're in room ${online.room} as ${online.me.name}.`;
}

function leaveRoom() {
  if (net) { net.close(); net = null; }
  online = null; dropPending();
  const u = new URL(location.href); u.searchParams.delete('room'); history_.replaceState(null, '', u);
  $('#btn-start').textContent = 'Create room';
  $('#join-row').hidden = false; $('#btn-leave').hidden = true;
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

$('#btn-join').addEventListener('click', () => joinRoom($('#net-code').value));
$('#net-code').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom($('#net-code').value); });
$('#btn-leave').addEventListener('click', () => { if (confirm('Leave this room? The game keeps going for the others.')) leaveRoom(); });
$('#room-chip').addEventListener('click', async () => {
  const code = online?.room || new URL(location.href).searchParams.get('room') || '';
  if (!code) return;
  try { await navigator.clipboard.writeText(code); toast(`Room code ${code} copied`); } catch { prompt('Room code:', code); }
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
    wither: line('wither').test(t), deathtouch: line('deathtouch').test(t), trample: line('trample').test(t),
    firstStrike: line('first strike').test(t) || line('double strike').test(t), double: line('double strike').test(t),
    indestructible: line('indestructible').test(t),
    infect: line('infect').test(t),
    toxic: +(t.match(new RegExp(`^(?:[\\w' -]+, )*toxic (\\d+)`, 'im'))?.[1] || 0),
    poisonous: +(t.match(/^Poisonous (\d+)/im)?.[1] || 0),
  };
}

// What combat does: damage/poison to the Survivors, and the results of each block
// (creatures that die, -1/-1 counters from infect/wither). Simplified: one blocker per
// attacker, first/double strike decide who hits first, damage that isn't lethal is ignored.
function combatHits() {
  let damage = 0, poison = 0;
  const kill = new Set(), counters = [];
  const P = c => power(state, db, c);
  const onField = c => zoneOf(state, c.id) === 'battlefield';
  for (const id of state.zones.battlefield) {
    const a = state.cards[id];
    if (!a.attacking) continue;
    const ka = kw(a), pa = Math.max(0, P(a).p);
    const b = a.blocked && a.blockedBy && state.cards[a.blockedBy] && onField(state.cards[a.blockedBy]) ? state.cards[a.blockedBy] : null;
    if (a.blocked && !b) continue;                       // blocked by something off the table (or already gone)
    if (!b) {
      const dmg = pa * (ka.double ? 2 : 1);
      if (ka.infect) poison += dmg; else damage += dmg;
      if (pa > 0) poison += (ka.toxic + ka.poisonous) * (ka.double ? 2 : 1);
      continue;
    }
    // Blocked: a first-strike damage step, then the regular one (double strike deals in both).
    const kb = kw(b), pb = Math.max(0, P(b).p);
    const side = (c, k, p) => ({ c, k, p, t: P(c).t, dmg: 0, minus: 0, dead: false });
    const A = side(a, ka, pa), B = side(b, kb, pb);
    const deal = (src, dst) => {
      if (src.dead || src.p <= 0) return;
      if (src.k.infect || src.k.wither) dst.minus += src.p; else dst.dmg += src.p;
      if (src.k.deathtouch && !dst.k.indestructible) dst.deathtouched = true;
    };
    const settle = x => { x.dead = x.minus >= x.t || (!x.k.indestructible && (x.dmg >= x.t - x.minus || x.deathtouched)); };
    if (ka.firstStrike) deal(A, B);
    if (kb.firstStrike) deal(B, A);
    settle(A); settle(B);
    if (!ka.firstStrike || ka.double) deal(A, B);
    if (!kb.firstStrike || kb.double) deal(B, A);
    settle(A); settle(B);
    if (A.minus) counters.push([a.id, -A.minus]);
    if (B.minus) counters.push([b.id, -B.minus]);
    if (A.dead) kill.add(a.id);
    if (B.dead) kill.add(b.id);
    if (ka.trample) {                                       // excess over what's lethal goes through
      const lethal = ka.deathtouch ? 1 : Math.max(0, P(b).t);
      const excess = pa * (ka.double ? 2 : 1) - lethal;
      if (excess > 0) { if (ka.infect) poison += excess; else damage += excess; poison += ka.toxic + ka.poisonous; }
    }
  }
  return { damage, poison, kill: [...kill], counters };
}
function incoming() { return combatHits().damage; }

// The Horde's turn is mid-way but nobody is driving it (this player isn't, and no action
// has arrived for a few seconds): offer to resume it.
let stallTimer = 0;
function hordeStalled() { return state?.phase === 'horde' && !busy && Date.now() - lastActAt > 4000; }

// Unblocked attackers lunge at the Survivors' life total along a curved path.
// Strike animations hold the card at the impact point (fill: forwards) until the board
// redraws after damage; renderAll then cancels them so no card keeps that offset.
let strikeAnims = [];
function strikeAnimation() {
  const els = [...document.querySelectorAll('#attack-lane .card')]
    .filter(el => el._ids?.some(id => state.cards[id]?.attacking && !state.cards[id].blocked));
  return strikeAt(els, $('#life-box'));
}
// The Survivors' attackers (on the board being shown) lunge at the Horde's library.
function survivorStrike(ids) {
  const lib = state?.hordeLife > 0 ? $('#hlife-box') : $('#pile-library .pile-top');
  const els = [...document.querySelectorAll('.dock-board .card.attacking')].filter(el => !ids || el._ids?.some(i => ids.includes(i)));
  if (!els.length) { const r = lib.getBoundingClientRect(); impact(r.left + r.width / 2, r.top + r.height / 2, lib); return Promise.resolve(); }
  return strikeAt(els, lib);
}
async function strikeAt(els, targetEl) {
  if (!targetEl || !els.length) return;
  const target = targetEl.getBoundingClientRect();
  const tx = target.left + target.width / 2, ty = target.top + target.height / 2;
  if (!els.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const DUR = 620, GAP = Math.min(140, 700 / els.length);
  els.forEach((el0, i) => {
    let el = el0;
    const r = el0.getBoundingClientRect();
    // Cards inside a scrolling board would be clipped on the way: fly a copy instead.
    if (el0.closest('.dock-board')) {
      el = el0.cloneNode(true);
      el.classList.add('strike-copy');
      Object.assign(el.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', margin: 0, zIndex: 55, pointerEvents: 'none' });
      document.body.appendChild(el);
      el0.style.opacity = '.25';
      setTimeout(() => { el.remove(); el0.style.opacity = ''; }, i * GAP + DUR + 120);
    }
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
    if (el === el0) { el.style.zIndex = 50; strikeAnims.push({ el, anim: el.animate(frames, { duration: DUR, delay: i * GAP, fill: 'forwards' }) }); }
    else el.animate(frames, { duration: DUR, delay: i * GAP, fill: 'forwards' });
    setTimeout(() => impact(tx, ty, targetEl), i * GAP + DUR);
  });
  await wait((els.length - 1) * GAP + DUR + 60);
}
function impact(x, y, hitEl = $('#life-box')) {
  const fx = document.createElement('div');
  fx.className = 'impact';
  fx.style.left = x + 'px'; fx.style.top = y + 'px';
  document.body.appendChild(fx);
  fx.animate([{ transform: 'translate(-50%,-50%) scale(.2)', opacity: 1 }, { transform: 'translate(-50%,-50%) scale(1.8)', opacity: 0 }],
    { duration: 420, easing: 'ease-out' }).onfinish = () => fx.remove();
  const box = hitEl.closest('.life, .pile') || hitEl;
  box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
}

async function resolveCombat() {
  if (busy) return;
  const hits = combatHits();
  busy = true;
  hits.kill = hits.kill || []; hits.counters = hits.counters || [];
  renderAll(state);
  await strikeAnimation();
  try { await dispatch({ t: 'END_COMBAT', damage: hits.damage, poison: hits.poison, kill: hits.kill, counters: hits.counters }); } finally { busy = false; renderAll(state); }
}

let refitRaf = 0;
function renderAll(prev) {
  const s = state;
  // Classes and boxes that change the layout come first, so card sizes are fitted to the final space.
  document.body.className = document.body.className.replace(/\bphase-\S+/g, '').trim();
  document.body.classList.add('phase-' + s.phase);
  document.body.classList.toggle('has-board', s.zones.battlefield.length + s.zones.hand.length > 0 || s.turn > 0);
  $('#poison-box').classList.toggle('on', s.deck.poison || s.poison > 0);
  $('#hlife-box').classList.toggle('on', s.hordeLife !== null);
  renderDock(s);
  layoutTable();
  render(s, db, { me: mySeat(), seat: viewSeat || mySeat(), beforeMeasure: fitBoards });
  // Some sizes (the hand row, fonts) settle only after the first paint: fit once more then.
  clearTimeout(refitRaf);
  refitRaf = setTimeout(fitBoards, 80);
  for (const el of $$('#seat-hand .card')) el.classList.toggle('picked', !!mullPick?.has(el._ids[0]));
  document.body.classList.toggle('mull-picking', !!mullPick);
  strikeAnims = strikeAnims.filter(({ el, anim }) => {
    if (anim.playState !== 'finished') return true;   // still flying: leave it
    anim.cancel(); el.style.zIndex = ''; return false;
  });

  // life
  const ln = $('#life-num');
  ln.textContent = s.life;
  ln.classList.toggle('low', s.life <= Math.max(5, s.opts.life * 0.25));
  if (prev && prev.life !== s.life) floatNum(ln, s.life - prev.life);

  $('#poison-num').textContent = s.poison;
  if (prev && prev.poison !== s.poison) floatNum($('#poison-num'), s.poison - prev.poison, true);

  $('#hlife-num').textContent = s.hordeLife ?? '';
  if (prev && prev.hordeLife != null && s.hordeLife != null && prev.hordeLife !== s.hordeLife) floatNum($('#hlife-num'), s.hordeLife - prev.hordeLife, true);
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
  else if (s.phase === 'survivors') {
    const n = survivorAttackers().length;
    btn.textContent = n ? `Attack the Horde (${survivorAttackDamage()} damage)` : 'End turn — the Horde moves';
  }
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
function openTokens(owner = 'horde') {
  tokOwner = owner;
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
  if (p === 'survivors' && survivorAttackers().length) { await survivorAttack(); return; }
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
function hudClick(e) {
  const b = e.target.closest('button');
  if (!b || !state) return;
  const mult = e.shiftKey ? 5 : 1;
  if (b.dataset.life) dispatch({ t: 'LIFE', d: +b.dataset.life * mult });
  else if (b.dataset.poison) dispatch({ t: 'POISON', d: +b.dataset.poison });
  else if (b.dataset.hlife) dispatch({ t: 'HORDE_LIFE', d: +b.dataset.hlife * mult });
  else if (b.dataset.anthem) dispatch({ t: 'ANTHEM', d: +b.dataset.anthem });
  else if (b.dataset.dmg) { const i = $('#dmg-num'); i.value = Math.max(1, (+i.value || 1) + +b.dataset.dmg * mult); }
  else if (b.id === 'btn-mill') { const n = Math.max(1, +$('#dmg-num').value || 1); dispatch({ t: 'MILL', n }); $('#dmg-num').value = 1; }
  else if (b.id === 'btn-dmg') { const n = Math.max(1, +$('#dmg-num').value || 1); dispatch({ t: 'DAMAGE_HORDE', n }); $('#dmg-num').value = 1; }
  else if (b.id === 'btn-block-all') dispatch({ t: 'BLOCK', ids: state.zones.battlefield.filter(id => state.cards[id].attacking), v: true });
  else if (b.id === 'btn-block-none') dispatch({ t: 'BLOCK', ids: state.zones.battlefield.filter(id => state.cards[id].attacking), v: false });
}
document.querySelector('.hud').addEventListener('click', hudClick);
$('#survivor-life').addEventListener('click', hudClick);
$('#top-dmg').addEventListener('click', hudClick);
$('#life-box').addEventListener('wheel', e => { e.preventDefault(); if (state) dispatch({ t: 'LIFE', d: e.deltaY < 0 ? 1 : -1 }); }, { passive: false });

/* =================== card actions =================== */
function castIds(ids) {
  // The Horde's spells go on the stack; a Survivor's stay on their battlefield until they clear them.
  const spells = ids.filter(id => state.cards[id].spell && !state.cards[id].owner), perms = ids.filter(id => !spells.includes(id));
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
    case 'flip': dispatch({ t: 'FLIP', ids: [ids[0]] }); break;
    case 'block': chooseBlocker(ids[0], e.clientX, e.clientY); break;
    case 's-attack': {
      const id = c.attacking ? ids.find(i => state.cards[i].attacking) : ids.find(i => !state.cards[i].attacking);
      if (id != null) dispatch({ t: 'ATTACK', ids: [id], v: !c.attacking }, false);
      break;
    }
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
  if (!c.token && db[c.ref]?.parts?.length) out.push(I('Create its tokens…', () => openTokens(c.owner ? 'me' : 'horde')));
  if (c.commander && zone !== 'command') out.push(I('Return to command zone', mv('command')));
  if (zone === 'battlefield' && c.owner) {
    const cur = c.lane || autoLane(db, c);
    for (const [ln, label] of [['cre', 'Creatures'], ['land', 'Lands'], ['oth', 'Other permanents']])
      if (ln !== cur) out.push(I(`Move to the ${label} lane`, k => dispatch({ t: 'LANE', ids: ids.slice(0, k), lane: ln === autoLane(db, c) ? null : ln })));
  }
  if (zone === 'battlefield' && ids.length === 1) {
    if (c.attachedTo) out.push(I(`Unattach from ${state.cards[c.attachedTo]?.name || 'it'}`, () => dispatch({ t: 'ATTACH', id: c.id, host: null })));
    else if (!c.creature || isAttachable(c)) out.push(I('Attach to…', () => chooseHost(c.id), { hint: 'Aura, Equipment' }));
  }
  if (zone === 'battlefield') {
    out.push(I(c.tapped ? 'Untap' : 'Tap', k => dispatch({ t: 'TAP', ids: ids.slice(0, k), v: !c.tapped }), { kbd: 'T' }));
    if (c.creature) {
      out.push(I('Add +1/+1 counter', k => dispatch({ t: 'COUNTER', ids: ids.slice(0, k), d: 1 })));
      if (c.counters) out.push(I(c.counters > 0 ? 'Remove +1/+1 counter' : 'Remove −1/−1 counter', k => dispatch({ t: 'COUNTER', ids: ids.slice(0, k), d: c.counters > 0 ? -1 : 1 })));
      else out.push(I('Add −1/−1 counter', k => dispatch({ t: 'COUNTER', ids: ids.slice(0, k), d: -1 })));
    }
    if (isWalker(db, c)) {
      out.push(I('+1 loyalty', k => dispatch({ t: 'COUNTER', ids: ids.slice(0, k), d: 1, kind: 'loyalty' }), { kbd: '+' }));
      out.push(I('−1 loyalty', k => dispatch({ t: 'COUNTER', ids: ids.slice(0, k), d: -1, kind: 'loyalty' }), { kbd: '−' }));
    }
    out.push(I('Add a counter', k => dispatch({ t: 'COUNTER', ids: ids.slice(0, k), d: 1, kind: 'generic' }), { hint: c.marks ? '◆ ' + c.marks : 'any kind' }));
    if (c.marks) out.push(I('Remove a counter', k => dispatch({ t: 'COUNTER', ids: ids.slice(0, k), d: -1, kind: 'generic' })));
    if (c.owner && c.creature && state.phase === 'survivors')
      out.push(I(c.attacking ? 'Stop attacking' : 'Attack the Horde', k => dispatch({ t: 'ATTACK', ids: ids.slice(0, k), v: !c.attacking }, false)));
    if (state.phase === 'combat' && c.creature && !c.owner) {
      out.push(c.attacking
        ? I('Remove from combat', k => dispatch({ t: 'ATTACK', ids: ids.slice(0, k), v: false }))
        : I('Add to the attack', k => dispatch({ t: 'ATTACK', ids: ids.slice(0, k), v: true })));
      if (c.attacking) out.push(I(c.blocked ? 'Unblock' : 'Block', k => dispatch({ t: 'BLOCK', ids: ids.slice(0, k), v: !c.blocked })));
    }
    out.push('sep');
    out.push(I(c.creature ? 'Destroy' : 'Destroy / sacrifice', mv('graveyard'), { danger: true, kbd: 'D' }));
    out.push(I('Exile', mv('exile'), { kbd: 'E' }));
    out.push(c.owner ? I('Return to hand', mv('hand')) : I('Return to Horde hand', mv('hand'), { hint: 'recast next turn' }));
    out.push(I('Put on top of library', mv('library', 'top')));
    out.push(I('Put on bottom of library', mv('library', 'bottom')));
    if (c.token) { out.push('sep'); out.push(I('Create more of this token', k => dispatch({ t: 'CREATE', ref: c.ref, name: c.name, creature: c.creature, n: k, owner: c.owner }))); }
  } else if (zone === 'stack') {
    out.push(I('Resolved', () => { dispatch({ t: 'RESOLVE_STACK', id: c.id }).then(afterResolve); }));
    out.push(I('Countered', () => { dispatch({ t: 'RESOLVE_STACK', id: c.id, countered: true }).then(afterResolve); }));
    out.push(I('Exile it', () => { dispatch({ t: 'MOVE', ids: [c.id], to: 'exile' }).then(afterResolve); }));
  } else if (zone === 'reveal') {
    return [];
  } else {
    // hand, graveyard, exile, library
    out.push(I(c.owner ? (c.spell ? 'Cast it' : zone === 'hand' || zone === 'command' ? 'Play it' : 'Put onto the battlefield')
      : c.spell ? 'Cast it now' : 'Put onto the battlefield', k => castIds(ids.slice(0, k))));
    if (zone !== 'hand') out.push(I(c.owner ? 'Put into hand' : "Put into Horde's hand", mv('hand')));
    if (zone !== 'graveyard') out.push(I(zone === 'hand' ? 'Discard' : 'Put into graveyard', mv('graveyard'), { danger: zone === 'hand' }));
    if (zone !== 'exile') out.push(I('Exile', mv('exile')));
    if (zone === 'exile') {        // suspend, time counters, adventures…
      out.push(I('Add a counter', k => dispatch({ t: 'COUNTER', ids: ids.slice(0, k), d: 1, kind: 'generic' }), { hint: c.marks ? '◆ ' + c.marks : '' }));
      if (c.marks) out.push(I('Remove a counter', k => dispatch({ t: 'COUNTER', ids: ids.slice(0, k), d: -1, kind: 'generic' })));
    }
    out.push(I('Put on top of library', mv('library', 'top')));
    out.push(I('Put on bottom of library', mv('library', 'bottom')));
  }
  return out;
}

// Auras and Equipment can be attached to a permanent: from the card menu, or by dropping them on it.
function isAttachable(c) { return /\b(Aura|Equipment|Fortification)\b/.test(db[c.ref]?.type || ''); }
function attachTo(id, host) {
  return dispatch({ t: 'ATTACH', id, host, aura: /\bAura\b/.test(db[state.cards[id].ref]?.type || '') });
}
let lastMenuAt = [200, 200];
function chooseHost(id) {
  const c = state.cards[id];
  const bf = [...(state.seats?.[mySeat()]?.zones.battlefield || []), ...state.zones.battlefield,
    ...Object.values(state.seats || {}).filter(st => st.id !== mySeat()).flatMap(st => st.zones.battlefield)];
  const hosts = bf.map(i => state.cards[i]).filter(h => h.id !== id && !h.attachedTo && (h.creature || !isAttachable(h)));
  hosts.sort((a, b) => b.creature - a.creature);
  const whose = h => h.owner ? (h.owner === mySeat() ? 'yours' : seatOf(state, h.owner)?.name || '') : 'Horde';
  const seen = new Set(), items = [];
  for (const h of hosts) {                       // one line per kind of token, not one per copy
    const k = h.token || !h.creature && /\bLand\b/.test(db[h.ref]?.type || '') ? h.ref + '|' + (h.owner || '') : h.id;
    if (seen.has(k)) continue;
    seen.add(k);
    items.push({ label: h.name, hint: whose(h), fn: () => attachTo(id, h.id) });
  }
  if (!items.length) { toast('Nothing on the battlefield to attach it to.'); return; }
  openMenu(lastMenuAt[0], lastMenuAt[1], { title: `Attach ${c.name} to…`, items: items.slice(0, 30) });
}

/* =================== menus =================== */
let menuState = null;
function openMenu(x, y, { title, max = 1, items }) {
  if (!items.length) return;
  lastMenuAt = [x, y];
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
// Graveyard menu: look, or shuffle X random cards back into the library.
function pickRandom(list, k) { return shuffle(list).slice(0, k); }
function graveyardMenu(e, seatId) {
  const zs = seatId ? state.seats?.[seatId]?.zones : state.zones;
  if (!zs) return;
  const n = zs.graveyard.length;
  const items = [{ label: 'Look at the graveyard', fn: () => openViewer(seatId ? { seat: seatId, zone: 'graveyard' } : 'graveyard') }];
  if (n) items.push({ label: 'Shuffle at random into the library', hint: 'X cards', fn: k => {
    const z = seatId ? state.seats[seatId].zones : state.zones;          // read again: it may have changed
    const ids = pickRandom(z.graveyard, Math.min(k, z.graveyard.length));
    dispatch({ t: 'GY_TO_LIBRARY', ids, order: shuffle([...z.library, ...ids]) });
  } });
  openMenu(e.clientX, e.clientY, { title: seatId ? `${state.seats[seatId].name}'s graveyard` : 'Horde graveyard', max: Math.max(1, n), items });
}
$('#pile-graveyard').addEventListener('click', e => { if (state && !busy) graveyardMenu(e, null); });
$('#pile-exile').addEventListener('click', () => state && openViewer('exile'));

/* zone viewer */
let viewerZone = null;
function openViewer(zone) {
  viewerZone = zone;
  $('#viewer').classList.add('on');
  renderViewer();
}
function renderViewer() {
  const seat = typeof viewerZone === 'object' ? state.seats?.[viewerZone.seat] : null;
  if (typeof viewerZone === 'object' && !seat) { $('#viewer').classList.remove('on'); return; }
  const z = seat ? viewerZone.zone : viewerZone;
  const list = seat ? seat.zones[z] : state.zones[z];
  const ids = z === 'library' ? list : [...list].reverse();
  $('#viewer-title').textContent = (seat
    ? `${seat.name}'s ${{ library: 'library (top first)', graveyard: 'graveyard', exile: 'exile', command: 'command zone' }[z]}`
    : { library: 'Horde library (top first)', graveyard: 'Horde graveyard', exile: 'Exile' }[z]) + ` · ${ids.length}`;
  $('#viewer-grid').innerHTML = ids.length ? ids.map(id => {
    const c = state.cards[id], d = db[c.ref];
    return `<div class="vcard" data-id="${id}">${d?.img ? `<img src="${d.img}" alt="${esc(c.name)}" loading="lazy">` : ''}<span>${esc(c.name)}</span></div>`;
  }).join('') : '<p style="color:var(--ink3)">Empty.</p>';
}
$('#viewer-grid').addEventListener('click', e => {
  const v = e.target.closest('.vcard');
  if (!v) return;
  const id = +v.dataset.id;
  openMenu(e.clientX, e.clientY, { title: state.cards[id].name, items: itemsFor([id], typeof viewerZone === 'object' ? viewerZone.zone : viewerZone) });
});

/* =================== drawers =================== */
function toggleDrawer(id) {
  const d = $(id);
  const on = !d.classList.contains('on');
  $$('.drawer').forEach(x => x.classList.remove('on'));
  if (on) { d.classList.add('on'); id === '#drawer-log' ? renderLog() : renderTokens(); }
}
$('#btn-tokens').addEventListener('click', () => state && ($('#drawer-tokens').classList.contains('on') ? $('#drawer-tokens').classList.remove('on') : openTokens(tokOwner)));
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

// Tokens these cards can make (from Scryfall's related parts), with the cards that make them.
function tokensMadeBy(ids) {
  const out = new Map();
  for (const id of ids) {
    const c = state.cards[id];
    if (!c || c.token) continue;
    for (const r of db[c.ref]?.parts || []) { if (!out.has(r)) out.set(r, new Set()); out.get(r).add(c.name); }
  }
  return [...out].map(([ref, from]) => ({ ref, from: [...from].slice(0, 3).join(', ') + (from.size > 3 ? '…' : '') }));
}
function tokenRow(ref, from) {
  const d = db[ref];
  if (!d) return from ? `<p class="drawer-sub">Loading a token made by ${esc(from)}…</p>` : '';
  const onBoard = (tokOwner === 'me' ? state.seats?.[mySeat()]?.zones.battlefield || [] : state.zones.battlefield).filter(id => state.cards[id].ref === ref).length;
  const pt = d.power != null ? `${d.power}/${d.toughness} ` : '';
  return `<div class="tok" data-ref="${ref}"><img src="${d.art || d.img || ''}" alt="">
    <div><div class="nm">${esc(d.name)}</div>${from ? `<div class="from">from ${esc(from)}</div>` : ''}<div class="ty">${esc(pt + d.type.replace(/^Token /, ''))}${onBoard ? ` · <b style="color:var(--gold2)">${onBoard} in play</b>` : ''}</div></div>
    <div class="add" title="Click to add one (Shift: five)">+</div></div>`;
}
$('#tok-persist').addEventListener('change', e => { if (state) dispatch({ t: 'SET_OPT', k: 'tokensPersist', v: e.target.checked }); });
$('#tok-owner').addEventListener('click', e => {
  const b = e.target.closest('[data-owner]');
  if (b) { tokOwner = b.dataset.owner; renderTokens(); }
});
function renderTokens() {
  $('#tok-persist').checked = !!state.opts.tokensPersist;
  for (const b of $$('#tok-owner [data-owner]')) b.classList.toggle('on', b.dataset.owner === tokOwner);
  $('#tok-help').textContent = tokOwner === 'me'
    ? 'Tokens for you: the ones your deck makes are listed first. They land on your board.'
    : 'Tokens for the Horde. Click a token stack on the board to destroy, tap or move several at once.';
  let html = '';
  if (tokOwner === 'me') {
    const seat = state.seats?.[mySeat()];
    const mine = id => state.cards[id];
    const inPlay = tokensMadeBy(seat?.zones.battlefield || []);
    const rest = tokensMadeBy(Object.values(state.cards).filter(c => c.owner === mySeat()).map(c => c.id))
      .filter(m => !inPlay.some(x => x.ref === m.ref));
    const shown = new Set([...inPlay, ...rest].map(m => m.ref));
    const board = [...new Set((seat?.zones.battlefield || []).map(mine).filter(c => c.token).map(c => c.ref))].filter(r => !shown.has(r));
    const missing = [...inPlay, ...rest].map(m => m.ref).filter(r => !db[r]);
    if (missing.length) ensure(missing).then(() => $('#drawer-tokens').classList.contains('on') && renderTokens()).catch(() => {});
    if (inPlay.length) html += `<div class="tok-section hot">Made by your cards in play</div>` + inPlay.map(m => tokenRow(m.ref, m.from)).join('');
    if (rest.length) html += `<div class="tok-section">Your deck's tokens</div>` + rest.map(m => tokenRow(m.ref, m.from)).join('');
    if (board.length) html += `<div class="tok-section">Your other tokens in play</div>` + board.map(r => tokenRow(r)).join('');
    if (!seat?.deckName && !html) html += `<p class="drawer-sub">Load your deck (Your deck, at the top) to see the tokens it makes, or search for any token below.</p>`;
  } else {
    const deckRefs = state.deck.tokenRefs || [];
    const boardRefs = [...new Set(state.zones.battlefield.map(id => state.cards[id]).filter(c => c.token).map(c => c.ref))].filter(r => !deckRefs.includes(r));
    const made = madeTokenRefs();
    const missing = made.map(m => m.ref).filter(r => !db[r]);
    if (missing.length) ensure(missing).then(() => $('#drawer-tokens').classList.contains('on') && renderTokens()).catch(() => {});
    if (made.length) html += `<div class="tok-section hot">Made by cards in play or just cast</div>` +
      made.map(m => tokenRow(m.ref, m.from)).join('');
    if (deckRefs.length) html += `<div class="tok-section">This Horde's tokens</div>` + deckRefs.map(r => tokenRow(r)).join('');
    if (boardRefs.length) html += `<div class="tok-section">Other tokens in play</div>` + boardRefs.map(r => tokenRow(r)).join('');
  }
  if (tokenSearch.length) html += `<div class="tok-section">Search results</div>` + tokenSearch.map(c => tokenRow(c.id)).join('');
  $('#token-list').innerHTML = html;
}
$('#token-list').addEventListener('click', e => {
  const b = e.target.closest('.tok');
  if (!b) return;
  const ref = b.dataset.ref;
  const n = e.shiftKey ? 5 : 1;
  b.animate([{ transform: 'scale(.97)' }, { transform: 'none' }], { duration: 160 });
  const d = db[ref];
  const owner = tokOwner === 'me' ? mySeat() : undefined;
  if (n > 0) {
    const go = () => dispatch({ t: 'CREATE', ref, name: d.name.replace(/ Token$/, ''), creature: /Creature/.test(d.type), n, owner });
    if (owner && !state.seats?.[owner]) dispatch({ t: 'SEAT', seat: owner, name: myDisplayName() }, false).then(go); else go();
  } else {
    const bf = owner ? state.seats?.[owner]?.zones.battlefield || [] : state.zones.battlefield;
    const id = bf.find(i => state.cards[i].ref === ref && !state.cards[i].attacking) ?? bf.find(i => state.cards[i].ref === ref);
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

/* =================== view size preferences =================== */
const VIEW_KEY = 'horde.view';
let viewPref = { card: 'm', zoom: 'm' };
try { Object.assign(viewPref, JSON.parse(localStorage.getItem(VIEW_KEY)) || {}); } catch {}
// Card size: [min, max] card width for the Horde board, and for your board.
const CARD_SIZES = { s: { horde: [44, 170], seat: [36, 130] }, m: { horde: [58, 200], seat: [44, 150] }, l: { horde: [96, 240], seat: [78, 180] } };
function applyViewPref() {
  document.body.classList.remove('size-s', 'size-m', 'size-l', 'zoom-s', 'zoom-m', 'zoom-l');
  document.body.classList.add('size-' + viewPref.card, 'zoom-' + viewPref.zoom);
  for (const seg of document.querySelectorAll('#view-menu [data-pref]'))
    for (const b of seg.children) b.classList.toggle('on', b.dataset.v === viewPref[seg.dataset.pref]);
}
$('#btn-view').addEventListener('click', e => { e.stopPropagation(); applyViewPref(); $('#view-menu').classList.toggle('on'); });
$('#view-menu').addEventListener('click', e => {
  e.stopPropagation();
  const b = e.target.closest('[data-v]');
  if (!b) return;
  viewPref[b.parentElement.dataset.pref] = b.dataset.v;
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(viewPref)); } catch {}
  applyViewPref();
  if (state) renderAll(state);
});
document.addEventListener('click', e => { if (!e.target.closest('#view-menu')) $('#view-menu').classList.remove('on'); });
applyViewPref();

/* =================== layout: space and card size =================== */
// Solo (no Survivor board in use): the Horde gets the whole table and the life total sits at
// its top. With a Survivor board: 50/50 split, life total on the seam between them.
function layoutTable() {
  const split = !document.body.classList.contains('dock-compact');
  document.body.classList.toggle('split', split);
  const life = $('#survivor-life');
  const home = split ? $('#dock') : $('.table');
  if (life.parentElement !== home) home.prepend(life);
}

// Pick the biggest card size at which all cards of these groups fit in `box`. The groups flow
// side by side and wrap (see .bf-flow / .dock-board), so treat them as one sequence of cards.
function fitFlow(box, rows, reserve, min, max) {
  const W = box.clientWidth - 28, H = (box.clientHeight - reserve) * 0.96;   // small safety margin
  const live = rows.filter(r => r.children.length);
  const n = live.reduce((k, r) => k + r.children.length, 0) + Math.max(0, live.length - 1) * 0.6;   // gaps between groups
  const tapped = live.reduce((k, r) => k + r.querySelectorAll('.card.tapped').length, 0);
  if (!n || W <= 0 || H <= 0) { for (const r of rows) r.style.removeProperty('--cw'); return; }
  const gap = 12;
  let cw = max;
  for (; cw > min; cw -= 2) {
    const w = cw * (1 + .42 * tapped / n) + gap;                 // tapped cards are rotated, so wider
    const per = Math.max(1, Math.floor((W + gap) / w));
    const lines = Math.ceil(n / per) + Math.max(0, live.length - 1) * 0.35;   // groups may break lines early
    if (lines * (cw * 88 / 63 + 18) <= H) break;
  }
  for (const r of rows) r.style.setProperty('--cw', cw + 'px');
}
function fitBoards() {
  // The Horde's piles: as big as the table's height allows (3 piles + labels).
  const phone = innerWidth <= 760;
  const rail = $('.rail');
  if (phone) rail.style.removeProperty('--cw');
  else rail.style.setProperty('--cw', Math.max(44, Math.min(112, Math.floor((rail.clientHeight - 3 * 34 - 24) / 3 / 1.4))) + 'px');
  const board = $('.board');
  const vis = el => (el && el.offsetParent ? el.offsetHeight + 10 : 0);
  const split = document.body.classList.contains('split');
  const sz = CARD_SIZES[viewPref.card] || CARD_SIZES.m;
  fitFlow(board, [$('#bf-creatures'), $('#bf-other')],
    24 + vis($('.hand-wrap')) + vis($('.attack-zone')) + (phone ? 0 : split ? 34 : 84), sz.horde[0], split ? sz.horde[1] * 0.75 : sz.horde[1]);
  if (split) {
    fitLanes($('.dock-board'), 18, sz.seat[0], sz.seat[1]);
    // Your piles stand in a column beside the board, as big as its height allows.
    const piles = $('#dock-piles'), n = piles.children.length;
    if (phone) piles.style.removeProperty('--cw');
    else if (n) piles.style.setProperty('--cw', Math.max(34, Math.min(96, Math.floor(($('.dock-body').clientHeight - (n - 1) * 8 - 4) / n / 1.4))) + 'px');
  }
  fitHand();
}
// Your hand sits centred; cards overlap only as much as needed to fit, and grow on hover to be read.
const HAND_ZOOM = { s: 210, m: 260, l: 320 };
function fitHand() {
  const row = $('#seat-hand'), n = row.children.length;
  if (!n) return;
  const cw = row.children[0].offsetWidth || 80, W = row.clientWidth - 16;
  const ov = n > 1 ? Math.min(8, Math.max(-cw * 0.72, (W - n * cw) / (n - 1))) : 0;
  row.style.setProperty('--ov', ov + 'px');
  const hz = Math.max(1.3, (HAND_ZOOM[viewPref.zoom] || 260) / cw);
  row.style.setProperty('--hz', hz.toFixed(2));
  // Carousel: the cards beside a hovered card slide away so the big card covers none of them.
  row.style.setProperty('--push', Math.round(cw * (hz - 1) / 2 - ov + 10) + 'px');
}
// Two lanes: creatures on top; lands and other permanents side by side below. Each lane wraps.
function fitLanes(box, reserve, min, max) {
  const groups = [[$('#seat-creatures')], [$('#seat-lands'), $('#seat-other')]];
  const W0 = box.clientWidth - 40, H = (box.clientHeight - reserve) * 0.97;
  const all = groups.flat();
  const stat = r => ({ n: r.children.length, tapped: r.querySelectorAll('.card.tapped').length, att: r.querySelectorAll('.card.attached').length });
  const live = groups.map(g => g.filter(r => r.children.length).map(stat)).filter(g => g.length);
  if (!live.length || W0 <= 0 || H <= 0) { for (const r of all) r.style.removeProperty('--cw'); return; }
  let cw = max;
  for (; cw > min; cw -= 2) {
    let need = 0;
    for (const g of live) {
      const W = g.length > 1 ? (W0 - 30) / 2 : W0;
      let h = 0;
      for (const L of g) {
        const w = cw * (1 + .42 * L.tapped / L.n) + 12;                    // tapped cards are rotated, so wider
        const lines = Math.ceil((L.n - L.att) / Math.max(1, Math.floor((W + 12) / w)));   // attached cards tuck behind
        h = Math.max(h, lines * (cw * 88 / 63) + (lines - 1) * 14 + (L.att ? cw * 0.42 : 0));
      }
      need += h + 8 + 6;                                                       // lane padding, gap between lanes
    }
    if (need <= H) break;
  }
  for (const r of all) r.style.setProperty('--cw', cw + 'px');
}
let resizeT = 0;
addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => state && $('#setup').classList.contains('off') && renderAll(state), 150); });

/* =================== Survivor boards =================== */
const SEAT_LABEL = { library: 'Library', graveyard: 'Graveyard', exile: 'Exile', command: 'Command', hand: 'Hand' };

function renderDock(s) {
  const me = mySeat(), seats = s.seats || {};
  if (!viewSeat || (!seats[viewSeat] && viewSeat !== me)) viewSeat = me;
  const others = Object.values(seats).filter(st => st.id !== me);
  const info = st => st?.deckName ? `${st.zones.hand.length} in hand · ${st.zones.library.length} in library` : 'no deck yet';
  // Alone: a plain title. With other players: tabs to switch whose board is shown.
  const tab = (id, label, st) => `<button class="seat-tab ${viewSeat === id ? 'on' : ''}" data-seat="${esc(id)}"><b>${label}</b><small>${info(st)}</small></button>`;
  const th = others.length
    ? [tab(me, 'Your board', seats[me]), ...others.map(st => tab(st.id, `${esc(st.name)}'s board`, st))].join('')
    : `<div class="seat-title"><b>Your board</b><small>${info(seats[me])}</small></div>`;
  if ($('#seat-tabs').innerHTML !== th) $('#seat-tabs').innerHTML = th;

  const seat = seats[viewSeat], mine = viewSeat === me;
  $('#dock').classList.toggle('mine', mine);
  $('#dock-tools').hidden = !mine;
  const hasCmd = seat && (seat.zones.command.length || Object.values(s.cards).some(c => c.commander && c.owner === seat.id));
  const zones = [...(hasCmd ? ['command'] : []), 'library', 'graveyard', 'exile', ...(!mine && seat ? ['hand'] : [])];
  const piles = $('#dock-piles');
  const key = viewSeat + '|' + zones.join();
  if (piles.dataset.key !== key) {
    piles.dataset.key = key;
    piles.innerHTML = zones.map(z => `<div class="pile spile" data-pile="S:${esc(viewSeat)}:${z}" data-drop="s:${z}">
      <div class="pile-top ${z === 'library' || z === 'hand' ? 'back' : ''}"><img alt="" draggable="false"></div>
      <div class="pile-label">${SEAT_LABEL[z]} <b class="pile-count">0</b></div></div>`).join('');
  }
  for (const el of piles.querySelectorAll('[data-pile]')) {
    const z = el.dataset.pile.split(':')[2];
    const ids = seat?.zones[z] || [];
    el.querySelector('.pile-count').textContent = ids.length;
    el.classList.toggle('empty', !ids.length);
    if (z !== 'library' && z !== 'hand') {
      const top = ids.length ? s.cards[ids.at(-1)] : null;
      const img = el.querySelector('img'), src = top ? db[top.ref]?.img || '' : '';
      if (img.dataset.src !== src) { img.dataset.src = src; src ? (img.src = src) : img.removeAttribute('src'); }
      el.querySelector('.pile-top').classList.toggle('has', !!top);
    }
  }
  const empty = !seat || (!seat.deckName && !seat.zones.battlefield.length);
  $('#dock-empty').hidden = !empty;
  const eh = mine
    ? `<button class="primary" data-seat-act="deck">Bring your deck</button><span>Optional: play your own cards here, from a Moxfield or Archidekt link or a pasted list.</span>`
    : `<span>${esc(seat?.name || 'This player')} hasn't brought a deck yet.</span>`;
  if ($('#dock-empty').innerHTML !== eh) $('#dock-empty').innerHTML = eh;
  document.body.classList.toggle('dock-compact', empty);
  renderCmdDeaths(s, viewSeat, mine);
  renderMull(s);
}
$('#seat-tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-seat]');
  if (!b || !state) return;
  viewSeat = b.dataset.seat;
  renderAll(state);
});
$('#dock-piles').addEventListener('click', e => {
  const el = e.target.closest('[data-pile]');
  if (!el || !state || busy) return;
  const [, seatId, zone] = el.dataset.pile.split(':');
  const seat = state.seats?.[seatId];
  if (!seat || zone === 'hand') return;
  if (zone === 'graveyard' && seatId === mySeat()) { graveyardMenu(e, seatId); return; }
  if (zone === 'command' && seat.zones.command.length === 1 && seatId === mySeat()) {
    const id = seat.zones.command[0];
    openMenu(e.clientX, e.clientY, { title: state.cards[id].name, items: itemsFor([id], 'command') });
    return;
  }
  if (zone !== 'library') { openViewer({ seat: seatId, zone }); return; }
  if (seatId !== mySeat()) return;                     // someone else's library stays private
  const n = seat.zones.library.length;
  if (!n) return;
  openMenu(e.clientX, e.clientY, { title: 'Your library', max: n, items: [
    { label: 'Draw', fn: k => dispatch({ t: 'SEAT_DRAW', seat: seatId, n: k }), kbd: 'D' },
    { label: 'Mill', fn: k => dispatch({ t: 'MOVE', ids: state.seats[seatId].zones.library.slice(0, k), to: 'graveyard' }) },
    { label: 'Exile from the top', fn: k => dispatch({ t: 'MOVE', ids: state.seats[seatId].zones.library.slice(0, k), to: 'exile' }) },
    'sep',
    { label: 'Search your library', fn: () => openViewer({ seat: seatId, zone: 'library' }) },
    { label: 'Shuffle', fn: () => dispatch({ t: 'SEAT_SHUFFLE', seat: seatId, order: shuffle(state.seats[seatId].zones.library) }) },
  ] });
});

// "Block" on a Horde attacker: pick which of your creatures blocks it.
function chooseBlocker(attackerId, x, y) {
  const a = state.cards[attackerId];
  const seat = state.seats?.[mySeat()];
  const mine = (seat?.zones.battlefield || []).map(id => state.cards[id]).filter(c => c.creature && !c.tapped && !c.blocking);
  if (!mine.length) { dispatch({ t: 'BLOCK', ids: [attackerId], v: true }); return; }
  const items = mine.map(c => { const { p, t } = power(state, db, c); return { label: `Block with ${c.name}`, hint: `${p}/${t}`, fn: () => dispatch({ t: 'BLOCK', ids: [attackerId], v: true, by: c.id }) }; });
  items.push('sep', { label: 'Just mark it blocked', hint: 'blocker not on the table', fn: () => dispatch({ t: 'BLOCK', ids: [attackerId], v: true }) });
  openMenu(x, y, { title: `Block ${a.name}`, items });
}

// Survivors attacking the Horde on their turn.
function survivorAttackers() {
  const out = [];
  for (const k in state?.seats || {}) for (const id of state.seats[k].zones.battlefield) if (state.cards[id].attacking) out.push(id);
  return out;
}
function survivorAttackDamage() {
  return survivorAttackers().reduce((n, id) => { const c = state.cards[id]; return n + Math.max(0, power(state, db, c).p) * (hasKw(db, c, 'double strike') ? 2 : 1); }, 0);
}
async function survivorAttack() {
  const ids = survivorAttackers();
  const damage = survivorAttackDamage();
  const tap = ids.filter(id => !hasKw(db, state.cards[id], 'vigilance'));
  banner('THE SURVIVORS STRIKE');
  busy = true;
  try { await survivorStrike(); await dispatch({ t: 'SURVIVOR_ATTACK', ids, tap, damage }); }
  finally { busy = false; renderAll(state); }
}

// Buttons on the dock and in the deck drawer.
document.addEventListener('click', e => {
  const b = e.target.closest('[data-seat-act]');
  if (!b || !state) return;
  const me = mySeat(), seat = state.seats?.[me];
  const act = b.dataset.seatAct;
  if (act === 'deck') return openDeckDrawer();
  if (act === 'tokens') return openTokens('me');
  if (!seat?.deckName) return openDeckDrawer();
  if (act === 'draw') dispatch({ t: 'SEAT_DRAW', seat: me, n: 1 });
  else if (act === 'untap') dispatch({ t: 'UNTAP_ALL', seat: me });
  else if (act === 'shuffle') dispatch({ t: 'SEAT_SHUFFLE', seat: me, order: shuffle(seat.zones.library) });
  else if (act === 'mulligan') { $('#drawer-deck').classList.remove('on'); mulligan(); }
});

/* ----- your deck: links, pasted lists, saved decks ----- */
const MYDECKS = 'horde.myDecks';
let myDecks = [];
try { myDecks = JSON.parse(localStorage.getItem(MYDECKS)) || []; } catch {}
function storeMyDecks() { try { localStorage.setItem(MYDECKS, JSON.stringify(myDecks)); } catch {} }

function openDeckDrawer() {
  $$('.drawer').forEach(x => x.classList.remove('on'));
  $('#drawer-deck').classList.add('on');
  renderDeckDrawer();
}
function renderDeckDrawer() {
  const seat = state?.seats?.[mySeat()];
  $('#deck-tools').hidden = !seat?.deckName;
  $('#deck-saved').innerHTML = myDecks.length ? `<div class="tok-section">Your saved decks</div>` + myDecks.map((d, i) =>
    `<div class="saved-deck"><b>${esc(d.name)}</b><span>${esc(/^https?:/.test(d.input) ? new URL(d.input).hostname.replace('www.', '') : 'pasted list')}</span>
      <button class="chip gold" data-load="${i}">Load</button><button class="chip" data-del="${i}" title="Forget">✕</button></div>`).join('') : '';
}
$('#deck-saved').addEventListener('click', e => {
  const l = e.target.closest('[data-load]'), d = e.target.closest('[data-del]');
  if (l) { const deck = myDecks[+l.dataset.load]; $('#deck-input').value = deck.input; $('#deck-save-name').value = deck.name; loadMyDeck(deck.input, deck.name); }
  if (d) { myDecks.splice(+d.dataset.del, 1); storeMyDecks(); renderDeckDrawer(); }
});
$('#deck-load').addEventListener('click', () => loadMyDeck($('#deck-input').value, $('#deck-save-name').value));
$('#btn-deck').addEventListener('click', () => state && ($('#drawer-deck').classList.contains('on') ? $('#drawer-deck').classList.remove('on') : openDeckDrawer()));

async function loadMyDeck(input, saveAs = '') {
  input = input.trim(); saveAs = saveAs.trim();
  if (!input || !state) return;
  const st = $('#deck-status');
  $('#deck-load').disabled = true;
  st.textContent = 'Loading…';
  try {
    let deck;
    if (/^https?:\/\//i.test(input)) {
      const r = await fetch('/api/deck?url=' + encodeURIComponent(input)).catch(() => null);
      if (!r) throw new Error('Could not reach the server.');
      const j = await r.json().catch(() => null);
      if (!j) throw new Error('Importing links needs the online server. Paste the deck list as text instead.');
      if (!r.ok) throw new Error(j.error || 'That link could not be imported.');
      deck = j;
    } else deck = { name: '', ...parseDecklist(input) };
    const cards = deck.cards.filter(c => c.section === 'main' || c.section === 'commander');
    if (!cards.length) throw new Error('No cards found. Paste one card per line, like "1 Sol Ring".');
    st.textContent = `Looking up ${cards.length} cards on Scryfall…`;
    const missing = await resolveDeck(cards);
    // Commander lists pasted without a "Commander" heading usually start with it (Moxfield, Archidekt
    // text exports): in a ~100-card singleton list with no commander, a legendary creature (or a card
    // that says it can be your commander) on the first line is the commander, plus a Partner on the second.
    const canLead = c => { const d = c?.ref && db[c.ref]; return !!d && (/Legendary.*\b(Creature|Planeswalker)\b|\bBackground\b/.test(d.type) || /can be your commander/i.test(d.text || '')); };
    const mainCards = cards.filter(c => c.section === 'main');
    const total = cards.reduce((n, c) => n + (c.count || 1), 0);
    if (!cards.some(c => c.section === 'commander') && total >= 98 && total <= 101 && canLead(mainCards[0]) && (mainCards[0].count || 1) === 1) {
      mainCards[0].section = 'commander';
      const d0 = db[mainCards[0].ref];
      if (/\bPartner\b|Choose a Background/i.test(d0?.text || '') && canLead(mainCards[1]) && (mainCards[1].count || 1) === 1) mainCards[1].section = 'commander';
    }
    // Commander decks: let the player confirm or change which cards are their commanders.
    const isCommanderDeck = cards.some(c => c.section === 'commander') || (total >= 98 && total <= 101);
    if (isCommanderDeck) {
      st.textContent = 'Choose your commander…';
      const cands = cards.filter(c => c.ref && db[c.ref] && (c.section === 'commander' || canLead(c)));
      const chosen = await pickCommanders(cands);
      for (const c of cards) if (c.section === 'commander' || chosen.has(c)) c.section = chosen.has(c) ? 'commander' : 'main';
    }
    const entries = [];
    for (const c of cards) {
      const d = c.ref && db[c.ref];
      if (!d) continue;
      const creature = /Creature/.test(d.type);
      const n = c.section === 'commander' ? 1 : Math.min(c.count || 1, 99);
      for (let i = 0; i < n; i++) entries.push({ ref: c.ref, name: d.name, type: d.token ? 'token' : 'card', creature,
        spell: /\b(Instant|Sorcery)\b/.test(d.type) && !creature, section: c.section === 'commander' ? 'commander' : 'main' });
    }
    if (!entries.length) throw new Error('None of those cards were found on Scryfall.');
    if (entries.length > 400) throw new Error('That deck is too big (400 cards max).');
    const main = entries.filter(e => e.section === 'main').length;
    const deckName = saveAs || deck.name || 'My deck';
    const freeMull = entries.some(e => e.section === 'commander') || entries.length >= 98;   // multiplayer: first mulligan is free
    const r = await dispatch({ t: 'SEAT_DECK', seat: mySeat(), name: myDisplayName(), deckName, entries, order: shuffle([...Array(main).keys()]), hand: 7, freeMull });
    if (!r.before) throw new Error('The deck did not reach the room. Try again.');
    if (saveAs) {
      const old = myDecks.find(d => d.name === saveAs);
      if (old) old.input = input; else myDecks.push({ name: saveAs, input });
      storeMyDecks();
    }
    viewSeat = mySeat();
    st.textContent = `Loaded ${deckName}: ${entries.length} cards, 7 drawn.` + (missing.length ? ` Not found: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}` : '');
    renderAll(state); renderDeckDrawer();
  } catch (err) {
    console.warn(err);
    st.textContent = err.message || 'Something went wrong loading the deck.';
  } finally { $('#deck-load').disabled = false; }
}

// Dialog: which of these cards are your commanders (one or more). Resolves to the chosen deck lines.
function pickCommanders(cands) {
  return new Promise(resolve => {
    const pick = new Set(cands.filter(c => c.section === 'commander'));
    const list = [...cands].sort((a, b) => pick.has(b) - pick.has(a));
    const draw = () => {
      $('#cmd-grid').innerHTML = list.length ? list.map((c, i) => { const d = db[c.ref];
        return `<button class="cmd-opt ${pick.has(c) ? 'on' : ''}" data-i="${i}"><img src="${d.img || ''}" alt=""><span>${esc(d.name)}</span></button>`; }).join('')
        : '<p class="drawer-sub">No legendary creatures found in this list.</p>';
      $('#cmd-ok').textContent = pick.size ? `Confirm ${pick.size} commander${pick.size > 1 ? 's' : ''}` : 'Play without a commander';
    };
    const close = v => { $('#cmd-pick').classList.remove('on'); $('#cmd-pick').onclick = null; resolve(v); };
    $('#cmd-pick').onclick = e => {
      const o = e.target.closest('.cmd-opt');
      if (o) { const c = list[+o.dataset.i]; pick.has(c) ? pick.delete(c) : pick.add(c); draw(); }
      else if (e.target.closest('#cmd-ok')) close(pick);
      else if (e.target.closest('#cmd-none')) close(new Set());
    };
    draw();
    $('#cmd-pick').classList.add('on');
  });
}

/* ----- commander deaths, shown next to the board title ----- */
function renderCmdDeaths(s, seatId, mine) {
  const cmds = Object.values(s.cards).filter(c => c.commander && c.owner === seatId);
  const html = cmds.map(c => `<span class="cd" title="Times ${esc(c.name)} has died">
      <span class="nm">${esc(c.name.split(',')[0])}</span><span class="sk">☠</span><b>${c.deaths || 0}</b>
      ${mine ? `<button class="step sm" data-cd="${c.id}" data-d="-1">−</button><button class="step sm" data-cd="${c.id}" data-d="1">+</button>` : ''}</span>`).join('');
  if ($('#cmd-deaths').innerHTML !== html) $('#cmd-deaths').innerHTML = html;
}
$('#cmd-deaths').addEventListener('click', e => {
  const b = e.target.closest('[data-cd]');
  if (b && state) dispatch({ t: 'CMD_DEATH', id: +b.dataset.cd, d: +b.dataset.d });
});

/* ----- opening hand: keep, or mulligan (London: draw 7, put one on the bottom per mulligan) ----- */
let mullPick = null;           // cards chosen to go to the bottom, while keeping
function mullBottom(seat) { return Math.min(7, Math.max(0, (seat.mull || 0) - (seat.freeMull ? 1 : 0))); }
function renderMull(s) {
  const seat = s.seats?.[mySeat()];
  const show = viewSeat === mySeat() && !!seat?.deckName && seat.kept === false;
  if (!show) mullPick = null;
  $('#mull-bar').hidden = !show;
  if (!show) return;
  const n = mullBottom(seat);
  const html = mullPick
    ? `<span>Click ${n} card${n > 1 ? 's' : ''} in your hand to put on the bottom <b>${mullPick.size}/${n}</b></span>
       <button class="chip gold" data-mull="confirm" ${mullPick.size === n ? '' : 'disabled'}>Put on the bottom and keep</button><button class="chip" data-mull="back">Back</button>`
    : `<span><b>Opening hand.</b> ${seat.mull ? `Mulligans: ${seat.mull}${seat.freeMull ? ' (the first is free)' : ''}. Keeping puts ${n} card${n === 1 ? '' : 's'} on the bottom.` : 'Keep these 7, or mulligan for a new 7.'}</span>
       <button class="chip gold" data-mull="keep">Keep</button><button class="chip" data-mull="mull">Mulligan</button>`;
  if ($('#mull-bar').innerHTML !== html) $('#mull-bar').innerHTML = html;
}
function mulligan() {
  const me = mySeat(), seat = state.seats?.[me];
  if (!seat?.deckName) return;
  mullPick = null;
  dispatch({ t: 'SEAT_MULLIGAN', seat: me, order: shuffle([...seat.zones.library, ...seat.zones.hand]), n: 7 });
}
$('#mull-bar').addEventListener('click', e => {
  const b = e.target.closest('[data-mull]');
  if (!b || !state) return;
  const me = mySeat(), seat = state.seats?.[me];
  if (!seat) return;
  const a = b.dataset.mull;
  if (a === 'mull') mulligan();
  else if (a === 'keep') { if (mullBottom(seat)) { mullPick = new Set(); renderAll(state); } else dispatch({ t: 'SEAT_KEEP', seat: me, ids: [] }); }
  else if (a === 'back') { mullPick = null; renderAll(state); }
  else if (a === 'confirm' && mullPick) { const ids = [...mullPick]; mullPick = null; dispatch({ t: 'SEAT_KEEP', seat: me, ids }); }
});

/* =================== zoom preview =================== */
let zoomFor = null, zoomTimer = 0;
function cardIdOf(t) {
  if (t.classList.contains('card')) return t._ids?.[0];
  if (t.classList.contains('vcard')) return +t.dataset.id;
  const pile = t.closest('.pile');
  if (pile?.dataset.pile && state) {
    const [, seat, zone] = pile.dataset.pile.split(':');
    return ['graveyard', 'exile', 'command'].includes(zone) ? state.seats?.[seat]?.zones[zone].at(-1) : undefined;
  }
  if (pile && state) { const z = state.zones[pile.id.replace('pile-', '')]; return z.at(-1); }
}
function showZoom(t) {
  const id = cardIdOf(t);
  const c = state?.cards[id];
  if (!c) return;
  const d = face(db, c);
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
    if (c.owner) { if (survivorSick(state, c) && !hasKw(db, c, 'haste')) tags.push('<span class="tag">Summoning sick</span>'); }
    else if (c.cantAttack) tags.push('<span class="tag">Can\'t attack or block</span>');
    else if (!canAttack(state, { ...c, tapped: false })) tags.push('<span class="tag">Summoning sick</span>');
    else tags.push('<span class="tag">Haste</span>');
  }
  if (c.flashback) tags.push('<span class="tag">Recast from graveyard</span>');
  if (db[c.ref]?.back) tags.push(`<span class="tag hot">Double-faced · F to transform${c.flipped ? ' back' : ''}</span>`);
  if (isWalker(db, c) && zone === 'battlefield') tags.push(`<span class="tag hot">Loyalty ${(parseInt(d.loyalty) || 0) + (c.loy || 0)}</span>`);
  if (c.marks) tags.push(`<span class="tag">${c.marks} counter${c.marks > 1 ? 's' : ''}</span>`);
  if (c.commander && c.deaths) tags.push(`<span class="tag">Died ${c.deaths}×</span>`);
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
  if (t.parentElement?.id === 'seat-hand') { hideZoom(); return; }
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
    if (mullPick && d.card.parentElement?.id === 'seat-hand') {          // choosing cards for the bottom
      const id = d.card._ids[0], n = mullBottom(state.seats[mySeat()]);
      if (mullPick.has(id)) mullPick.delete(id); else if (mullPick.size < n) mullPick.add(id);
      renderAll(state);
      return;
    }
    if (!e.target.closest('.act')) openCardMenu(d.card, e.clientX, e.clientY);
    return;
  }
  document.body.classList.remove('dragging');
  d.hot?.classList.remove('drop-hot');
  const gr = d.ghost.getBoundingClientRect();
  d.ghost.remove();
  d.card.style.opacity = '';
  const onCard = document.elementFromPoint(e.clientX, e.clientY)?.closest('.card:not(.ghost)');
  const moving = state.cards[d.card._ids[0]];
  if (onCard && onCard !== d.card && onCard._ids && isAttachable(moving)) {
    const host = state.cards[onCard._ids[0]];
    const fromZ = zoneOf(state, moving.id);
    if (host && zoneOf(state, host.id) === 'battlefield' && ['battlefield', 'hand', 'command'].includes(fromZ)) {
      (fromZ === 'battlefield' ? Promise.resolve() : castIds([moving.id])).then(() => attachTo(moving.id, host.id));
      return;
    }
  }
  const target = dropTarget(e.clientX, e.clientY);
  if (!target) return;
  const to = target.dataset.drop.replace(/^s:/, '');   // dock zones are the card owner's zones
  const ids = d.shift ? d.card._ids : [d.card._ids[0]];
  const from = zoneOf(state, ids[0]);
  // Dropped on a lane of your board: it stays there (null = the lane its type would pick anyway).
  const lk = target.dataset.lk, c0 = state.cards[ids[0]];
  const setLane = () => lk && c0.owner && dispatch({ t: 'LANE', ids, lane: lk === autoLane(db, state.cards[ids[0]] || c0) ? null : lk });
  if (to === from) { if (to === 'battlefield' && lk && lk !== (c0.lane || autoLane(db, c0))) setLane(); return; }
  // Start the FLIP from where the card was dropped.
  if (ids.length === d.card._ids.length) {
    const cr = d.card.getBoundingClientRect();
    d.card.style.transform = `translate(${gr.left - cr.left}px, ${gr.top - cr.top}px)`;
  }
  (to === 'battlefield' && from !== 'battlefield' ? castIds(ids).then(() => to === 'battlefield' && setLane()) : dispatch({ t: 'MOVE', ids, to, pos: 'top' })).then(afterResolve);
});

/* =================== keyboard =================== */
function hoveredCard() { const l = document.querySelectorAll('.card:hover'); return l[l.length - 1] || null; }
function toggleKeys() { $('#keys-help').classList.toggle('on'); }
$('#btn-keys').addEventListener('click', toggleKeys);

// Letter keys: the open menu's item with that letter, else an action on the card under the mouse.
function letterKey(k, e) {
  if (menuState) {
    const i = menuState.items.findIndex(it => it !== 'sep' && it.kbd === k.toUpperCase());
    if (i >= 0) { $(`#menu [data-i="${i}"]`)?.click(); return true; }
    return false;
  }
  const el = hoveredCard();
  if (el?._ids && !busy) {
    const id = el._ids[0], c = state.cards[id];
    if (!c) return false;
    const zone = zoneOf(state, id);
    const mv = to => dispatch({ t: 'MOVE', ids: [id], to });
    switch (k) {
      case 't': if (zone === 'battlefield') { dispatch({ t: 'TAP', ids: [id], v: !c.tapped }); return true; } break;
      case 'd': if (['battlefield', 'hand'].includes(zone)) { mv('graveyard').then(afterResolve); return true; } break;
      case 'e': if (['battlefield', 'hand', 'graveyard'].includes(zone)) { mv('exile').then(afterResolve); return true; } break;
      case 'h': if (['battlefield', 'graveyard', 'exile'].includes(zone)) { mv('hand'); return true; } break;
      case 'p': if (c.owner && (zone === 'hand' || zone === 'command')) { castIds([id]); return true; } break;
      case 'a': if (c.owner && c.creature && zone === 'battlefield' && state.phase === 'survivors') { dispatch({ t: 'ATTACK', ids: [id], v: !c.attacking }, false); return true; } break;
      case 'b': if (!c.owner && c.attacking && state.phase === 'combat') { const r = el.getBoundingClientRect(); chooseBlocker(id, r.left + r.width / 2, r.top + r.height / 2); return true; } break;
      case 'f': if (db[c.ref]?.back) { dispatch({ t: 'FLIP', ids: [id] }); return true; } break;
      case '+': case '=': case '-': {
        if (!['battlefield', 'exile'].includes(zone)) break;
        const d = k === '-' ? -1 : 1;
        const kind = zone !== 'battlefield' ? 'generic' : isWalker(db, c) ? 'loyalty' : c.creature ? undefined : 'generic';
        dispatch({ t: 'COUNTER', ids: [id], d, ...(kind ? { kind } : {}) });
        return true;
      }
    }
  }
  const me = mySeat();
  if (busy) return false;
  switch (k) {
    case 'n': if (state.seats?.[me]?.deckName) { dispatch({ t: 'SEAT_DRAW', seat: me, n: 1 }); return true; } break;
    case 'u': if (state.seats?.[me]?.deckName) { dispatch({ t: 'UNTAP_ALL', seat: me }); return true; } break;
    case 'k': toggleDrawer('#drawer-tokens'); return true;
    case 'l': toggleDrawer('#drawer-log'); return true;
  }
  return false;
}

document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea, select')) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (e.key === 'Escape') { closeMenu(); hideZoom(); $$('.drawer.on, #viewer.on, #keys-help.on, #view-menu.on').forEach(x => x.classList.remove('on')); return; }
  if ((e.key === '?' || (e.key === '/' && e.shiftKey)) && $('#setup').classList.contains('off')) { toggleKeys(); return; }
  // While a panel or dialog is open, or a key is held down, game keys do nothing (menus still take their letters).
  if (e.repeat) return;
  if (!menuState && document.querySelector('.modal.on, .drawer.on, #viewer.on, #result.on, #view-menu.on')) return;
  if (!e.metaKey && !e.ctrlKey && !e.altKey && state && $('#setup').classList.contains('off') && /^[a-z+=-]$/i.test(e.key)) {
    if (letterKey(e.key.toLowerCase(), e)) { e.preventDefault(); return; }
  }
  if ((e.key === ' ' || e.key === 'Enter') && state && $('#setup').classList.contains('off') && !$('#result').classList.contains('on')) {
    e.preventDefault(); primary();
  }
});

/* =================== boot =================== */
showSetup();
loadDeckArt();
