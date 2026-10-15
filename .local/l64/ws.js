(() => {
  const log = []; window.__wsLog = log; const t0 = performance.now();
  const OrigWS = window.WebSocket;
  const pending = new Map();
  window.WebSocket = function (url, protocols) {
    const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
    const send = ws.send.bind(ws);
    ws.send = (data) => {
      try { const m = JSON.parse(data); if (m && m.method) { pending.set(m.id, { method: m.method, t: performance.now() - t0, bytes: data.length, params: m.params }); } } catch {}
      return send(data);
    };
    ws.addEventListener("message", (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === "res" || (m.id && pending.has(m.id))) {
          const p = pending.get(m.id); if (p) { pending.delete(m.id); log.push({ k: "rpc", method: p.method, t: Math.round(p.t), dt: Math.round(performance.now() - t0 - p.t), reqB: p.bytes, resB: ev.data.length, ok: m.ok !== false && !m.error, pk: p.params ? Object.keys(p.params).sort().join(",") : "", key: p.params && (p.params.key || p.params.sessionKey || p.params.agentId || "") }); }
        } else if (m.type === "event" || m.event) {
          log.push({ k: "evt", event: m.event, t: Math.round(performance.now() - t0), b: ev.data.length });
        }
      } catch {}
    });
    return ws;
  };
  window.WebSocket.prototype = OrigWS.prototype;
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
})();
