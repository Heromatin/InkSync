// Jitter probe: pinch-zoom at high zoom while tracking the screen position
// of the anchor page-fraction (the point under the finger midpoint). For a
// well-behaved anchor-zoom it must stay within a few px of the finger
// midpoint at every step. Region-anchoring bugs show up as large drift.
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
const log = (s) => writeSync(2, s + "\n");
const PORT = 9650;
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

  // screen position (and page fraction) of the anchor under (240,450)
  const anchor = () => evalJs(`(() => {
    const el = document.elementFromPoint(240, 450);
    const wrap = el && el.closest('.page-wrap');
    if (!wrap) return "null";
    const r = wrap.getBoundingClientRect();
    const idx = [...document.querySelectorAll('.page-wrap')].indexOf(wrap);
    const fx = (240 - r.left) / r.width, fy = (450 - r.top) / r.height;
    return JSON.stringify({ idx, fx, fy });
  })()`);
  const anchorScreen = (a) => evalJs(`(() => {
    const wrap = document.querySelectorAll('.page-wrap')[${a.idx}];
    if (!wrap) return "null";
    const r = wrap.getBoundingClientRect();
    return JSON.stringify({ x: r.left + ${a.fx} * r.width, y: r.top + ${a.fy} * r.height });
  })()`);

  await send("Runtime.enable"); await send("Page.enable");
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Page.navigate", { url: "http://127.0.0.1:8765/writer/3675713f0f24" });
  await sleep(6000);

  const run = async (label, startZoom) => {
    // get to startZoom
    let cur = parseFloat(await evalJs(`document.getElementById('zoomlabel').textContent`));
    const step = startZoom > cur ? "zoomin" : "zoomout";
    while (Math.abs(cur - startZoom) > 12) {
      await evalJs(`document.getElementById('${step}').click()`); await sleep(120);
      cur = parseFloat(await evalJs(`document.getElementById('zoomlabel').textContent`));
    }
    await sleep(900); // settle so the bitmap is crisp
    const a0 = JSON.parse(await anchor());
    log(`${label}: start zoom=${cur}%, anchor page=${a0.idx + 1} fx=${a0.fx.toFixed(3)} fy=${a0.fy.toFixed(3)}`);

    // pinch out slowly, 12 steps, tracking anchor stability per step
    let maxDev = 0, devSum = 0, n = 0;
    await touch("touchStart", [[190, 400, 0], [290, 500, 1]]);
    await sleep(80);
    for (let i = 1; i <= 12; i++) {
      await touch("touchMove", [[190 - i * 5, 400 - i * 5, 0], [290 + i * 5, 500 + i * 5, 1]]);
      await sleep(60);
      const pos = JSON.parse(await anchorScreen(a0));
      if (pos === "null") continue;
      const dev = Math.hypot(pos.x - 240, pos.y - 450);
      maxDev = Math.max(maxDev, dev);
      devSum += dev; n++;
    }
    await touch("touchEnd", []);
    await sleep(900);
    const aEnd = JSON.parse(await anchor());
    const samePoint = aEnd.idx === a0.idx &&
      Math.abs(aEnd.fx - a0.fx) < 0.002 && Math.abs(aEnd.fy - a0.fy) < 0.002;
    log(`${label}: maxDeviation=${maxDev.toFixed(1)}px avg=${(devSum / n).toFixed(1)}px anchorStillUnderFingers=${samePoint}`);
    return { maxDev, samePoint };
  };

  // HIGH zoom run (region mode): start ~278%
  const hi = await run("HIGH", 278);
  // LOW zoom run (full mode): back down to ~150%
  const lo = await run("LOW", 150);

  log("JS errors: " + (errors.length ? JSON.stringify(errors) : "none"));
  const ok = hi.maxDev < 8 && lo.maxDev < 8 && hi.samePoint && lo.samePoint && errors.length === 0;
  log(ok ? "JITTER TEST PASSED" : "JITTER TEST FAILED");
  ws.close();
  process.exit(ok ? 0 : 1);
} catch (e) { log("ERROR: " + (e && e.message || e)); process.exit(2); }
finally { chrome.kill("SIGKILL"); }
