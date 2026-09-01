// Touch gesture E2E for the writer page (incl. classification + locking).
// Requires the 3-page test PDF uploaded as doc 3675713f0f24 and a clean
// sidecar for exact stroke-count deltas (relative counts tolerate extras).
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";

const log = (s) => writeSync(2, "[touch] " + s + "\n");
const PORT = 9520;
const BASE = "http://127.0.0.1:8765";
const DOC = "3675713f0f24";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const chrome = spawn("/usr/bin/google-chrome-stable", [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  `--remote-debugging-port=${PORT}`, "--window-size=480,900", "about:blank",
], { stdio: "ignore" });

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
    else if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params).slice(0, 300));
  };
  const send = (method, params = {}) => new Promise(res => {
    const mid = ++id; pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  };
  const touch = (type, points) => send("Input.dispatchTouchEvent", {
    type, touchPoints: points.map((p, i) => ({ x: p[0], y: p[1], id: p[2] ?? i })),
  });
  const strokeCount = () => evalJs(`fetch('/api/meta/${DOC}').then(r => r.json()).then(m => m.strokes)`);

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Page.navigate", { url: `${BASE}/writer/${DOC}` });
  await sleep(6000);
  log("loaded; initial scale: " + await evalJs(`document.getElementById('zoomlabel').textContent`));

  let pass = 0, fail = 0;
  const check = (name, ok) => { log((ok ? "PASS " : "FAIL ") + name); ok ? pass++ : fail++; };

  // ---- 1. one finger draws
  await evalJs(`document.getElementById('scroller').scrollTop = 0`);
  await sleep(300);
  await touch("touchStart", [[150, 400, 0]]);
  for (let i = 1; i <= 10; i++) {
    await touch("touchMove", [[150 + i * 8, 400 + i * 5, 0]]);
    await sleep(15);
  }
  await touch("touchEnd", []);
  await sleep(600);
  const afterDraw = await strokeCount();
  check("one finger draws a stroke", afterDraw > 0);

  // ---- 2. one finger never pans
  const st0 = await evalJs(`document.getElementById('scroller').scrollTop`);
  await touch("touchStart", [[200, 500, 1]]);
  for (let i = 1; i <= 10; i++) {
    await touch("touchMove", [[200 - i * 10, 500 - i * 10, 1]]);
    await sleep(15);
  }
  await touch("touchEnd", []);
  await sleep(400);
  const st1 = await evalJs(`document.getElementById('scroller').scrollTop`);
  const drew2 = (await strokeCount()) > afterDraw;
  check("one finger does not pan", Math.abs(st1 - st0) < 5);
  check("second one-finger gesture draws", drew2);

  // ---- 3. two fingers pan, no stroke
  await touch("touchStart", [[150, 300, 2], [300, 450, 3]]);
  await sleep(80);
  for (let i = 1; i <= 10; i++) {
    await touch("touchMove", [[150 - i * 6, 300 - i * 12, 2], [300 - i * 6, 450 - i * 12, 3]]);
    await sleep(15);
  }
  await touch("touchEnd", []);
  await sleep(500);
  const st2 = await evalJs(`document.getElementById('scroller').scrollTop`);
  const afterPan = await strokeCount();
  check("two fingers pan the viewport", st2 > st1 + 50);
  check("two fingers create no stroke", afterPan === afterDraw + 1);

  // ---- 4. pinch out = zoom in
  const scale0 = await evalJs(`parseFloat(document.getElementById('zoomlabel').textContent)`);
  await touch("touchStart", [[190, 400, 4], [290, 500, 5]]);
  await sleep(80);
  for (let i = 1; i <= 10; i++) {
    await touch("touchMove", [[190 - i * 7, 400 - i * 7, 4], [290 + i * 7, 500 + i * 7, 5]]);
    await sleep(15);
  }
  await touch("touchEnd", []);
  await sleep(800);
  const scale1 = await evalJs(`parseFloat(document.getElementById('zoomlabel').textContent)`);
  check("pinch out zooms in", scale1 > scale0 * 1.3);
  check("pinch creates no stroke", (await strokeCount()) === afterPan);

  // ---- 5. pinch in = zoom out
  await touch("touchStart", [[120, 350, 6], [360, 550, 7]]);
  await sleep(80);
  for (let i = 1; i <= 10; i++) {
    await touch("touchMove", [[120 + i * 12, 350 + i * 10, 6], [360 - i * 12, 550 - i * 10, 7]]);
    await sleep(15);
  }
  await touch("touchEnd", []);
  await sleep(800);
  const scale2 = await evalJs(`parseFloat(document.getElementById('zoomlabel').textContent)`);
  check("pinch in zooms out", scale2 < scale1 * 0.8);

  // ---- 5b. dead zone
  {
    const sc0 = await evalJs(`parseFloat(document.getElementById('zoomlabel').textContent)`);
    const sp0 = await evalJs(`document.getElementById('scroller').scrollTop`);
    await touch("touchStart", [[200, 400, 40], [300, 500, 41]]);
    await sleep(60);
    for (let i = 1; i <= 3; i++) {
      await touch("touchMove", [[200 + i * 2, 400 + i, 40], [300 + i * 2, 500 + i, 41]]);
      await sleep(25);
    }
    await touch("touchEnd", []);
    await sleep(500);
    const sc1 = await evalJs(`parseFloat(document.getElementById('zoomlabel').textContent)`);
    const sp1 = await evalJs(`document.getElementById('scroller').scrollTop`);
    check("dead zone: tiny movement does nothing", sc0 === sc1 && Math.abs(sp1 - sp0) < 5);
  }

  // ---- 5c. mode lock: pan then spread must not zoom
  {
    const sc0 = await evalJs(`parseFloat(document.getElementById('zoomlabel').textContent)`);
    const sp0 = await evalJs(`document.getElementById('scroller').scrollTop`);
    await touch("touchStart", [[150, 300, 42], [250, 400, 43]]);
    await sleep(60);
    for (let i = 1; i <= 8; i++) {
      await touch("touchMove", [[150 - i * 5, 300 - i * 5, 42], [250 - i * 5, 400 - i * 5, 43]]);
      await sleep(15);
    }
    for (let i = 1; i <= 8; i++) {
      await touch("touchMove", [[110 - i * 8, 260 - i * 2, 42], [210 + i * 8, 360 + i * 2, 43]]);
      await sleep(15);
    }
    await touch("touchEnd", []);
    await sleep(600);
    const sc1 = await evalJs(`parseFloat(document.getElementById('zoomlabel').textContent)`);
    const sp1 = await evalJs(`document.getElementById('scroller').scrollTop`);
    check("mode lock: spreading after pan does not zoom", sc0 === sc1);
    check("mode lock: pan actually moved the view", Math.abs(sp1 - sp0) > 30);
  }

  // ---- 6. transition: stroke cancelled when 2nd finger lands
  const beforeTrans = await strokeCount();
  await touch("touchStart", [[200, 400, 8]]);
  await touch("touchMove", [[210, 410, 8]]);
  await sleep(50);
  await touch("touchStart", [[280, 500, 9]]);
  await sleep(50);
  for (let i = 1; i <= 8; i++) {
    await touch("touchMove", [[200 + i * 5, 400 - i * 8, 8], [280 + i * 5, 500 - i * 8, 9]]);
    await sleep(15);
  }
  await touch("touchEnd", [[240, 360, 8]]);
  await sleep(200);
  await touch("touchEnd", []);
  await sleep(600);
  const afterTrans = await strokeCount();
  check("mid-stroke 2nd finger cancels the stroke", afterTrans === beforeTrans);

  // ---- 7. leftover finger after gesture draws nothing
  await touch("touchStart", [[150, 300, 10], [300, 450, 11]]);
  await sleep(60);
  await touch("touchMove", [[160, 310, 10], [310, 460, 11]]);
  await sleep(50);
  await touch("touchEnd", [[310, 460, 11]]);
  await sleep(50);
  for (let i = 1; i <= 8; i++) {
    await touch("touchMove", [[160 + i * 8, 310 + i * 8, 10]]);
    await sleep(15);
  }
  await touch("touchEnd", []);
  await sleep(600);
  check("leftover finger after gesture draws nothing", (await strokeCount()) === afterTrans);

  // ---- 8. drawing works again after everything lifted
  await touch("touchStart", [[150, 400, 12]]);
  for (let i = 1; i <= 6; i++) {
    await touch("touchMove", [[150 + i * 6, 400 + i * 4, 12]]);
    await sleep(15);
  }
  await touch("touchEnd", []);
  await sleep(600);
  check("new stroke works after gesture", (await strokeCount()) > afterTrans);

  check("no JS errors", errors.length === 0);
  if (errors.length) log("errors: " + JSON.stringify(errors));

  log(`RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  log("ERROR: " + (e && e.message || e));
  process.exit(2);
} finally {
  chrome.kill("SIGKILL");
}
