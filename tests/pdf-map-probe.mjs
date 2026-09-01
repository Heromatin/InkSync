// PDF bitmap mapping probe: verifies the rendered PDF canvas bitmap maps
// page units -> pixels exactly as the CSS/region transform claims.
// Uses a calibration PDF with black rects at known page coordinates.
// Run at deviceScaleFactor=2 (mobile DPR) — region mode activates at >~176%.
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
const log = (s) => writeSync(2, "[map] " + s + "\n");
const PORT = 9640;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const DOC = "6a92c8471c4d";

const chrome = spawn("/usr/bin/google-chrome-stable", [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  `--remote-debugging-port=${PORT}`, "--window-size=480,900", "about:blank"], { stdio: "ignore" });
try {
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

  await send("Runtime.enable"); await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 480, height: 900, deviceScaleFactor: 2, mobile: true });
  await send("Page.navigate", { url: `http://127.0.0.1:8765/writer/${DOC}` });
  await sleep(6000);

  // locate black-rect pixel bboxes in the first page's PDF canvas, then
  // convert back to page units via the canvas's own geometry and compare
  const probe = async () => JSON.parse(await evalJs(`(() => {
    const c = document.querySelector('.page-stack canvas');
    if (!c || !c.width) return JSON.stringify({ err: 'no canvas' });
    const cssW = parseFloat(c.style.width), cssH = parseFloat(c.style.height);
    const dpr = c.width / cssW;
    const scale = parseFloat(document.getElementById('zoomlabel').textContent) / 100;
    const regionX = parseFloat(c.style.left), regionY = parseFloat(c.style.top);
    // expected device mapping: pageX -> (pageX*scale - regionX) * dpr
    // find black rect bboxes
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, n = 0;
    for (let y = 0; y < c.height; y += 2) {
      for (let x = 0; x < c.width; x += 2) {
        const i = (y * c.width + x) * 4;
        if (d[i] < 60 && d[i + 1] < 60 && d[i + 2] < 60 && d[i + 3] > 200) {
          n++; if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (n === 0) return JSON.stringify({ err: 'no black content' });
    const toPage = (px, py) => [
      (px / dpr + regionX) / scale,
      (py / dpr + regionY) / scale,
    ];
    const [ax1, ay1] = toPage(minX, minY);
    const [ax2, ay2] = toPage(maxX + 2, maxY + 2);
    return JSON.stringify({
      mode: cssW * dpr * cssH * dpr > 6e6 ? 'region' : 'full',
      cssW: Math.round(cssW), cssH: Math.round(cssH), dpr: +dpr.toFixed(2),
      rectPage: [Math.round(ax1), Math.round(ay1), Math.round(ax2), Math.round(ay2)],
    });
  })()`));

  // full mode: zoom out to ~150% (region budget crossed below ~176% at dpr2)
  let cur = parseFloat(await evalJs(`document.getElementById('zoomlabel').textContent`));
  while (cur > 150) { await evalJs(`document.getElementById('zoomout').click()`); await sleep(150);
    cur = parseFloat(await evalJs(`document.getElementById('zoomlabel').textContent`)); }
  await sleep(900);
  log("FULL MODE  -> " + JSON.stringify(await probe()));

  // region mode: zoom in to ~278%
  cur = parseFloat(await evalJs(`document.getElementById('zoomlabel').textContent`));
  while (cur < 270) { await evalJs(`document.getElementById('zoomin').click()`); await sleep(150);
    cur = parseFloat(await evalJs(`document.getElementById('zoomlabel').textContent`)); }
  await sleep(900);
  log("REGION MODE-> " + JSON.stringify(await probe()));

  log("expected rectPage ~ [100,580,212,692] (rect A) within tolerance");
  log("JS errors: " + (errors.length ? JSON.stringify(errors) : "none"));
  ws.close();
} finally { chrome.kill("SIGKILL"); process.exit(0); }
