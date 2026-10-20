// WebSocket sync client: joins a document room, relays strokes and camera.

const STORAGE_KEY = "studyapp-client-id";

// crypto.randomUUID only exists in secure contexts (https / localhost),
// but this app is served over plain http on the LAN.
export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function clientId() {
  let id = localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = uuid().slice(0, 8);
    localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}

export class SyncClient {
  constructor() {
    this.clientId = clientId();
    this.handlers = {};
    this.ws = null;
    this.docId = null;
    this._retry = 0;
    this._camLastSent = 0;
    this._camPending = null;   // newest throttled camera position not yet sent
    this._camTimer = null;
    this._gen = 0;            // increments on every (re)connect
    // strokes sent but not yet echoed back by the server:
    // tmpId -> { stroke, sentGen }.  Lets us re-send strokes that were drawn
    // while offline (or lost with a dying connection) after a reconnect.
    this.pending = new Map();
  }

  on(evt, fn) { (this.handlers[evt] ??= []).push(fn); }
  _emit(evt, data) { for (const fn of this.handlers[evt] ?? []) fn(data); }

  connect(docId) {
    this.docId = docId;
    this._open();
  }

  _open() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this._gen++;
    this.ws = new WebSocket(`${proto}://${location.host}/sync/${this.docId}`);
    this.ws.onopen = () => {
      this._retry = 0;
      this.send({ t: "join", clientId: this.clientId, role: this.role });
    };
    this.ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      switch (msg.t) {
        case "joined": {
          // Merge strokes that the server has never seen (drawn offline or
          // lost in flight) so a reconnect does not wipe them, and re-send them.
          const known = new Set(msg.strokes.map(s => s.tmpId).filter(Boolean));
          const strokes = msg.strokes.slice();
          for (const [tmpId, entry] of [...this.pending]) {
            if (known.has(tmpId)) { this.pending.delete(tmpId); continue; }  // server already has it
            if (entry.sentGen === this._gen) continue;                        // in flight on this connection
            strokes.push(entry.stroke);
            if (this.send({ t: "stroke", stroke: entry.stroke })) entry.sentGen = this._gen;
          }
          this._emit("state", { ...msg, strokes });
          this._emit("status", "connected");
          break;
        }
        case "stroke":
          if (msg.stroke && msg.stroke.tmpId) this.pending.delete(msg.stroke.tmpId);
          this._emit("stroke", msg.stroke);
          break;
        case "erase":
          this._emit("erase", msg.ids);
          break;
        case "camera":
          this._emit("camera", msg);
          break;
      }
    };
    this.ws.onclose = () => {
      if (!this.docId) return;
      this._retry++;
      setTimeout(() => this._open(), Math.min(1000 * this._retry, 5000));
      this._emit("status", "reconnecting");
    };
    this.ws.onerror = () => this.ws.close();
  }

  // returns true if the message was actually handed to an open socket
  send(obj) {
    if (obj.t === "camera") this._cancelPendingCamera();   // a direct send is the newest position
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  sendStroke(stroke) {
    const sent = this.send({ t: "stroke", stroke });
    if (stroke.tmpId) this.pending.set(stroke.tmpId, { stroke, sentGen: sent ? this._gen : -1 });
  }

  // a stroke the user erased/undid before the server confirmed it must not be re-sent
  dropPending(tmpIds) {
    for (const id of tmpIds) this.pending.delete(id);
  }

  sendErase(ids) {
    this.send({ t: "erase", ids });
  }

  undo() {
    this.send({ t: "undo" });
  }

  // At most one camera message per interval, but the NEWEST position is never
  // dropped: if updates arrive inside the interval, the latest one is sent when
  // it ends, so the other device always ends up where the scrolling stopped.
  sendCameraThrottled(cam, minIntervalMs = 60) {
    const wait = minIntervalMs - (performance.now() - this._camLastSent);
    if (wait > 0) {
      this._camPending = cam;
      if (!this._camTimer) this._camTimer = setTimeout(() => this._flushCamera(), wait);
      return;
    }
    this._sendCameraNow(cam);
  }

  _sendCameraNow(cam) {
    this._camLastSent = performance.now();
    this.send({ t: "camera", ...cam });
  }

  _flushCamera() {
    this._camTimer = null;
    const cam = this._camPending;
    this._camPending = null;
    if (cam) this._sendCameraNow(cam);
  }

  _cancelPendingCamera() {
    if (this._camTimer) { clearTimeout(this._camTimer); this._camTimer = null; }
    this._camPending = null;
  }
}
