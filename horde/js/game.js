// Pure game state + reducer. Every change is a serializable action, so the
// same reducer can later run on a server and be broadcast to all players.

export const PILES = ['library', 'graveyard', 'exile'];
const ZONE_LABEL = {
  library: 'the library', graveyard: 'the graveyard', exile: 'exile', hand: "the Horde's hand",
  battlefield: 'the battlefield', reveal: 'reveal', stack: 'the stack',
};

function mkCard(id, e) {
  return {
    id, ref: e.ref, name: e.name, token: e.type === 'token', creature: !!e.creature, spell: !!e.spell,
    flashback: !!e.flashback, flashbackExile: e.flashbackExile !== false, cantAttack: !!e.cantAttack,
    tapped: false, counters: 0, attacking: false, blocked: false, enteredTurn: 0, castFromGy: false,
  };
}

export function initState({ deck, entries, opts }) {
  const s = {
    deck, opts,
    cards: {},
    zones: { library: [], reveal: [], stack: [], hand: [], battlefield: [], graveyard: [], exile: [] },
    life: opts.life, poison: 0, hordeLife: opts.hordeLife ? 20 : null,
    turn: 0, phase: 'setup', setupLeft: 3, anthem: 0, lastCast: [],
    log: [], nextId: 1, startSize: entries.length,
  };
  for (const e of entries) { const id = s.nextId++; s.cards[id] = mkCard(id, e); s.zones.library.push(id); }
  log(s, `Game started: ${deck.name} Horde (${entries.length} cards), Survivors at ${s.life} life.`);
  return s;
}

export function zoneOf(s, id) {
  for (const z in s.zones) if (s.zones[z].includes(id)) return z;
  return null;
}
function detach(s, id) {
  for (const z in s.zones) {
    const i = s.zones[z].indexOf(id);
    if (i >= 0) { s.zones[z].splice(i, 1); return z; }
  }
  return null;
}
function log(s, msg) {
  s.log.push({ turn: s.turn, msg });
  if (s.log.length > 400) s.log.shift();
}
function names(s, ids) {
  const m = new Map();
  for (const id of ids) { const n = s.cards[id]?.name; if (n) m.set(n, (m.get(n) || 0) + 1); }
  return [...m].map(([n, k]) => (k > 1 ? `${k}× ${n}` : n)).join(', ');
}

/** Move one card. Returns 'vanish' if a token ceased to exist. */
function put(s, id, to, pos) {
  const c = s.cards[id];
  const from = detach(s, id);
  if (to !== 'battlefield') { c.tapped = false; c.counters = 0; c.attacking = false; c.blocked = false; }
  if (c.token && !['battlefield', 'reveal', 'stack'].includes(to) && !s.opts.tokensPersist) {
    delete s.cards[id];
    return 'vanish';
  }
  if (to === 'battlefield' && from !== 'battlefield') c.enteredTurn = s.turn;
  if (to === 'library') pos === 'bottom' ? s.zones.library.push(id) : s.zones.library.unshift(id);
  else s.zones[to].push(id);
  return from;
}

export function canAttack(s, c) {
  return c.creature && !c.cantAttack && !c.tapped &&
    (s.deck.haste === 'all' || (s.deck.haste === 'tokens' && c.token) || c.enteredTurn < s.turn);
}

export function status(s) {
  if (s.life <= 0) return 'lose';
  // Normal Magic: 10 poison loses. The Phyrexian Horde replaces that with exiling cards.
  if (!s.deck.poison && s.poison >= 10) return 'lose';
  if (s.phase === 'setup') return null;
  const z = s.zones;
  if (z.library.length || z.reveal.length || z.stack.length || z.hand.length) return null;
  if (z.battlefield.some(id => { const c = s.cards[id]; return c.creature && !c.cantAttack; })) return null;
  return 'win';
}

export function reduce(s0, a) {
  const s = structuredClone(s0);
  const z = s.zones;
  switch (a.t) {
    case 'MOVE': {
      const ids = a.ids.filter(id => s.cards[id]);
      if (!ids.length) break;
      const label = names(s, ids);
      let gone = 0;
      for (const id of ids) if (put(s, id, a.to, a.pos) === 'vanish') gone++;
      const where = a.to === 'library' ? `the ${a.pos === 'bottom' ? 'bottom' : 'top'} of the library` : ZONE_LABEL[a.to];
      log(s, gone === ids.length && ids.length
        ? `${label} left the battlefield (token${gone > 1 ? 's' : ''} cease to exist).`
        : `${label} → ${where}.`);
      break;
    }
    case 'REVEAL': {
      const id = z.library.shift();
      if (id) z.reveal.push(id);
      break;
    }
    case 'DRAW': {
      const ids = z.library.splice(0, a.n || 1);
      z.hand.push(...ids);
      if (ids.length) log(s, `Horde draws ${names(s, ids)}.`);
      break;
    }
    case 'GATHER_CASTS': {
      const fromHand = [...z.hand];
      const fromGy = z.graveyard.filter(id => s.cards[id].flashback);
      for (const id of fromHand) { detach(s, id); z.reveal.push(id); }
      for (const id of fromGy) { detach(s, id); s.cards[id].castFromGy = true; z.reveal.push(id); }
      if (fromHand.length) log(s, `Horde casts from hand: ${names(s, fromHand)}.`);
      if (fromGy.length) log(s, `Horde casts from graveyard: ${names(s, fromGy)}.`);
      break;
    }
    case 'CAST_REVEALED': {
      const ids = a.ids ? a.ids.filter(id => z.reveal.includes(id)) : [...z.reveal];
      for (const id of ids) {
        const c = s.cards[id];
        detach(s, id);
        if (c.spell) z.stack.push(id);
        else { z.battlefield.push(id); c.enteredTurn = s.turn; }
      }
      s.lastCast = [...(s.lastCast || []), ...ids];
      if (ids.length) log(s, `Horde casts ${names(s, ids)}.`);
      break;
    }
    case 'RESOLVE_STACK': {
      const c = s.cards[a.id];
      if (!c) break;
      detach(s, a.id);
      const to = a.countered ? 'graveyard' : (c.castFromGy && c.flashbackExile ? 'exile' : 'graveyard');
      c.castFromGy = false;
      z[to].push(a.id);
      log(s, `${c.name} ${a.countered ? 'was countered' : 'resolved'}.`);
      break;
    }
    case 'START_HORDE_TURN': {
      if (s.phase !== 'horde-ready') break; // two players pressed it at once
      s.turn++; s.phase = 'horde'; s.lastCast = [];
      for (const id of z.battlefield) { const c = s.cards[id]; c.tapped = false; c.attacking = false; c.blocked = false; }
      log(s, `— Horde turn ${s.turn} —`);
      break;
    }
    case 'PHASE': if (a.from && s.phase !== a.from) break; s.phase = a.phase; break;
    case 'BEGIN_COMBAT': {
      if (s.phase === 'combat') break;
      for (const id of a.ids) if (s.cards[id]) s.cards[id].attacking = true;
      s.phase = 'combat';
      log(s, a.ids.length ? `Horde attacks with ${names(s, a.ids)}.` : 'Horde has no creatures able to attack.');
      break;
    }
    case 'ATTACK': for (const id of a.ids) if (s.cards[id]) { s.cards[id].attacking = a.v; s.cards[id].blocked = false; } break;
    case 'BLOCK': for (const id of a.ids) if (s.cards[id]) s.cards[id].blocked = a.v; break;
    case 'END_COMBAT': {
      if (s.phase !== 'combat') break;
      s.life -= a.damage;
      const pz = a.poison || 0;
      if (pz) {
        s.poison += pz;
        log(s, `Survivors get ${pz} poison counter${pz > 1 ? 's' : ''} (total ${s.poison}).` +
          (s.deck.poison ? ` Each Survivor exiles the top ${pz} card${pz > 1 ? 's' : ''} of their library face down.` : ''));
      }
      for (const id of z.battlefield) { const c = s.cards[id]; c.attacking = false; c.blocked = false; }
      s.phase = 'survivors';
      log(s, `Survivors take ${a.damage} combat damage (life ${s.life}).`);
      break;
    }
    case 'END_SURVIVOR_TURN': {
      if (s.phase !== 'setup' && s.phase !== 'survivors') break;
      if (a.setupLeft !== undefined && a.setupLeft !== s.setupLeft) break; // a second press of the same button
      if (s.phase === 'setup') {
        s.setupLeft--;
        log(s, `Survivors end setup turn ${3 - s.setupLeft}.`);
        if (s.setupLeft > 0) break;
      } else log(s, 'Survivors end their turn.');
      s.phase = 'horde-ready';
      break;
    }
    case 'LIFE': s.life += a.d; break;
    case 'POISON': s.poison = Math.max(0, s.poison + a.d); break;
    case 'HORDE_LIFE': if (s.hordeLife !== null) s.hordeLife = Math.max(0, s.hordeLife + a.d); break;
    case 'MILL': {
      const ids = z.library.slice(0, a.n);
      const label = names(s, ids);
      for (const id of ids) put(s, id, 'graveyard');
      if (ids.length) log(s, `Horde mills ${ids.length}: ${label}.`);
      break;
    }
    case 'DAMAGE_HORDE': {
      let n = a.n;
      if (s.hordeLife !== null && s.hordeLife > 0) {
        const absorbed = Math.min(s.hordeLife, n);
        s.hordeLife -= absorbed; n -= absorbed;
        log(s, `Horde takes ${absorbed} damage (life ${s.hordeLife}).`);
      }
      if (n > 0) {
        const ids = z.library.slice(0, n);
        const label = names(s, ids);
        for (const id of ids) put(s, id, 'graveyard');
        log(s, ids.length ? `Horde takes ${n} damage and mills ${ids.length}: ${label}.` : `Horde takes ${n} damage (library already empty).`);
      }
      break;
    }
    case 'TAP': for (const id of a.ids) if (s.cards[id]) s.cards[id].tapped = a.v; break;
    case 'COUNTER': for (const id of a.ids) if (s.cards[id]) s.cards[id].counters += a.d; break;
    case 'CREATE': {
      const ids = [];
      for (let i = 0; i < a.n; i++) {
        const id = s.nextId++;
        s.cards[id] = mkCard(id, { ref: a.ref, name: a.name, type: 'token', creature: a.creature });
        s.cards[id].enteredTurn = s.turn;
        z.battlefield.push(id); ids.push(id);
      }
      log(s, `Created ${a.n}× ${a.name} for the Horde.`);
      break;
    }
    case 'SHUFFLE': {
      // Only accept a reordering of the current library (it may have changed while the shuffle was in flight).
      const key = l => [...l].sort((x, y) => x - y).join();
      if (!Array.isArray(a.order) || key(a.order) !== key(z.library)) break;
      z.library = a.order; log(s, 'Horde library shuffled.');
      break;
    }
    case 'ANTHEM': s.anthem = a.d !== undefined ? s.anthem + a.d : a.v; break;
    case 'NOTE': log(s, a.msg); break;
  }
  return s;
}
