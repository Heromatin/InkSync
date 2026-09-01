// Blank-frame probe: samples the live PDF canvas alpha over time across a
// zoom change. Any sustained window of ~100% transparency = blank flash.
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
const log = (s) => writeSync(2, s + "\n");
const PORT = 9630;
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

  // fraction of fully-transparent pixels on the first PDF canvas
  const blankFrac = () => evalJs(`(() => {
    const c = document.querySelector('.page-stack canvas');
    if (!c || c.width === 0) return 1;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let blank = 0, n = 0;
    for (let i = 3; i < d.length; i += 160) { n++; if (d[i] === 0) blank++; }
    return blank / n;
  })()`);

  await send("Runtime.enable"); await send("Page.enable");
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Page.navigate", { url: "http://127.0.0.1:8765/writer/3675713f0f24" });
  await sleep(6000);
  log("settled; blank=" + (await blankFrac()).toFixed(3));

  // trigger zoom change, then sample rapidly for 1.5s
  const samples = [];
  const t0 = Date.now();
  await evalJs(`document.getElementById('zoomin').click()`);
  while (Date.now() - t0 < 1600) {
    samples.push(await blankFrac());
    await sleep(25);
  }
  const maxBlank = Math.max(...samples);
  const blankFrames = samples.filter(s => s > 0.5).length;
  log(`zoomin: maxBlank=${maxBlank.toFixed(3)}, frames>50% blank=${blankFrames}/${samples.length}`);

  // same for a pinch gesture
  const samples2 = [];
  const t1 = Date.now();
  await touch("touchStart", [[190, 400, 0], [290, 500, 1]]);
  for (let i = 1; i <= 10; i++) {
    await touch("touchMove", [[190 - i * 7, 400 - i * 7, 0], [290 + i * 7, 500 + i * 7, 1]]);
    await sleep(20);
    samples2.push(await blankFrac());
  }
  await touch("touchEnd", []);
  while (Date.now() - t1 < 2000) { samples2.push(await blankFrac()); await sleep(25); }
  const maxBlank2 = Math.max(...samples2);
  const blankFrames2 = samples2.filter(s => s > 0.5).length;
  log(`pinch: maxBlank=${maxBlank2.toFixed(3)}, frames>50% blank=${blankFrames2}/${samples2.length}`);

  log("JS errors: " + (errors.length ? JSON.stringify(errors) : "none"));
  const ok = maxBlank < 0.5 && maxBlank2 < 0.5 && errors.length === 0;
  log(ok ? "NO-BLANK TEST PASSED" : "NO-BLANK TEST FAILED");
  ws.close();
  process.exit(ok ? 0 : 1);
} catch (e) { log("ERROR: " + (e && e.message || e)); process.exit(2); }
finally { chrome.kill("SIGKILL"); }
