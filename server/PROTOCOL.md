# Horde Table — room protocol (v1)

One Node process serves the web app (static files from `../horde/`) **and** the
WebSocket rooms, on one port (default 8787, `PORT` env overrides). WebSocket path: `/ws`.
One port means a single link works through a tunnel or a host.

The server is authoritative: it holds each room's game state and runs the same
pure reducer the browser uses, `reduce(state, action)` from `../horde/js/game.js`
(plus `status`, if useful). Clients never change state locally; they send actions and
apply what the server broadcasts.

All messages are JSON objects with a `t` field.

## Identity

Each browser keeps a random `clientId` (string, ≤ 64 chars) in localStorage and sends it on
`create` / `join`. The same `clientId` reconnecting takes over its old seat (refresh-safe).
`name` is a display name, trimmed, 1–24 chars (server falls back to "Survivor").

## Client → server

| t | fields | meaning |
|---|---|---|
| `create` | `clientId, name, state` | Make a new room whose game state is `state` (the client built it with `initState`). Reply `joined`. |
| `join` | `clientId, name, room` | Join an existing room by code (case-insensitive). Reply `joined`, or `error` with `code: 'no-room'`. |
| `act` | `a, checkpoint, nonce` | Apply action `a` via `reduce`. If `checkpoint` is true, first push the current state to the room's undo history (max 100). `nonce` is any client string, echoed back. |
| `undo` | — | Pop the last undo snapshot and make it the state. Broadcast `state` with `reason: 'undo'`. If history is empty, reply `error` with `code: 'no-undo'`. |
| `reset` | `state` | New game in the same room: replace state, clear undo history. Broadcast `state` with `reason: 'reset'`. |
| `ping` | — | Reply `pong`. |

`act`/`undo`/`reset` before a successful `create`/`join` → `error` with `code: 'not-in-room'`.
Invalid JSON or unknown `t` → `error` with `code: 'bad-message'` (do not crash, do not disconnect).
If `reduce` throws, reply `error` with `code: 'bad-action'` to the sender only; state unchanged.

## Server → client

| t | fields | meaning |
|---|---|---|
| `joined` | `room, you: {id, name}, state, seq, players, canUndo` | You are in. `you.id` is your clientId. Replace local state with `state`. |
| `act` | `a, by: {id, name}, seq, nonce, checkpoint, canUndo` | Broadcast to **everyone in the room including the sender** after the server applied it. Clients apply `reduce(local, a)` themselves (deterministic) — the full state is not sent. |
| `state` | `state, seq, reason, by, canUndo` | Full state replacement (undo, reset). |
| `players` | `players: [{id, name, online}]` | Sent to the room whenever someone joins, leaves, or reconnects. Ordered by join time. |
| `error` | `code, msg` | See above. |
| `pong` | — | |

`seq` is a per-room counter, +1 for every `act`, `state` broadcast. Clients can use it to notice gaps;
on a gap a client may simply send `join` again to get a fresh `joined`.

`canUndo` is whether the room's undo history is non-empty.

## Authorship in the log

After applying an `act`, the server walks `state.log` backwards from the end and sets
`by: name` on each entry whose `by` is `undefined`, stopping at the first entry that already
has a `by` key. (The log is capped at 400 entries, so counting lengths does not work.)
On `create` and `reset`, the server sets `by` on every entry of the incoming state that lacks
it, to the sender's name. Clients run the exact same `stampLog(state, name)` after applying a
broadcast `act`, so their copies stay identical. Export it from a tiny shared module
`../horde/js/stamp.js` (`export function stampLog(state, name)`, mutates and returns state)
that both server and client import. The log drawer shows "Name: message".

## Rooms

- Code: 4 uppercase letters + `-` + 2 digits (e.g. `ZOMB-42`), avoiding ambiguous letters (I, O). Unique.
- Kept in memory; also written to `server/rooms.json` (debounced ~1s) and loaded on start, so a restart keeps games.
- A room with nobody online for 12 hours is deleted.
- Players are never removed from the list when they disconnect; they show `online: false`.

## Limits

Max message size 2 MB. Max 8 players online per room (`error` `room-full`).
