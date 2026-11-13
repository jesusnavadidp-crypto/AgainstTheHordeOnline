// WebSocket link to the room server (see server/PROTOCOL.md).
// Reconnects on its own and re-joins the room it was last in.

export function clientId() {
  let id = null;
  try { id = sessionStorage.getItem('horde.clientId'); } catch {}
  if (!id) {
    id = crypto.randomUUID();
    try { sessionStorage.setItem('horde.clientId', id); } catch {}
  }
  return id;
}

export function connectNet({ onMessage, onStatus }) {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  let ws = null, closed = false, tries = 0, joinMsg = null, everOpen = false;
  const queue = [];

  function open() {
    if (closed) return;
    ws = new WebSocket(url);
    ws.onopen = () => {
      tries = 0; everOpen = true;
      onStatus('online');
      if (joinMsg) ws.send(JSON.stringify(joinMsg));
      while (queue.length) ws.send(queue.shift());
    };
    ws.onmessage = e => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    ws.onclose = () => {
      if (closed) return;
      onStatus(everOpen ? 'reconnecting' : 'unreachable');
      setTimeout(open, Math.min(5000, 400 * 2 ** tries++));
    };
  }
  open();

  return {
    send(msg) {
      const s = JSON.stringify(msg);
      if (ws.readyState === 1) ws.send(s); else queue.push(s);
    },
    // The message to resend after every reconnect.
    rejoinWith(msg) { joinMsg = msg; },
    close() { closed = true; ws.close(); },
  };
}
