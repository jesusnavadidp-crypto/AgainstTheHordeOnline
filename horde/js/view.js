// Board renderer. Cards are keyed DOM elements that persist between renders;
// every move between zones is animated with FLIP (First-Last-Invert-Play).
import { PILES, canAttack } from './game.js?v=6';

const els = new Map();          // entity key -> element
let prevZone = {};              // card id -> zone at last render
let prevRef = {};               // card id -> scryfall id at last render
const EASE = 'cubic-bezier(.2,.9,.25,1)';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const DUR = reduced ? 0 : 520;

export function power(s, db, c) {
  const d = db[c.ref] || {};
  const p = parseInt(d.power), t = parseInt(d.toughness);
  return {
    p: (isNaN(p) ? 0 : p) + c.counters + s.anthem,
    t: (isNaN(t) ? 0 : t) + c.counters + s.anthem,
    raw: d.power != null,
  };
}

function entities(s) {
  const out = { 'bf-creatures': [], 'bf-other': [], 'attack-lane': [], 'reveal-lane': [], 'stack-lane': [], 'hand-row': [] };
  const groups = new Map();
  for (const id of s.zones.battlefield) {
    const c = s.cards[id];
    const cont = c.attacking ? 'attack-lane' : c.creature ? 'bf-creatures' : 'bf-other';
    if (c.token) {
      const key = `g:${c.ref}|${+c.tapped}|${c.counters}|${+c.attacking}|${+c.blocked}`;
      let g = groups.get(key);
      if (!g) { g = { key, ids: [], cont, group: true }; groups.set(key, g); out[cont].push(g); }
      g.ids.push(id);
    } else out[cont].push({ key: 'c:' + id, ids: [id], cont });
  }
  for (const [zn, cont] of [['reveal', 'reveal-lane'], ['stack', 'stack-lane'], ['hand', 'hand-row']])
    for (const id of s.zones[zn]) out[cont].push({ key: 'c:' + id, ids: [id], cont });
  return out;
}

function cardShell() {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `<div class="tilt"><div class="inner"><div class="face front"><img alt="" draggable="false"><div class="fallback"></div></div><div class="face back"></div></div></div>
    <div class="badge count"></div><div class="badge ctr"></div><div class="badge pt"></div><div class="acts"></div>`;
  return el;
}

function setFace(el, d, name) {
  const img = el.querySelector('img');
  const src = d?.img || '';
  if (img.dataset.src !== src) { img.dataset.src = src; if (src) img.src = src; else img.removeAttribute('src'); }
  el.querySelector('.front').classList.toggle('noimg', !src);
  el.querySelector('.fallback').innerHTML = `<b>${esc(name)}</b><span>${esc(d?.type || '')}</span>`;
}

export const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

function update(el, e, s, db) {
  const c = s.cards[e.ids[0]];
  const d = db[c.ref];
  setFace(el, d, c.name);
  const n = e.ids.length;
  el.classList.toggle('tapped', c.tapped);
  el.classList.toggle('attacking', c.attacking);
  el.classList.toggle('blocked', c.blocked);
  el.classList.toggle('token', c.token);
  el.classList.toggle('stacked', n > 1);
  el.classList.toggle('stacked3', n > 2);
  el.classList.toggle('sick', c.creature && e.cont === 'bf-creatures' && s.phase !== 'setup' && !canAttack(s, { ...c, tapped: false }) && !c.cantAttack);
  el.classList.toggle('pacifist', c.cantAttack);
  el.querySelector('.count').textContent = n > 1 ? '×' + n : '';
  el.querySelector('.ctr').textContent = c.counters ? (c.counters > 0 ? '+' : '') + c.counters + '/' + (c.counters > 0 ? '+' : '') + c.counters : '';
  const pt = el.querySelector('.pt');
  if (c.creature && s.zones.battlefield.includes(c.id)) {
    const { p, t } = power(s, db, c);
    pt.textContent = `${p}/${t}`;
    pt.classList.toggle('buffed', c.counters + s.anthem > 0);
  } else pt.textContent = '';

  // contextual action buttons on the card
  let acts = '';
  if (e.cont === 'attack-lane') {
    acts = c.blocked
      ? `<button class="act" data-act="unblock">Unblock</button>`
      : `<button class="act" data-act="block">${n > 1 ? 'Block 1' : 'Block'}</button>`;
    acts += `<button class="act danger" data-act="kill">${n > 1 ? 'Kill 1' : 'Kill'}</button>`;
  } else if (e.cont === 'stack-lane') {
    acts = `<button class="act primary" data-act="resolve">Resolved</button><button class="act" data-act="counter">Countered</button>`;
  }
  const box = el.querySelector('.acts');
  if (box.innerHTML !== acts) box.innerHTML = acts;
  el.title = '';
}

function rect(el) { return el.getBoundingClientRect(); }
function pileRects() {
  const r = {};
  for (const p of PILES) r[p] = rect(document.querySelector(`#pile-${p} .pile-top`));
  return r;
}

function flip(el, from, to, faceFlip) {
  if (!DUR) return;
  const dx = from.left - to.left, dy = from.top - to.top, sx = from.width / to.width || 1;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01) return;
  el.animate([{ transform: `translate(${dx}px,${dy}px) scale(${sx})` }, { transform: 'none' }],
    { duration: DUR, easing: EASE });
  if (faceFlip) el.querySelector('.inner').animate(
    [{ transform: 'rotateY(180deg)' }, { transform: 'rotateY(180deg)', offset: 0.35 }, { transform: 'rotateY(0)' }],
    { duration: DUR + 150, easing: EASE });
}

function spawn(el) {
  if (!DUR) return;
  el.animate([{ transform: 'scale(.4)', opacity: 0, filter: 'brightness(3)' }, { transform: 'scale(1.06)', opacity: 1, offset: 0.6 }, { transform: 'none', filter: 'none' }],
    { duration: DUR, easing: EASE });
}

// A temporary flying card in the fx layer.
function ghost({ from, to, img, faceDown, flipToFront, mode, delay = 0, el: src }) {
  if (!DUR) return;
  const fx = document.getElementById('fx');
  const g = src || cardShell();
  if (!src && img) { g.querySelector('img').src = img; }
  if (!src && !img) g.querySelector('.front').classList.add('noimg');
  g.classList.add('ghost');
  Object.assign(g.style, { left: from.left + 'px', top: from.top + 'px', width: from.width + 'px', height: from.height + 'px' });
  if (faceDown) g.querySelector('.inner').style.transform = 'rotateY(180deg)';
  fx.appendChild(g);
  let anim;
  if (mode === 'poof') {
    anim = g.animate([{ transform: 'none', opacity: 1, filter: 'none' },
      { transform: 'scale(1.15) translateY(-10px)', opacity: 0, filter: 'blur(6px) brightness(2)' }],
      { duration: 520, easing: 'ease-out', delay, fill: 'both' });
  } else {
    const dx = to.left - from.left, dy = to.top - from.top, sx = to.width / from.width || 1;
    anim = g.animate([{ transform: 'none', opacity: 1 }, { transform: `translate(${dx}px,${dy - 30}px) scale(${(1 + sx) / 2}) rotate(-6deg)`, opacity: 1, offset: 0.5 },
      { transform: `translate(${dx}px,${dy}px) scale(${sx})`, opacity: mode === 'vanishAtEnd' ? 0 : 1 }],
      { duration: DUR + 80, easing: EASE, delay, fill: 'both' });
    if (flipToFront) g.querySelector('.inner').animate([{ transform: 'rotateY(180deg)' }, { transform: 'rotateY(0)' }],
      { duration: DUR, easing: EASE, delay, fill: 'both' });
  }
  anim.onfinish = () => g.remove();
}

function zoneMap(s) {
  const m = {};
  for (const zn in s.zones) for (const id of s.zones[zn]) m[id] = zn;
  return m;
}

function updatePiles(s, db) {
  for (const p of PILES) {
    const pile = document.getElementById('pile-' + p);
    const ids = s.zones[p];
    const cnt = pile.querySelector('.pile-count');
    const before = +cnt.dataset.n || 0;
    cnt.textContent = ids.length;
    cnt.dataset.n = ids.length;
    pile.classList.toggle('empty', !ids.length);
    pile.style.setProperty('--depth', Math.min(10, Math.ceil(ids.length / 8)));
    if (p !== 'library') {
      const top = ids.length ? s.cards[ids[ids.length - 1]] : null;
      const img = pile.querySelector('.pile-top img');
      const src = top ? db[top.ref]?.img || '' : '';
      if (img.dataset.src !== src) { img.dataset.src = src; src ? (img.src = src) : img.removeAttribute('src'); }
      pile.querySelector('.pile-top').classList.toggle('has', !!top);
    }
    if (before !== ids.length && DUR) pile.querySelector('.pile-top').animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }], { duration: 300, delay: 250 });
  }
}

export function resetView() {
  for (const el of els.values()) el.remove();
  els.clear();
  prevZone = {};
  prevRef = {};
}

export function render(s, db) {
  // FIRST: where is everything right now?
  const prevKeyRect = new Map(), prevIdRect = new Map();
  for (const [key, el] of els) {
    const r = rect(el);
    prevKeyRect.set(key, r);
    for (const id of el._ids) prevIdRect.set(id, r);
  }
  const pilesBefore = pileRects();
  const newZone = zoneMap(s);
  for (const el of els.values()) { el.style.transform = ''; el.style.opacity = ''; } // drop offsets set by drag & drop

  // Build / reuse elements
  const ents = entities(s);
  const seen = new Set();
  for (const cont in ents) {
    const host = document.getElementById(cont);
    let i = 0;
    for (const e of ents[cont]) {
      seen.add(e.key);
      let el = els.get(e.key);
      const isNew = !el;
      if (isNew) { el = cardShell(); el._key = e.key; els.set(e.key, el); }
      el._ids = e.ids; el._ent = e; el._isNew = isNew;
      update(el, e, s, db);
      if (host.children[i] !== el) host.insertBefore(el, host.children[i] || null);
      i++;
    }
    host.classList.toggle('has-cards', i > 0);
  }
  const removed = [];
  for (const [key, el] of els) if (!seen.has(key)) { removed.push(el); els.delete(key); el.remove(); }
  updatePiles(s, db);
  document.body.classList.toggle('show-spotlight', s.zones.reveal.length + s.zones.stack.length > 0);
  document.body.classList.toggle('show-attack', s.zones.battlefield.some(id => s.cards[id].attacking));

  // LAST + INVERT + PLAY
  const pilesAfter = pileRects();
  for (const [key, el] of els) {
    const to = rect(el);
    if (!el._isNew) { flip(el, prevKeyRect.get(key), to, false); continue; }
    const id = el._ids[0];
    const pz = prevZone[id];
    const from = prevIdRect.get(id) || (PILES.includes(pz) ? pilesBefore[pz] : null);
    if (from) flip(el, from, to, pz === 'library');
    else spawn(el);
  }
  const takenIds = new Set();
  for (const el of removed) {
    const id = el._ids[0];
    const from = prevKeyRect.get(el._key);
    const zn = newZone[id];
    for (const i of el._ids) takenIds.add(i);
    if (!s.cards[id]) { ghost({ from, mode: 'poof', el }); continue; }
    if (PILES.includes(zn)) { ghost({ from, to: pilesAfter[zn], el }); continue; }
    const tgt = [...els.values()].find(x => x._ids.includes(id));
    if (tgt && !tgt._isNew) ghost({ from, to: rect(tgt), el, mode: 'vanishAtEnd' });
  }
  // Pile-to-pile movement (mill, library → exile, etc.) never has a DOM card; fly a few ghosts.
  let k = 0;
  for (const id in prevZone) {
    if (takenIds.has(+id)) continue;
    const a = prevZone[id], b = newZone[id];
    if (!PILES.includes(a) || a === b) continue;
    if (b && !PILES.includes(b)) continue;
    if (k >= 14) break;
    const ref = s.cards[id]?.ref || prevRef[id];
    const from = pilesBefore[a];
    if (!b) { ghost({ from, to: pilesAfter.graveyard, img: db[ref]?.img, faceDown: a === 'library', flipToFront: a === 'library', mode: 'vanishAtEnd', delay: k * 70 }); }
    else ghost({ from, to: pilesAfter[b], img: db[ref]?.img, faceDown: a === 'library', flipToFront: a === 'library' && b !== 'library', delay: k * 70 });
    k++;
  }
  prevZone = newZone;
  prevRef = {};
  for (const id in s.cards) prevRef[id] = s.cards[id].ref;
}
