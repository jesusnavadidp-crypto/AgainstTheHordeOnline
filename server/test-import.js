// Offline parser tests + optional live importer checks. Run: node server/test-import.js  (OFFLINE=1 skips live)
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { parseDecklist } = await import(pathToFileURL(path.join(here, '../horde/js/decklist.js')).href);
const { importDeck, identify } = await import(pathToFileURL(path.join(here, 'importers.js')).href);

let failed = 0;
const test = (name, fn) => { try { fn(); console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, '\n   ', e.message.split('\n').slice(0, 6).join('\n    ')); } };
const sec = (r, s) => r.cards.filter(c => c.section === s);
const find = (r, n) => r.cards.find(c => c.name === n);

test('arena with set/collector and headers', () => {
  const r = parseDecklist('Commander\n1 Atraxa, Praetors\' Voice (C16) 28\n\nDeck\n1 Sol Ring (C21) 263\n4 Lightning Bolt (2XM) 117\n\nSideboard\n2 Negate (M21) 59\n\nCompanion\n1 Lurrus of the Dream-Den (IKO) 226');
  assert.equal(sec(r, 'commander').length, 1);
  assert.deepEqual(find(r, 'Sol Ring'), { count: 1, name: 'Sol Ring', set: 'c21', collector: '263', section: 'main' });
  assert.equal(find(r, 'Lightning Bolt').count, 4);
  assert.equal(find(r, 'Negate').section, 'side');
  assert.equal(find(r, 'Lurrus of the Dream-Den').section, 'side');
  assert.equal(r.warnings.length, 0);
});
test('mtgo plain: 4 Name and 4x Name', () => {
  const r = parseDecklist('4 Lightning Bolt\n4x Counterspell\n2X Shock');
  assert.deepEqual(r.cards.map(c => [c.count, c.name]), [[4, 'Lightning Bolt'], [4, 'Counterspell'], [2, 'Shock']]);
});
test('moxfield text export with foil markers', () => {
  const r = parseDecklist('1 Sol Ring (C21) 263 *F*\n1 Arcane Signet (ELD) 331 *E*\n1 Command Tower (CMR) 350\n\nSIDEBOARD:\n1 Rhystic Study (WOT) 31');
  assert.equal(find(r, 'Sol Ring').collector, '263'); assert.equal(find(r, 'Sol Ring').set, 'c21');
  assert.equal(find(r, 'Arcane Signet').name, 'Arcane Signet');
  assert.equal(find(r, 'Rhystic Study').section, 'side');
});
test('headers: SIDEBOARD:, // Commander, Commander:, Maybeboard', () => {
  const r = parseDecklist('// Commander\n1 Krenko, Mob Boss\n// Mainboard\n1 Goblin Guide\nSIDEBOARD:\n1 Pyroblast\nMaybeboard:\n1 Wheel of Fortune');
  assert.equal(find(r, 'Krenko, Mob Boss').section, 'commander');
  assert.equal(find(r, 'Goblin Guide').section, 'main');
  assert.equal(find(r, 'Pyroblast').section, 'side');
  assert.equal(find(r, 'Wheel of Fortune').section, 'maybe');
  const r2 = parseDecklist('Commander:\n1 Muldrotha, the Gravetide\nDeck:\n1 Island');
  assert.equal(r2.cards[0].section, 'commander'); assert.equal(r2.cards[1].section, 'main');
});
test('blank-line trailing block is sideboard (<=15, no headers)', () => {
  const main = Array.from({ length: 6 }, (_, i) => `4 Card ${String.fromCharCode(65 + i)}`).join('\n');
  const r = parseDecklist(main + '\n\n3 Side One\n2 Side Two');
  assert.equal(sec(r, 'side').length, 2); assert.equal(sec(r, 'main').length, 6);
});
test('blank-line trailing block >15 cards stays main', () => {
  const r = parseDecklist('4 Alpha\n\n4 Beta\n4 Gamma\n4 Delta\n4 Epsilon');
  assert.equal(sec(r, 'side').length, 0);
});
test('no sideboard heuristic when explicit headers exist', () => {
  const r = parseDecklist('Deck\n1 A Card\n\n1 B Card');
  assert.equal(sec(r, 'side').length, 0);
});
test('comments ignored', () => {
  const r = parseDecklist('# my deck\n// some comment\n1 Island\n#another');
  assert.equal(r.cards.length, 1); assert.equal(r.warnings.length, 0);
});
test('double-faced names kept whole', () => {
  const r = parseDecklist('1 Delver of Secrets // Insectile Aberration\n2 Fable of the Mirror-Breaker // Reflection of Kiki-Jiki (NEO) 141');
  assert.equal(r.cards[0].name, 'Delver of Secrets // Insectile Aberration');
  assert.equal(r.cards[1].name, 'Fable of the Mirror-Breaker // Reflection of Kiki-Jiki'); assert.equal(r.cards[1].set, 'neo');
});
test('lines without a count get count 1', () => {
  const r = parseDecklist('Sol Ring\nCommand Tower');
  assert.deepEqual(r.cards.map(c => c.count), [1, 1]);
});
test('junk lines ignored with warning', () => {
  const r = parseDecklist('1 Island\n{"json": true}\n=====\n12345');
  assert.equal(r.cards.length, 1); assert.equal(r.warnings.length, 3);
});
test('duplicates merged within a section only', () => {
  const r = parseDecklist('2 Island\n3 Island\nSideboard\n1 Island');
  assert.equal(sec(r, 'main')[0].count, 5); assert.equal(sec(r, 'side')[0].count, 1);
});
test('SB: prefix, CRLF, BOM, empty input', () => {
  const r = parseDecklist('﻿1 Island\r\nSB: 2 Negate\r\n');
  assert.equal(find(r, 'Negate').section, 'side'); assert.equal(find(r, 'Island').section, 'main');
  assert.deepEqual(parseDecklist('').cards, []);
});
test('archidekt text export decorations', () => {
  const r = parseDecklist('1x Sol Ring (c21) 263 [Ramp] ^Foil^\n1x Island (neo) 1 [Land]');
  assert.deepEqual(find(r, 'Sol Ring'), { count: 1, name: 'Sol Ring', set: 'c21', collector: '263', section: 'main' });
});
test('url allow-list (no SSRF)', () => {
  assert.deepEqual(identify('https://archidekt.com/decks/123/foo'), { site: 'archidekt', id: '123' });
  assert.deepEqual(identify('https://www.moxfield.com/decks/abc_DEF-1'), { site: 'moxfield', id: 'abc_DEF-1' });
  assert.deepEqual(identify('https://www.mtggoldfish.com/deck/555#paper'), { site: 'mtggoldfish', id: '555' });
  assert.deepEqual(identify('https://tappedout.net/mtg-decks/my-deck/'), { site: 'tappedout', id: 'my-deck' });
  for (const bad of ['http://archidekt.com/decks/1', 'https://evil.com/decks/1', 'https://archidekt.com.evil.com/decks/1',
    'https://archidekt.com@evil.com/decks/1', 'https://localhost/decks/1', 'file:///etc/passwd', 'nonsense', 'https://archidekt.com:8080/decks/1'])
    assert.throws(() => identify(bad), /./, bad);
});

if (process.env.OFFLINE === '1') console.log('LIVE tests skipped (OFFLINE=1)');
else {
  console.log('\nLIVE imports (network):');
  const live = [
    ['archidekt', 'https://archidekt.com/decks/7031486'],
    ['moxfield', 'https://moxfield.com/decks/j-0aJlxuOUm9FnKRvJcfZw'],
    ['mtggoldfish', 'https://www.mtggoldfish.com/deck/6837920'],
    ['tappedout', 'https://tappedout.net/mtg-decks/22-01-13-kess-storm/'],
  ];
  for (const [site, url] of live) {
    try {
      const r = await importDeck(url);
      const counts = {}; for (const c of r.cards) counts[c.section] = (counts[c.section] ?? 0) + c.count;
      assert.equal(r.source, site); assert.ok(r.cards.length > 0);
      console.log(`PASS live ${site}: "${r.name}" ${JSON.stringify(counts)} warnings=${r.warnings.length} scryfallIds=${r.cards.filter(c => c.scryfallId).length}`);
    } catch (e) {
      // Cloudflare-protected sites may refuse server clients: report, but only fail on unexpected errors.
      if (e.status === 502 && /did not allow/.test(e.message)) console.log(`BLOCKED live ${site}: ${e.message}`);
      else { failed++; console.log(`FAIL live ${site}: ${e.message}`); }
    }
  }
}
process.exit(failed ? 1 : 0);
