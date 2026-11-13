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

  // Keep-alive: Render's free tier sleeps after 15 min without inbound traffic, and a sleeping
  // server loses its rooms. While this tab is in a room, poke the server every 4 minutes so a
  // long chat between turns doesn't count as idle. Hidden tabs still fire (timers are only
  // throttled to about once a minute).
  const keepAlive = setInterval(() => {
    if (closed || !joinMsg) return;
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping' }));
    fetch('/healthz', { cache: 'no-store' }).catch(() => {});
  }, 4 * 60e3);

  return {
    send(msg) {
      const s = JSON.stringify(msg);
      if (ws.readyState === 1) ws.send(s); else queue.push(s);
    },
    // The message to resend after every reconnect.
    rejoinWith(msg) { joinMsg = msg; },
    close() { closed = true; clearInterval(keepAlive); ws.close(); },
  };
}
