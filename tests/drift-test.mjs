// Bitmap-drift probe: during a pinch at high zoom (region mode), track the
// black calibration rect's position IN BITMAP PIXELS converted to page units
// via the canvas's live geometry. Correct anchoring => the rect stays at its
// true page coordinates during the whole gesture. Region-anchored restretch
// => the measured page position drifts by Δregion/scale every step.
// Uses tests/fixtures/region-test.pdf (ensureFixtures() copies it into
// docs/ for the server): rect A at page units (100,100)-(212,212) in
// y-down viewport coords, rect B at (450,650)-(512,712).
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { ensureFixtures } from "./test-setup.mjs";
const log = (s) => writeSync(2, s + "\n");
const PORT = 9660;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const DOC = "6a92c8471c4d";
const chrome = spawn("/usr/bin/google-chrome-stable", [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  `--remote-debugging-port=${PORT}`, "--window-size=480,900", "about:blank"], { stdio: "ignore" });
try {
  ensureFixtures();
  let targets;
  for (let i = 0; i < 50; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; }
    catch { await sleep(200); }
  }
  const page = targets.find(t => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map(); const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params).slice(0, 200));
  };
  const send = (method, params = {}) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  };
  const touch = (type, points) => send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p, i) => ({ x: p[0], y: p[1], id: p[2] ?? i })) });

  // topmost-leftmost black pixel of rect A, converted to page units through
  // the canvas's CURRENT style geometry
  const rectPagePos = () => evalJs(`(() => {
    const c = document.querySelector('.page-stack canvas');
    if (!c || !c.width) return JSON.stringify({ err: 'no canvas' });
    const cssW = parseFloat(c.style.width);
    const dpr = c.width / cssW;
    const scale = parseFloat(document.getElementById('zoomlabel').textContent) / 100;
    const rx = parseFloat(c.style.left), ry = parseFloat(c.style.top);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let best = null;
    for (let y = 0; y < c.height && best === null; y += 2) {
      for (let x = 0; x < c.width; x += 2) {
        const i = (y * c.width + x) * 4;
        if (d[i] < 60 && d[i + 1] < 60 && d[i + 2] < 60 && d[i + 3] > 200) {
          best = [x, y]; break;
        }
      }
    }
    if (!best) return JSON.stringify({ err: 'no black' });
    return JSON.stringify({
      pageX: (best[0] / dpr + rx) / scale,
      pageY: (best[1] / dpr + ry) / scale,
    });
  })()`);

  await send("Runtime.enable"); await send("Page.enable");
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Page.navigate", { url: `http://127.0.0.1:8765/writer/${DOC}` });
  await sleep(6000);

  // get to high zoom (region mode)
  let cur = parseFloat(await evalJs(`document.getElementById('zoomlabel').textContent`));
  while (cur < 270) { await evalJs(`document.getElementById('zoomin').click()`); await sleep(140);
    cur = parseFloat(await evalJs(`document.getElementById('zoomlabel').textContent`)); }
  await sleep(900);

  // ensure rect A is on screen: scroll to page top-left area
  await evalJs(`(() => { const s = document.getElementById('scroller');
    s.scrollTop = 0; s.scrollLeft = 0; s.dispatchEvent(new Event('scroll')); })()`);
  await sleep(900);

  const start = JSON.parse(await rectPagePos());
  if (start.err) { log("setup failed: " + start.err); process.exit(2); }
  log(`start: rect corner at page (${start.pageX.toFixed(1)}, ${start.pageY.toFixed(1)}) — expect (100,100)`);

  let maxDrift = 0;
  await touch("touchStart", [[190, 400, 0], [290, 500, 1]]);
  await sleep(80);
  for (let i = 1; i <= 10; i++) {
    await touch("touchMove", [[190 - i * 5, 400 - i * 5, 0], [290 + i * 5, 500 + i * 5, 1]]);
    await sleep(70);
    const pos = JSON.parse(await rectPagePos());
    if (pos.err) { log(`step ${i}: ${pos.err}`); continue; }
    const drift = Math.hypot(pos.pageX - 100, pos.pageY - 100);
    maxDrift = Math.max(maxDrift, drift);
    log(`step ${i}: page (${pos.pageX.toFixed(1)}, ${pos.pageY.toFixed(1)}) drift=${drift.toFixed(1)} page-units`);
  }
  await touch("touchEnd", []);
  await sleep(900);
  const end = JSON.parse(await rectPagePos());
  const endDrift = end.err ? 999 : Math.hypot(end.pageX - 100, end.pageY - 100);
  log(`after settle: drift=${endDrift.toFixed(1)} page-units`);

  const ok = maxDrift < 4 && endDrift < 4 && errors.length === 0;
  log("JS errors: " + (errors.length ? JSON.stringify(errors) : "none"));
  log(ok ? `DRIFT TEST PASSED (max ${maxDrift.toFixed(1)} page-units)` : `DRIFT TEST FAILED (max ${maxDrift.toFixed(1)} page-units)`);
  ws.close();
  process.exit(ok ? 0 : 1);
} catch (e) { log("ERROR: " + (e && e.message || e)); process.exit(2); }
finally { chrome.kill("SIGKILL"); }
