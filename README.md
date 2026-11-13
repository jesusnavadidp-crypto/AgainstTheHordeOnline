# Horde Table (prototype)

An animated, browser-based table for Horde Magic, with the Horde fully automated and online rooms so friends can play together.

## Run it

Online and offline (needs Node, run once: `cd server && npm install`):

```bash
cd server && npm start
```

Then open http://localhost:8787. To play with others, enter your name, choose a Horde and options, press **Create a room**, and share the link from the gold room badge in the top bar (or the code). Friends open the link, type their name, and join.

Offline only, no Node needed:

```bash
python3 horde/serve.py
```

Then open http://localhost:5173.

Card data and images come live from Scryfall and are cached in the browser.

## Put it online (Render, free)

The project root has `render.yaml`, `package.json` (`npm run build` installs the server, `npm start` runs it) and `.gitignore`.

1. Push the project to a GitHub repository (private is fine).
2. On render.com, sign in with GitHub, choose **New → Blueprint**, pick the repository, and deploy. Render reads `render.yaml`.
3. Share the `https://….onrender.com` address. Rooms use secure WebSockets automatically.

Free-tier notes: the server sleeps after 15 minutes with no one playing and takes about a minute to wake. Its disk is temporary, so rooms are lost when it sleeps or redeploys (while anyone has a room open, their browser pings the server every 4 minutes, so a room stays alive through long pauses; close every tab and it can sleep).

## What's in it

- **Decks:** the 7 Horde decks from against-the-horde.com, stored in `horde/decks/` in that site's format (each line includes the Scryfall ID). You can also paste a custom list ("40 Zombie token", "2 Grave Titan").
- **Options:** survivors, shared life, deck size, reveals per turn, token multiplier, safe zone, Horde life, tokens-in-other-zones.
- **Horde turn:** recasts its hand and flashback cards, reveals until a non-token card, then casts. Spells stop for you to resolve, then a main phase pauses so you can add tokens and effects before everything that can attack does (the deck's haste rule is applied).
- **Combat:** you block per creature or per stack, kill attackers, and add a temporary +X/+X Horde bonus. Damage and poison (infect, toxic, poisonous) are calculated for you, and unblocked attackers strike at your life total.
- **Card actions:** click any card for a menu (tap, counters, destroy, exile, hand, library top or bottom). You can also drag a card onto a pile, the hand or the battlefield. Shift-drag moves a whole stack.
- **Tokens:** identical tokens collapse into stacks with counts. Menu actions apply to N of a stack. The Tokens drawer adds the deck's tokens, suggests tokens that cards in play create, and can search any token on Scryfall.
- **Your own deck:** each Survivor can bring a deck from a Moxfield or Archidekt link, or as a pasted list (Arena, MTGO or any site's text export). You get your own library, hand (hidden from others), battlefield, graveyard, exile and command zone, start with 7 cards, and untap and draw automatically each turn. Pick which of your creatures blocks each attacker; deaths, deathtouch, infect/wither counters, first strike and trample are worked out for you. Mark creatures to attack and their damage mills the Horde. Decks can be saved for next time.
- **Community Hordes:** nine more Horde decks from against-the-horde.com: Ooze Horde (Zayn Harris), The Fire Nation (Fondant), Arachnophobia (Gabriel), Merfolk, Squirrel and Rats - Plague Avatar (PiouPiou), Sleep with the Fishes (Jay), Walls (Hoken) and Now that's a lot of gobbo (Lady Stardust). Each links back to its original page. Image-only custom cards from the originals aren't included.
- **Saved Hordes:** name a custom Horde list and it stays on the setup screen.
- **Online rooms:** everyone sees and controls the same table live, with all animations. The log shows who did what, undo works for the whole room, and refreshing puts you back in your seat. Rooms survive a server restart and expire after 12 hours with nobody connected.
- **Other:** hover to zoom, graveyard/exile/library viewers, undo (Ctrl+Z), game log, autosave (offline), and Space as the main action.

## Code layout

- `horde/js/game.js` is a pure reducer. Every change is a serializable action; the room server runs the same reducer.
- `horde/js/view.js` holds the keyed card elements and FLIP animations, so every zone change animates.
- `horde/js/app.js` covers setup, the Horde turn sequence, menus, drag & drop, zoom, drawers and the online room client.
- `horde/js/net.js` is the WebSocket link (reconnects and rejoins on its own); `horde/js/stamp.js` tags log entries with who caused them.
- `horde/js/deck.js` parses deck lists and builds the library (deck size, safe zone).
- `horde/js/scryfall.js` fetches and caches card data, and looks up players' decks (exact printings when known).
- `horde/js/decklist.js` parses pasted deck lists; `server/importers.js` imports Moxfield and Archidekt links (MTGGoldfish and TappedOut block automated requests, so paste their text export).
- `server/` is the room server (Node + `ws`): `server.js`, protocol in `PROTOCOL.md`, tests with `node test.js`.

Unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards.

The Horde deck lists in `horde/decks/` come from against-the-horde.com (decks by Peter Knudson and TenkayCrit; community decks in `horde/decks/community/` by the authors named above and in each file). They belong to their authors and are not covered by this repository's license.
