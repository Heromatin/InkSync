// Stylus/mouse E2E: pen input draws + syncs to the other device correctly.
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";

const log = (s) => writeSync(2, "[e2e] " + s + "\n");
const BASE = "http://127.0.0.1:8765";
const DOC = "3675713f0f24";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function launch(port) {
  return spawn("/usr/bin/google-chrome-stable", [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    `--remote-debugging-port=${port}`, "about:blank",
  ], { stdio: "ignore" });
}

class Tab {
  constructor(port) { this.port = port; this.id = 0; this.pending = new Map(); this.events = []; }
  async open(url, metrics) {
    let targets;
    for (let i = 0; i < 50; i++) {
      try { targets = await (await fetch(`http://127.0.0.1:${this.port}/json`)).json(); break; }
      catch { await sleep(200); }
    }
    const page = targets.find(t => t.type === "page");
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
      else if (m.method) this.events.push(m);
    };
    await this.send("Runtime.enable");
    await this.send("Page.enable");
    if (metrics) await this.send("Emulation.setDeviceMetricsOverride", metrics);
    if (url) await this.send("Page.navigate", { url });
  }
  send(method, params = {}) {
    return new Promise((res) => {
      const mid = ++this.id;
      this.pending.set(mid, res);
      this.ws.send(JSON.stringify({ id: mid, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result.result.value;
  }
  async pen(points, steps = 15) {
    const [fx, fy] = points[0], [tx, ty] = points[1];
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: fx, y: fy, button: "left", clickCount: 1, pointerType: "pen", pressure: 0.5 });
    for (let i = 1; i <= steps; i++) {
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: fx + (tx - fx) * i / steps, y: fy + (ty - fy) * i / steps, button: "left", pointerType: "pen", pressure: 0.5 });
      await sleep(10);
    }
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: tx, y: ty, button: "left", clickCount: 1, pointerType: "pen", pressure: 0.2 });
  }
  errors() {
    return this.events.filter(e =>
      e.method === "Runtime.exceptionThrown" ||
      (e.method === "Runtime.consoleAPICalled" && e.params.type === "error"))
      .map(e => JSON.stringify(e.params).slice(0, 300));
  }
}

const c1 = launch(9501);
const c2 = launch(9502);
let exitOk = false;
try {
  const writer = new Tab(9501);
  await writer.open(`${BASE}/writer/${DOC}`, { width: 480, height: 900, deviceScaleFactor: 1, mobile: true });
  log("writer open");
  const reader = new Tab(9502);
  await reader.open(`${BASE}/reader/${DOC}`, { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  log("reader open");

  await sleep(7000);
  log("writer errors: " + (writer.errors().length ? JSON.stringify(writer.errors()) : "none"));
  log("reader errors: " + (reader.errors().length ? JSON.stringify(reader.errors()) : "none"));

  await writer.pen([[150, 400], [270, 550]]);
  log("drew stroke with pen");
  await sleep(1200);

  const meta = await (await fetch(`${BASE}/api/meta/${DOC}`)).json();
  log("server stroke count: " + meta.strokes);

  const readerInk = await reader.eval(`(() => {
    const c = document.querySelector('.page-overlay');
    if (!c) return -1;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 40) if (d[i] > 0) n++;
    return n;
  })()`);
  log("reader overlay ink samples: " + readerInk);

  const before = await reader.eval(`document.getElementById('scroller').scrollTop`);
  await writer.eval(`const s = document.getElementById('scroller'); s.scrollTop += 1600; s.dispatchEvent(new Event('scroll'))`);
  await sleep(1500);
  const after = await reader.eval(`document.getElementById('scroller').scrollTop`);
  log("reader scrollTop: " + before + " -> " + after);

  const ok = meta.strokes > 0 && readerInk > 0 && Math.abs(after - before) > 500;
  log(ok ? "E2E PASSED" : "E2E FAILED");
  exitOk = ok;
} catch (e) {
  log("ERROR: " + (e && e.message || e));
} finally {
  c1.kill("SIGKILL"); c2.kill("SIGKILL");
  process.exit(exitOk ? 0 : 1);
}
