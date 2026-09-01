// Ghost detection: draw one stroke, zoom hard, then scan the ENTIRE overlay
// for ink pixels that are NOT near the stroke's expected screen position.
// Any stray ink = stale annotation rendering.
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
const log = (s) => writeSync(2, "[ghost] " + s + "\n");
const PORT = 9620;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
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
  const touch = (type, points) => send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p, i) => ({ x: p[0], y: p[1], id: p[2] ?? i })) });

  // scans the first visible page's overlay for dark ink pixels more than
  // `tol` px away from BOTH segments (the stroke drawn at each zoom stage)
  const strayInk = (segs) => evalJs(`(() => {
    const segs = ${JSON.stringify(segs)};
    const overlays = [...document.querySelectorAll('.page-overlay')].filter(o => o.width > 0);
    if (!overlays.length) return JSON.stringify({ err: 'no overlay' });
    let strays = 0, total = 0, sample = null;
    for (const o of overlays) {
      const cr = o.getBoundingClientRect();
      const ctx = o.getContext('2d');
      const d = ctx.getImageData(0, 0, o.width, o.height).data;
      const scaleX = cr.width / o.width || 1;
      for (let py = 0; py < o.height; py += 3) {
        for (let px = 0; px < o.width; px += 3) {
          const i = (py * o.width + px) * 4;
          if (!(d[i + 3] > 80 && d[i] < 160)) continue;
          total++;
          const sx = cr.left + px * scaleX;
          const sy = cr.top + py * scaleX;
          let near = false;
          for (const [[ax, ay], [bx, by]] of segs) {
            const vx = bx - ax, vy = by - ay;
            const len2 = vx * vx + vy * vy;
            let t = len2 ? ((sx - ax) * vx + (sy - ay) * vy) / len2 : 0;
            t = Math.max(0, Math.min(1, t));
            if (Math.hypot(sx - (ax + t * vx), sy - (ay + t * vy)) < 30) { near = true; break; }
          }
          if (!near) { strays++; if (!sample) sample = [Math.round(sx), Math.round(sy)]; }
        }
      }
    }
    return JSON.stringify({ total, strays, sample });
  })()`);

  await send("Runtime.enable"); await send("Page.enable");
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Page.navigate", { url: "http://127.0.0.1:8765/writer/3675713f0f24" });
  await sleep(6000);
  await evalJs(`document.getElementById('scroller').scrollTop = 0`);
  await sleep(400);

  // screen->fraction helper results captured in-page
  const fracOf = (cx, cy) => evalJs(`(() => {
    const el = document.elementFromPoint(${cx}, ${cy});
    const wrap = el && el.closest('.page-wrap');
    if (!wrap) return "null";
    const r = wrap.getBoundingClientRect();
    return JSON.stringify({ fx: (${cx} - r.left) / r.width, fy: (${cy} - r.top) / r.height,
      wl: r.left, wt: r.top, w: r.width, h: r.height });
  })()`);
  const segScreen = async (f1, f2) => JSON.parse(await evalJs(`(() => {
    const wrap = document.querySelectorAll('.page-wrap')[0];
    const r = wrap.getBoundingClientRect();
    return JSON.stringify([[r.left + ${f1.fx} * r.width, r.top + ${f1.fy} * r.height],
                           [r.left + ${f2.fx} * r.width, r.top + ${f2.fy} * r.height]]);
  })()`));

  // ---- draw one short diagonal stroke at ~222%
  const fA = JSON.parse(await fracOf(150, 400));
  const fB = JSON.parse(await fracOf(230, 460));
  void fA.wl; void fB;
  await touch("touchStart", [[150, 400, 0]]);
  for (let i = 1; i <= 10; i++) {
    await touch("touchMove", [[150 + i * 8, 400 + i * 6, 0]]);
    await sleep(15);
  }
  await touch("touchEnd", []);
  await sleep(900);
  const seg1 = await segScreen(fA, fB);
  let res = JSON.parse(await strayInk([seg1]));
  checkGhost("after draw @222%: no stray ink", res, errors);

  // ---- zoom to ~600% (buttons), settle
  for (let i = 0; i < 4; i++) { await evalJs(`document.getElementById('zoomin').click()`); await sleep(120); }
  await sleep(1200);
  const seg2 = await segScreen(fA, fB);
  res = JSON.parse(await strayInk([seg2]));
  checkGhost("after zoom to high: no ghosts at stale positions", res, errors);

  // ---- draw a second stroke while highly zoomed
  const fC = JSON.parse(await fracOf(200, 300));
  const fD = JSON.parse(await fracOf(260, 340));
  await touch("touchStart", [[200, 300, 1]]);
  for (let i = 1; i <= 8; i++) {
    await touch("touchMove", [[200 + i * 7.5, 300 + i * 5, 1]]);
    await sleep(15);
  }
  await touch("touchEnd", []);
  await sleep(900);

  // ---- zoom back down; BOTH strokes (drawn at different zooms) must land right
  for (let i = 0; i < 2; i++) { await evalJs(`document.getElementById('zoomout').click()`); await sleep(120); }
  await sleep(1000);
  const dnA = JSON.parse(await evalJs(`(() => {
    const wrap = document.querySelectorAll('.page-wrap')[0];
    const r = wrap.getBoundingClientRect();
    return JSON.stringify([[r.left + ${fA.fx} * r.width, r.top + ${fA.fy} * r.height],
                           [r.left + ${fB.fx} * r.width, r.top + ${fB.fy} * r.height],
                           [r.left + ${fC.fx} * r.width, r.top + ${fC.fy} * r.height],
                           [r.left + ${fD.fx} * r.width, r.top + ${fD.fy} * r.height]]);
  })()`));
  const segA = [dnA[0], dnA[1]], segB = [dnA[2], dnA[3]];
  res = JSON.parse(await strayInk([segA, segB]));
  checkGhost("strokes from different zooms coexist cleanly at low zoom", res, errors);


  function checkGhost(name, r, errs) {
    if (r.err) { log("FAIL " + name + "  [" + r.err + "]"); process.exitCode = 1; return; }
    const ok = r.strays === 0;
    log((ok ? "PASS " : "FAIL ") + name +
      `  [ink=${r.total}, strays=${r.strays}` + (r.strays ? ", e.g. @" + r.sample : "") + "]");
    if (!ok) process.exitCode = 1;
  }
  if (errors.length) { log("JS errors: " + JSON.stringify(errors)); process.exitCode = 1; }
  ws.close();
} finally { chrome.kill("SIGKILL"); process.exit(); }
