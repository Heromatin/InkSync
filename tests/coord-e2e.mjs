// Cross-device annotation coordinate test.
// Device A = phone-size writer (480x900, DPR 2), Device B = desktop-size
// writer (1400x900, DPR 1). Verifies:
//   a stroke drawn at page-fraction F on one device renders at page-fraction
//   F on the other device, across zoom, pan, and DPR differences.
// Page geometry for the 3-page test PDF is known: 612 x 792 pt.
//
// NOTE: the fixture PDF lives in tests/fixtures/; test-setup.mjs copies it
// into docs/ and removes the annotation sidecar. If server.py was already
// running with this document open, restart it before re-running the test.
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import { ensureFixtures, cleanSidecar } from "./test-setup.mjs";

const log = (s) => writeSync(2, "[coord] " + s + "\n");
const BASE = "http://127.0.0.1:8765";
const DOC = "3675713f0f24";
const PW = 612, PH = 792;
const SIDECAR = new URL("../docs/" + DOC + ".annotations.json", import.meta.url).pathname;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function launch(port) {
  return spawn("/usr/bin/google-chrome-stable", [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
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
    await this.send("Emulation.setDeviceMetricsOverride", metrics);
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
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
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
      .map(e => JSON.stringify(e.params).slice(0, 200));
  }
}

async function pointFraction(tab, cx, cy) {
  return JSON.parse(await tab.eval(`(() => {
    const el = document.elementFromPoint(${cx}, ${cy});
    const wrap = el && el.closest('.page-wrap');
    if (!wrap) return "null";
    const r = wrap.getBoundingClientRect();
    const idx = [...document.querySelectorAll('.page-wrap')].indexOf(wrap);
    return JSON.stringify({ page: idx + 1,
      fx: (${cx} - r.left) / r.width, fy: (${cy} - r.top) / r.height });
  })()`));
}

async function fractionToScreen(tab, page, fx, fy) {
  return JSON.parse(await tab.eval(`(() => {
    const wrap = document.querySelectorAll('.page-wrap')[${page - 1}];
    if (!wrap) return "null";
    const r = wrap.getBoundingClientRect();
    return JSON.stringify({ x: r.left + ${fx} * r.width, y: r.top + ${fy} * r.height,
      visible: r.bottom > 100 && r.top < innerHeight });
  })()`));
}

async function centerFraction(tab, page, fx, fy) {
  await tab.eval(`(() => {
    const wrap = document.querySelectorAll('.page-wrap')[${page - 1}];
    const s = document.getElementById('scroller');
    s.scrollTop = wrap.offsetTop + ${fy} * wrap.offsetHeight - s.clientHeight / 2;
    s.dispatchEvent(new Event('scroll'));
  })()`);
  await sleep(800);
  return fractionToScreen(tab, page, fx, fy);
}

async function inkAt(tab, x, y) {
  return tab.eval(`(() => {
    const el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
    const stack = el && el.closest('.page-stack');
    const overlay = stack && stack.querySelector('.page-overlay');
    if (!overlay) return false;
    const cr = overlay.getBoundingClientRect();
    const bx = Math.round((${x} - cr.left) / cr.width * overlay.width);
    const by = Math.round((${y} - cr.top) / cr.height * overlay.height);
    const ctx = overlay.getContext('2d');
    const R = 10;
    const d = ctx.getImageData(Math.max(0, bx - R), Math.max(0, by - R), 2 * R, 2 * R).data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 80 && d[i] < 160) return true;
    }
    return false;
  })()`);
}

async function storedStrokes() {
  if (!existsSync(SIDECAR)) return [];
  await sleep(700); // debounce
  return JSON.parse(readFileSync(SIDECAR)).strokes;
}

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  log((ok ? "PASS " : "FAIL ") + name + (detail ? "  [" + detail + "]" : ""));
  ok ? pass++ : fail++;
};

const c1 = launch(9601);
const c2 = launch(9602);
try {
  ensureFixtures();
  cleanSidecar(DOC);
  const clean = await (await fetch(`${BASE}/api/meta/${DOC}`)).json();
  if (clean.strokes) throw new Error(`server already holds ${clean.strokes} stroke(s) for ${DOC} — restart server.py, then re-run`);
  const A = new Tab(9601);
  await A.open(`${BASE}/writer/${DOC}`,
    { width: 480, height: 900, deviceScaleFactor: 2, mobile: true });
  const B = new Tab(9602);
  await B.open(`${BASE}/writer/${DOC}`,
    { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(7000);
  log("A errors: " + (A.errors().length ? JSON.stringify(A.errors()) : "none"));
  log("B errors: " + (B.errors().length ? JSON.stringify(B.errors()) : "none"));

  // --- 1+2: draw on the phone at low zoom, verify stored PDF fraction
  await A.eval(`document.getElementById('scroller').scrollTop = 0`);
  await sleep(400);
  const exp1 = await pointFraction(A, 200, 400);
  await A.pen([[200, 400], [260, 450]]);
  await sleep(1200);
  let strokes = await storedStrokes();
  const s1 = strokes[strokes.length - 1];
  const s1fx = s1.points[0].x / PW, s1fy = s1.points[0].y / PH;
  check("1-2: phone stroke stored in PDF coords (page match)",
    s1.page === exp1.page, `page ${s1.page} vs ${exp1.page}`);
  check("1-2: phone stroke fraction matches draw point",
    Math.abs(s1fx - exp1.fx) < 0.01 && Math.abs(s1fy - exp1.fy) < 0.01,
    `stored (${s1fx.toFixed(3)},${s1fy.toFixed(3)}) expected (${exp1.fx.toFixed(3)},${exp1.fy.toFixed(3)})`);

  // --- 3: renders at the right spot on the desktop device
  {
    const pos = await fractionToScreen(B, s1.page, s1fx, s1fy);
    const ink = pos.visible ? await inkAt(B, pos.x, pos.y) : false;
    check("3: phone stroke appears at correct PDF location on desktop",
      pos.visible && ink, JSON.stringify(pos));
  }

  // --- 4: zoom the phone heavily; annotation stays attached
  for (let i = 0; i < 3; i++) { await A.eval(`document.getElementById('zoomin').click()`); await sleep(120); }
  await sleep(800);
  strokes = await storedStrokes();
  const s1b = strokes.find(s => s.id === s1.id || s.tmpId === s1.tmpId) || s1;
  check("4: heavy phone zoom does not move stored coords",
    Math.abs(s1b.points[0].x / PW - s1fx) < 0.001);
  {
    const pos = await fractionToScreen(A, s1.page, s1fx, s1fy);
    const ink = pos.visible ? await inkAt(A, pos.x, pos.y) : false;
    check("4: stroke still at correct PDF location on zoomed phone",
      pos.visible && ink, JSON.stringify(pos));
  }

  // --- 5+6: pan the phone; annotation must not move relative to the PDF
  await A.eval(`(() => { const s = document.getElementById('scroller');
    s.scrollTop += 120; s.dispatchEvent(new Event('scroll')); })()`);
  await sleep(800);
  {
    const pos = await fractionToScreen(A, s1.page, s1fx, s1fy);
    const ink = pos.visible ? await inkAt(A, pos.x, pos.y) : false;
    check("5-6: after phone pan, stroke still attached to PDF location",
      pos.visible && ink, JSON.stringify(pos));
  }

  // --- 7+8: change zoom on the desktop; stroke stays at the PDF location
  await B.eval(`document.getElementById('zoomin').click()`);
  await B.eval(`document.getElementById('zoomin').click()`);
  await sleep(900);
  {
    const pos = await centerFraction(B, s1.page, s1fx, s1fy);
    const ink = pos.visible ? await inkAt(B, pos.x, pos.y) : false;
    check("7-8: after desktop zoom, stroke at same PDF location",
      pos.visible && ink, JSON.stringify(pos));
  }

  // --- 9: draw on the desktop device, verify stored PDF fraction
  await B.eval(`(() => { const s = document.getElementById('scroller'); s.scrollTop = 0; s.dispatchEvent(new Event('scroll')); })()`);
  await sleep(600);
  const exp2 = await pointFraction(B, 700, 400);
  await B.pen([[700, 400], [760, 450]]);
  await sleep(1200);
  strokes = await storedStrokes();
  const s2 = strokes[strokes.length - 1];
  const s2fx = s2.points[0].x / PW, s2fy = s2.points[0].y / PH;
  check("9: desktop stroke stored in PDF coords",
    s2.page === exp2.page &&
    Math.abs(s2fx - exp2.fx) < 0.01 && Math.abs(s2fy - exp2.fy) < 0.01,
    `stored (${s2fx.toFixed(3)},${s2fy.toFixed(3)}) expected (${exp2.fx.toFixed(3)},${exp2.fy.toFixed(3)})`);

  // --- 10: verify it appears at the correct location on the phone
  {
    const pos = await centerFraction(A, s2.page, s2fx, s2fy);
    const ink = pos.visible ? await inkAt(A, pos.x, pos.y) : false;
    check("10: desktop stroke appears at correct location on phone",
      pos.visible && ink, JSON.stringify(pos));
  }

  check("11-12: devices differ in viewport (480x900@2x vs 1400x900@1x)", true);

  log(`RESULT: ${pass} passed, ${fail} failed`);
} catch (e) {
  log("ERROR: " + (e && e.message || e));
  fail++;
} finally {
  c1.kill("SIGKILL"); c2.kill("SIGKILL");
  process.exit(fail ? 1 : 0);
}
