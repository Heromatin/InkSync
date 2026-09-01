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
  }

  on(evt, fn) { (this.handlers[evt] ??= []).push(fn); }
  _emit(evt, data) { for (const fn of this.handlers[evt] ?? []) fn(data); }

  connect(docId) {
    this.docId = docId;
    this._open();
  }

  _open() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/sync/${this.docId}`);
    this.ws.onopen = () => {
      this._retry = 0;
      this.send({ t: "join", clientId: this.clientId, role: this.role });
    };
    this.ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      switch (msg.t) {
        case "joined":
          this._emit("state", msg);
          break;
        case "stroke":
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

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  sendStroke(stroke) {
    this.send({ t: "stroke", stroke });
  }

  sendErase(ids) {
    this.send({ t: "erase", ids });
  }

  undo() {
    this.send({ t: "undo" });
  }

  sendCameraThrottled(cam, minIntervalMs = 60) {
    const now = performance.now();
    if (now - this._camLastSent < minIntervalMs) return;
    this._camLastSent = now;
    this.send({ t: "camera", ...cam });
  }
}
