// Pure game state + reducer. Every change is a serializable action, so the
// same reducer can later run on a server and be broadcast to all players.

export const PILES = ['library', 'graveyard', 'exile'];
// Each Survivor ("seat") has their own zones. Their cards carry `owner: seatId`.
export const SEAT_ZONES = ['library', 'hand', 'battlefield', 'graveyard', 'exile', 'command'];
const seatZones = () => Object.fromEntries(SEAT_ZONES.map(z => [z, []]));
/** The zones object a card lives in: its owner's, or the Horde's. */
const own = (o, k) => !!o && Object.hasOwn(o, k);
export const seatOf = (s, id) => (own(s.seats, id) ? s.seats[id] : null);
export const homeOf = (s, c) => (c.owner ? seatOf(s, c.owner)?.zones : s.zones);
const ZONE_LABEL = {
  library: 'the library', graveyard: 'the graveyard', exile: 'exile', hand: "the Horde's hand",
  battlefield: 'the battlefield', reveal: 'reveal', stack: 'the stack',
};

function mkCard(id, e, owner) {
  return {
    id, ref: e.ref, name: e.name, token: e.type === 'token', creature: !!e.creature, spell: !!e.spell, owner: owner || undefined,
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
    seats: {}, sTurn: 1,        // sTurn counts Survivor turns (setup ones included), for summoning sickness
    log: [], nextId: 1, startSize: entries.length,
  };
  for (const e of entries) { const id = s.nextId++; s.cards[id] = mkCard(id, e); s.zones.library.push(id); }
  log(s, `Game started: ${deck.name} Horde (${entries.length} cards), Survivors at ${s.life} life.`);
  return s;
}

export function zoneOf(s, id) {
  const c = s.cards[id];
  const zs = c ? homeOf(s, c) : s.zones;
  for (const z in zs || {}) if (zs[z].includes(id)) return z;
  return null;
}
function allZones(s) {
  const out = [s.zones];
  for (const k in s.seats || {}) out.push(s.seats[k].zones);
  return out;
}
function detach(s, id) {
  for (const zs of allZones(s)) for (const z in zs) {
    const i = zs[z].indexOf(id);
    if (i >= 0) { zs[z].splice(i, 1); return z; }
  }
  return null;
}
const seatName = (s, seat) => seatOf(s, seat)?.name || 'A Survivor';
// A reordering is only applied if it is exactly the same set of cards (it may be stale).
const samePerm = (a, b) => Array.isArray(a) && a.length === b.length && [...a].sort((x, y) => x - y).join() === [...b].sort((x, y) => x - y).join();
function seatDraw(s, seat, n) {
  const zs = s.seats[seat].zones;
  const ids = zs.library.splice(0, n);
  zs.hand.push(...ids);
  return ids.length;
}
// Start of a Survivor turn: everyone untaps and draws a card.
function survivorsUpkeep(s) {
  s.sTurn = (s.sTurn || 1) + 1;
  for (const k in s.seats || {}) {
    const zs = s.seats[k].zones;
    for (const id of zs.battlefield) { const c = s.cards[id]; c.tapped = false; c.attacking = false; c.blocking = null; }
    seatDraw(s, k, 1);
  }
  if (Object.keys(s.seats || {}).length) log(s, 'Survivors untap and draw a card.');
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
  if (to !== 'battlefield') {
    // Leaving the battlefield: it falls off what it was attached to, and what was attached to it
    // falls off too (Auras go to the graveyard with it, Equipment stays).
    if (from === 'battlefield' || c.attachedTo) {
      c.attachedTo = null;
      for (const k in s.cards) {
        const o = s.cards[k];
        if (o.attachedTo !== id) continue;
        o.attachedTo = null;
        if (o.aura) put(s, o.id, 'graveyard');
      }
    }
    if (c.blocking && s.cards[c.blocking]) s.cards[c.blocking].blockedBy = null;     // attacker stays blocked
    if (c.blockedBy && s.cards[c.blockedBy]) s.cards[c.blockedBy].blocking = null;
    c.tapped = false; c.counters = 0; c.attacking = false; c.blocked = false; c.blockedBy = null; c.blocking = null;
  }
  if (c.token && !['battlefield', 'reveal', 'stack'].includes(to) && !s.opts.tokensPersist) {
    delete s.cards[id];
    return 'vanish';
  }
  const zs = homeOf(s, c);
  if (!zs[to]) to = 'graveyard';                    // e.g. a Survivor card sent to the Horde's stack
  if (to === 'battlefield' && from !== 'battlefield') { c.enteredTurn = s.turn; c.enteredS = s.sTurn; }
  if (to === 'library') pos === 'bottom' ? zs.library.push(id) : zs.library.unshift(id);
  else zs[to].push(id);
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
  s.seats ||= {};                      // games saved before Survivor decks existed
  s.sTurn ||= 1;
  const z = s.zones;
  switch (a.t) {
    case 'MOVE': {
      const ids = [...new Set(a.ids || [])].filter(id => s.cards[id]);
      if (!ids.length) break;
      // A Survivor's hand and library are hidden: don't name cards moving only between them.
      const c0 = s.cards[ids[0]];
      const hiddenMove = c0.owner && ['hand', 'library'].includes(zoneOf(s, ids[0])) && ['hand', 'library'].includes(a.to);
      const label = hiddenMove ? `${ids.length} card${ids.length > 1 ? 's' : ''}` : names(s, ids);
      let gone = 0;
      for (const id of ids) if (put(s, id, a.to, a.pos) === 'vanish') gone++;
      const own = s.cards[ids[0]]?.owner;
      let where = a.to === 'library' ? `the ${a.pos === 'bottom' ? 'bottom' : 'top'} of the library` : ZONE_LABEL[a.to];
      if (!where) where = a.to;
      if (own) where = a.to === 'library' ? `the ${a.pos === 'bottom' ? 'bottom' : 'top'} of ${seatName(s, own)}'s library`
        : a.to === 'battlefield' ? 'the battlefield' : `${seatName(s, own)}'s ${a.to === 'command' ? 'command zone' : a.to}`;
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
      for (const id of z.battlefield) { const c = s.cards[id]; c.tapped = false; c.attacking = false; c.blocked = false; c.blockedBy = null; }
      for (const k in s.seats) for (const id of s.seats[k].zones.battlefield) { s.cards[id].attacking = false; s.cards[id].blocking = null; }
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
    case 'ATTACK': for (const id of a.ids || []) {
      const c = s.cards[id];
      if (!c) continue;
      if (c.blockedBy && s.cards[c.blockedBy]) s.cards[c.blockedBy].blocking = null;
      c.attacking = !!a.v; c.blocked = false; c.blockedBy = null;
    } break;
    case 'BLOCK': {
      for (const id of a.ids) {
        const c = s.cards[id];
        if (!c) continue;
        if (c.blockedBy && s.cards[c.blockedBy]) s.cards[c.blockedBy].blocking = null;   // free the old blocker
        c.blocked = a.v; c.blockedBy = null;
        const b = a.v && a.by != null ? s.cards[a.by] : null;
        if (b && b.owner && zoneOf(s, b.id) === 'battlefield') {
          if (b.blocking && s.cards[b.blocking]) { s.cards[b.blocking].blocked = false; s.cards[b.blocking].blockedBy = null; }
          c.blockedBy = b.id; b.blocking = id;
          log(s, `${b.name} (${seatName(s, b.owner)}) blocks ${c.name}.`);
        }
      }
      break;
    }
    case 'END_COMBAT': {
      if (s.phase !== 'combat') break;
      // Results of blocks, worked out by the client that knows the cards' power and toughness:
      // counters: [[id, delta]] (infect / wither), kill: [ids] that die.
      for (const [id, d] of a.counters || []) if (s.cards[id]) s.cards[id].counters += d;
      const dead = (a.kill || []).filter(id => s.cards[id] && zoneOf(s, id) === 'battlefield');
      if (dead.length) log(s, `Dies in combat: ${names(s, dead)}.`);
      for (const id of dead) put(s, id, 'graveyard');
      s.life -= Math.max(0, a.damage || 0);
      const pz = Math.max(0, a.poison || 0);
      if (pz) {
        s.poison += pz;
        log(s, `Survivors get ${pz} poison counter${pz > 1 ? 's' : ''} (total ${s.poison}).` +
          (s.deck.poison ? ` Each Survivor exiles the top ${pz} card${pz > 1 ? 's' : ''} of their library face down.` : ''));
      }
      for (const id of z.battlefield) { const c = s.cards[id]; c.attacking = false; c.blocked = false; c.blockedBy = null; }
      s.phase = 'survivors';
      log(s, `Survivors take ${a.damage} combat damage (life ${s.life}).`);
      survivorsUpkeep(s);
      break;
    }
    case 'END_SURVIVOR_TURN': {
      if (s.phase !== 'setup' && s.phase !== 'survivors') break;
      if (a.setupLeft !== undefined && a.setupLeft !== s.setupLeft) break; // a second press of the same button
      if (s.phase === 'setup') {
        s.setupLeft--;
        log(s, `Survivors end setup turn ${3 - s.setupLeft}.`);
        if (s.setupLeft > 0) { survivorsUpkeep(s); break; }
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
      const owner = a.owner && seatOf(s, a.owner) ? a.owner : undefined;
      const bf = owner ? s.seats[owner].zones.battlefield : z.battlefield;
      for (let i = 0; i < a.n; i++) {
        const id = s.nextId++;
        s.cards[id] = mkCard(id, { ref: a.ref, name: a.name, type: 'token', creature: a.creature }, owner);
        s.cards[id].enteredTurn = s.turn; s.cards[id].enteredS = s.sTurn;
        bf.push(id);
      }
      log(s, `Created ${a.n}× ${a.name} for ${owner ? seatName(s, owner) : 'the Horde'}.`);
      break;
    }

    /* ----- Survivor seats ----- */
    case 'SEAT': {
      if (typeof a.seat !== 'string') break;
      if (!own(s.seats, a.seat)) s.seats[a.seat] = { id: a.seat, name: a.name, deckName: null, zones: seatZones() };
      else s.seats[a.seat].name = a.name;
      break;
    }
    case 'SEAT_DECK': {
      // Replaces this seat's cards with a new deck. `order` is a shuffled list of indexes into
      // the main-deck entries (sent by the client so every copy shuffles the same way).
      if (typeof a.seat !== 'string') break;
      if (!own(s.seats, a.seat)) s.seats[a.seat] = { id: a.seat, name: a.name || 'Survivor', deckName: null, zones: seatZones() };
      const seat = s.seats[a.seat];
      if (a.name) seat.name = a.name;
      for (const zn of SEAT_ZONES) { for (const id of seat.zones[zn]) delete s.cards[id]; seat.zones[zn] = []; }
      const main = [];
      for (const e of a.entries || []) {
        const id = s.nextId++;
        s.cards[id] = mkCard(id, e, a.seat);
        if (e.section === 'commander') s.cards[id].commander = true;
        if (e.section === 'commander') seat.zones.command.push(id); else main.push(id);
      }
      seat.zones.library = samePerm(a.order, main.map((_, i) => i)) ? a.order.map(i => main[i]) : main;
      seat.deckName = a.deckName || 'Deck';
      const drew = seatDraw(s, a.seat, a.hand ?? 7);
      log(s, `${seat.name} brings ${seat.deckName} (${main.length} cards${seat.zones.command.length ? ', commander: ' + names(s, seat.zones.command) : ''}) and draws ${drew}.`);
      break;
    }
    case 'SEAT_DRAW': {
      if (!seatOf(s, a.seat)) break;
      const n = seatDraw(s, a.seat, a.n || 1);
      if (n) log(s, `${seatName(s, a.seat)} draws ${n} card${n > 1 ? 's' : ''}.`);
      break;
    }
    case 'SEAT_SHUFFLE': {
      const seat = seatOf(s, a.seat);
      if (!seat || !samePerm(a.order, seat.zones.library)) break;
      seat.zones.library = a.order;
      log(s, `${seat.name} shuffles their library.`);
      break;
    }
    case 'SEAT_MULLIGAN': {
      // Hand goes back, the library is shuffled (`order` = the whole library after that), draw `n`.
      const seat = seatOf(s, a.seat);
      if (!seat) break;
      const lib = [...seat.zones.library, ...seat.zones.hand];
      if (!samePerm(a.order, lib)) break;
      seat.zones.hand = [];
      seat.zones.library = a.order;
      seatDraw(s, a.seat, a.n ?? 7);
      log(s, `${seat.name} mulligans to ${a.n ?? 7}.`);
      break;
    }
    case 'UNTAP_ALL': {
      const seat = seatOf(s, a.seat);
      if (!seat) break;
      for (const id of seat.zones.battlefield) s.cards[id].tapped = false;
      log(s, `${seat.name} untaps everything.`);
      break;
    }
    case 'SURVIVOR_ATTACK': {
      // Survivors' creatures attack the Horde: tap them (except vigilance, decided by the client)
      // and deal their damage, which mills the Horde (or hits Horde life first).
      const ids = (a.ids || []).filter(id => s.cards[id]?.owner && zoneOf(s, id) === 'battlefield');
      for (const id of ids) s.cards[id].attacking = false;
      for (const id of a.tap || []) if (s.cards[id]?.owner) s.cards[id].tapped = true;
      if (ids.length) log(s, `Survivors attack the Horde with ${names(s, ids)} for ${a.damage}.`);
      return reduce(s, { t: 'DAMAGE_HORDE', n: Math.max(0, a.damage | 0) });
    }
    case 'GY_TO_LIBRARY': {
      // Cards picked at random by the client go from a graveyard into that library, which is then
      // shuffled: `order` is the whole library afterwards (so every copy shuffles the same way).
      const ids = [...new Set(a.ids || [])].filter(id => s.cards[id] && zoneOf(s, id) === 'graveyard');
      if (!ids.length) break;
      const zs = homeOf(s, s.cards[ids[0]]);
      if (ids.some(id => homeOf(s, s.cards[id]) !== zs)) break;
      const label = names(s, ids), owner = s.cards[ids[0]].owner;
      for (const id of ids) put(s, id, 'library', 'bottom');
      if (samePerm(a.order, zs.library)) zs.library = a.order;
      log(s, `${label} shuffled from ${owner ? seatName(s, owner) + "'s" : 'the Horde\'s'} graveyard into the library.`);
      break;
    }
    case 'ATTACH': {
      // An Aura or Equipment (`id`) attached to a permanent (`host`), or unattached (host: null).
      const c = s.cards[a.id];
      if (!c) break;
      if (a.host == null) {
        if (c.attachedTo) { c.attachedTo = null; log(s, `${c.name} is no longer attached.`); }
        break;
      }
      const h = s.cards[a.host];
      if (!h || h.id === c.id || zoneOf(s, c.id) !== 'battlefield' || zoneOf(s, h.id) !== 'battlefield') break;
      if (h.attachedTo) break;                                                                       // no chains
      for (const k in s.cards) if (s.cards[k].attachedTo === c.id) s.cards[k].attachedTo = null;
      c.attachedTo = h.id;
      c.aura = !!a.aura;
      log(s, `${c.name} attached to ${h.name}.`);
      break;
    }
    case 'COMMANDER': {
      // A Survivor marks one of their own cards as their commander: it goes to the command zone.
      const c = s.cards[a.id];
      if (!c || c.owner !== a.seat || !seatOf(s, a.seat)) break;
      c.commander = true;
      put(s, c.id, 'command');
      log(s, `${c.name} is ${seatName(s, a.seat)}'s commander.`);
      break;
    }
    case 'SET_OPT': {
      if (a.k !== 'tokensPersist') break;
      s.opts[a.k] = !!a.v;
      log(s, a.v ? 'Destroyed tokens now go to the graveyard.' : 'Destroyed tokens now cease to exist.');
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

/** A Survivor creature that came under its owner's control this turn (no haste check here). */
export function survivorSick(s, c) { return !!c.creature && (c.enteredS ?? 0) >= (s.sTurn || 1); }
