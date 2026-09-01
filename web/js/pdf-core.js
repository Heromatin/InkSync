// Continuous-scroll PDF viewer.
//
// Performance model:
// - Only pages near the viewport own <canvas> elements (the pool). Everything
//   else is a cheap correctly-sized placeholder div, so a 1000-page document
//   costs the same RAM as a 5-page one.
// - Region rendering: if a whole page at the current zoom would exceed the
//   backing-store budget, only the visible region (+ margin) is rendered via
//   pdf.js `clip`. Canvas size is bounded by the VIEWPORT, not the zoom
//   level, so extreme zoom costs the same as normal zoom.
// - Zooming is local and cheap: existing bitmaps are CSS-stretched during the
//   gesture (zero renders), and one high-quality render happens after the
//   gesture settles. Panning is pure scroll (compositor) and only re-renders
//   a page when the view leaves its rendered region.
// - The document is parsed once; scrolling/zooming never touch the network.
// - All coordinates exposed to callers are in PDF page units (viewport at
//   scale=1), independent of on-screen zoom.

import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";
import { drawStroke } from "./strokes.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url
).toString();

const GAP = 16;
const MIN_SCALE = 0.3;
const MAX_SCALE = 6;
const POOL_LIMIT = 6;             // max pages with live canvases
const SETTLE_MS = 180;            // re-render delay after the last zoom change
const DPR_CAP = 2;                // physical-pixel cap (region rendering keeps this affordable)
const FULL_RENDER_BUDGET = 6e6;   // max backing px for a whole-page render (~24MB)
const REGION_MARGIN = 0.6;        // extra viewport fraction rendered around the visible area
const REGION_STALE_FRAC = 0.15;   // pan within this margin of the region before re-rendering

export class PdfViewer extends EventTarget {
  constructor(scrollEl) {
    super();
    this.scrollEl = scrollEl;
    this.inner = document.createElement("div");
    this.inner.className = "pdf-inner";
    scrollEl.appendChild(this.inner);

    this.doc = null;
    this.pages = [];      // {index,w,h,top,left,wrap,stack,canvas,overlay,region,rendered,rendering}
    this.scale = 1;
    this.strokes = [];    // all strokes; overlay rendering filters by page
    this._suppressUntil = 0;   // programmatic scroll -> don't broadcast camera
    this._layoutGen = 0;
    this._pooled = new Set();  // page indices with live canvases
    this._renderQueued = false;
    this._settleTimer = null;
    this._settlePending = false;
    this._scrollThrottle = null;

    scrollEl.addEventListener("scroll", () => this._onScroll(), { passive: true });
    window.addEventListener("resize", () => { if (this.doc) this.applyLayout(true); });
  }

  _dpr() { return Math.min(window.devicePixelRatio || 1, DPR_CAP); }

  // source: ArrayBuffer (already local, e.g. from IndexedDB) or a URL
  async load(source) {
    const task = source instanceof ArrayBuffer
      ? pdfjsLib.getDocument({ data: source })
      : pdfjsLib.getDocument({ url: source });
    this.doc = await task.promise;

    const frag = document.createDocumentFragment();
    for (let i = 1; i <= this.doc.numPages; i++) {
      const page = await this.doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const wrap = document.createElement("div");
      wrap.className = "page-wrap";
      const stack = document.createElement("div");
      stack.className = "page-stack";
      wrap.appendChild(stack);
      frag.appendChild(wrap);
      this.pages.push({
        index: i, w: vp.width, h: vp.height,
        top: 0, left: 0, wrap, stack,
        canvas: null, overlay: null, region: null, bitmapArea: null,
        rendered: false, rendering: false,
      });
    }
    this.inner.appendChild(frag);
    this.applyLayout(true);
  }

  // ------------------------------------------------------------ layout

  applyLayout(immediate = false) {
    if (!this.pages.length) return;
    this._layoutGen++;

    let maxW = 0;
    for (const p of this.pages) maxW = Math.max(maxW, p.w * this.scale);
    // never narrower than the viewport: pages are centered via p.left, so
    // the inner origin always coincides with the scroll origin and coordinate
    // conversions cannot pick up a centering offset
    const innerW = Math.max(maxW, this.scrollEl.clientWidth);
    let y = GAP;
    for (const p of this.pages) {
      p.top = y;
      p.left = (innerW - p.w * this.scale) / 2;
      const w = Math.round(p.w * this.scale), h = Math.round(p.h * this.scale);
      p.wrap.style.cssText =
        `position:absolute;left:${Math.round(p.left)}px;top:${Math.round(y)}px;width:${w}px;height:${h}px;`;
      y += h + GAP;
    }
    this.inner.style.width = innerW + "px";
    this.inner.style.height = y + "px";

    // pooled pages: stretch existing bitmaps into the new region (cheap);
    // backing reallocation + quality render happen on settle
    for (const idx of this._pooled) this._restretch(idx);

    if (immediate) this.rerenderVisible();
    this._scheduleSettle();
  }

  // During a zoom gesture the existing bitmaps are CSS-stretched. They must
  // stay anchored to the page area they actually contain (bitmapArea, in page
  // units) — NOT to the recomputed target region. Re-anchoring to the moving
  // region shifts the visible content by Δregion every frame, which reads as
  // violent jitter at high zoom (region mode) while full mode stays smooth.
  // With a fixed page coverage the page->screen mapping is a clean similarity
  // transform at every instant, so the zoom is perfectly smooth; the target
  // region only matters when the settle render swaps in the crisp bitmap.
  _restretch(idx) {
    const p = this.pages[idx - 1];
    if (!p.canvas || !p.bitmapArea) return;
    const b = p.bitmapArea;
    const rect = {
      x: b.x * this.scale, y: b.y * this.scale,
      w: b.w * this.scale, h: b.h * this.scale,
    };
    this._placeCanvases(p, p.canvas, p.overlay, rect);
    p.rendered = false;  // bitmap is stretched/stale; re-render on settle
  }

  _scheduleSettle() {
    clearTimeout(this._settleTimer);
    this._settlePending = true;
    this._settleTimer = setTimeout(() => {
      this._settlePending = false;
      for (const idx of this._pooled) this.pages[idx - 1].rendered = false;
      this.rerenderVisible();
    }, SETTLE_MS);
  }

  setScale(s) {
    const cam = this.getCamera();
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
    this.applyLayout();
    if (cam) this.setCamera(cam);
    this.dispatchEvent(new CustomEvent("scalechange", { detail: this.scale }));
  }

  zoomBy(f) { this.setScale(this.scale * f); }

  // ------------------------------------------------------- page pool

  _visibleRange() {
    const margin = this.scrollEl.clientHeight;
    return [this.scrollEl.scrollTop - margin, this.scrollEl.scrollTop + this.scrollEl.clientHeight * 2];
  }

  // Rectangle of the page (in CSS px relative to the page) that should be
  // rendered, with `frac` viewports of margin. Returns {x,y,w,h,full}.
  _visibleRect(p, frac) {
    const cssW = p.w * this.scale, cssH = p.h * this.scale;
    const m = Math.max(this.scrollEl.clientWidth, this.scrollEl.clientHeight) * frac;
    const x0 = Math.max(0, this.scrollEl.scrollLeft - p.left - m);
    const y0 = Math.max(0, this.scrollEl.scrollTop - p.top - m);
    const x1 = Math.min(cssW, this.scrollEl.scrollLeft + this.scrollEl.clientWidth - p.left + m);
    const y1 = Math.min(cssH, this.scrollEl.scrollTop + this.scrollEl.clientHeight - p.top + m);
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  }

  _computeRegion(p) {
    const dpr = this._dpr();
    const cssW = p.w * this.scale, cssH = p.h * this.scale;
    const bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
    if (bw * bh <= FULL_RENDER_BUDGET) {
      return { x: 0, y: 0, w: cssW, h: cssH, bw, bh, full: true };
    }
    const vis = this._visibleRect(p, REGION_MARGIN);
    return {
      x: vis.x, y: vis.y, w: vis.w, h: vis.h,
      bw: Math.round(vis.w * dpr), bh: Math.round(vis.h * dpr), full: false,
    };
  }

  // true if the currently visible area has drifted out of the rendered region
  _regionStale(p) {
    if (!p.region || p.region.full) return false;
    const vis = this._visibleRect(p, REGION_STALE_FRAC);
    if (vis.w <= 0 || vis.h <= 0) return false;
    return vis.x < p.region.x || vis.y < p.region.y ||
           vis.x + vis.w > p.region.x + p.region.w ||
           vis.y + vis.h > p.region.y + p.region.h;
  }

  rerenderVisible() {
    if (this._renderQueued || this._settlePending) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      if (!this.pages.length) return;

      const [viewTop, viewBot] = this._visibleRange();
      const needed = [];
      for (const p of this.pages) {
        const bot = p.top + p.h * this.scale;
        if (bot > viewTop && p.top < viewBot) {
          needed.push(p);
          if (needed.length >= POOL_LIMIT) break;
        }
      }
      const neededSet = new Set(needed.map(p => p.index));

      for (const idx of [...this._pooled]) {
        if (!neededSet.has(idx)) this._release(idx);
      }
      for (const p of needed) {
        if (!this._pooled.has(p.index)) {
          this._acquire(p);
        } else if (!p.rendering) {
          if (p.rendered && !this._regionStale(p)) continue;
          // re-render needed: refresh the target region against the CURRENT
          // scroll. Canvases are NOT repositioned here — they stay anchored
          // to their bitmapArea (see _restretch), so the stretched bitmap
          // never drifts while the fresh render is being prepared.
          p.region = this._computeRegion(p);
          p.rendered = false;
        }
        if (!p.rendered && !p.rendering) this._renderPage(p);
      }
    });
  }

  _acquire(p) {
    const canvas = document.createElement("canvas");
    const overlay = document.createElement("canvas");
    overlay.className = "page-overlay";
    p.region = this._computeRegion(p);
    p.bitmapArea = {
      x: p.region.x / this.scale, y: p.region.y / this.scale,
      w: p.region.w / this.scale, h: p.region.h / this.scale,
    };
    canvas.width = p.region.bw;
    canvas.height = p.region.bh;
    overlay.width = p.region.bw;
    overlay.height = p.region.bh;
    this._placeCanvases(p, canvas, overlay, p.region);
    p.stack.append(canvas, overlay);
    p.canvas = canvas;
    p.overlay = overlay;
    this._pooled.add(p.index);
    p.rendered = false;
    this.redrawOverlay(p.index);
  }

  // positioning ONLY — never assigns width/height, because that clears the
  // backing store and would blank the page until the next render completes
  _placeCanvases(p, canvas, overlay, region) {
    for (const c of [canvas, overlay]) {
      c.style.left = Math.round(region.x) + "px";
      c.style.top = Math.round(region.y) + "px";
      c.style.width = Math.round(region.w) + "px";
      c.style.height = Math.round(region.h) + "px";
    }
  }

  _release(idx) {
    const p = this.pages[idx - 1];
    p.canvas?.remove();
    p.overlay?.remove();
    p.canvas = null;
    p.overlay = null;
    p.region = null;
    p.bitmapArea = null;
    p.rendered = false;
    p.rendering = false;
    this._pooled.delete(idx);
  }

  async _renderPage(p) {
    const gen = this._layoutGen;
    p.rendering = true;
    try {
      const page = await this.doc.getPage(p.index);
      const region = p.region;
      if (!region || gen !== this._layoutGen || !this._pooled.has(p.index)) { p.rendering = false; return; }
      const dpr = this._dpr();
      const vp = page.getViewport({ scale: this.scale * dpr });

      // render offscreen, then blit: keeps the stretched bitmap visible
      // instead of flashing blank while rendering
      const tmp = document.createElement("canvas");
      tmp.width = region.bw;
      tmp.height = region.bh;
      const params = { canvasContext: tmp.getContext("2d"), viewport: vp };
      if (!region.full) {
        // Region rendering: shift the page so the region's top-left corner
        // lands at the canvas origin. pdf.js has NO `clip` render parameter
        // (it is silently ignored — that made every region-mode render show
        // the page's top-left slice and look massively over-zoomed). The
        // documented `transform` param is applied in device space after the
        // viewport transform, so translating by -region*dpr is exact.
        params.transform = [1, 0, 0, 1, -region.x * dpr, -region.y * dpr];
      }
      await page.render(params).promise;
      if (region !== p.region || gen !== this._layoutGen || !this._pooled.has(p.index)) {
        p.rendering = false; return;
      }

      // Atomic swap: the freshly rendered tmp canvas becomes the live canvas
      // element in one DOM operation. The old (stretched) bitmap stays visible
      // until this instant — no blank frame, no width-assignment wipe.
      this._placeCanvases(p, tmp, p.overlay, region);
      if (p.overlay.width !== region.bw) p.overlay.width = region.bw;
      if (p.overlay.height !== region.bh) p.overlay.height = region.bh;
      p.canvas.replaceWith(tmp);
      p.canvas = tmp;
      p.bitmapArea = {
        x: region.x / this.scale, y: region.y / this.scale,
        w: region.w / this.scale, h: region.h / this.scale,
      };
      p.rendered = true;
      this.redrawOverlay(p.index);
    } catch (err) {
      console.warn("render failed", p.index, err);
    }
    p.rendering = false;
  }

  redrawPage(i) {
    this.redrawOverlay(i);
    this.rerenderVisible();
  }

  // Context set up to draw strokes in page units at the current region.
  // Returns null when the page isn't pooled or its backing is stale.
  strokeCtx(pageIndex) {
    if (!this._pooled.has(pageIndex)) return null;
    const p = this.pages[pageIndex - 1];
    if (!p.overlay || !p.region || p.overlay.width !== p.region.bw) return null;
    const ctx = p.overlay.getContext("2d");
    this._applyStrokeTransform(p, ctx);
    return ctx;
  }

  // Backing-store transform for stroke drawing.
  //   page units -> backing px is  scale * dpr
  //   region.x/y are in CSS px (= page units * scale), so their offset in
  //   backing px is  region.x * dpr  (NOT region.x * scale * dpr — mixing
  //   those two scales was the cause of a cross-device position regression).
  _applyStrokeTransform(p, ctx) {
    const dpr = p.overlay.width / p.region.w;   // backing px per CSS px
    const k = this.scale * dpr;                 // backing px per page unit
    ctx.setTransform(k, 0, 0, k, -p.region.x * dpr, -p.region.y * dpr);
  }

  redrawOverlay(pageIndex) {
    if (!this._pooled.has(pageIndex)) return;  // not on screen; drawn when acquired
    const p = this.pages[pageIndex - 1];
    if (!p.overlay || !p.region || p.overlay.width !== p.region.bw) return;
    const ctx = p.overlay.getContext("2d");
    this._applyStrokeTransform(p, ctx);
    // clear in PAGE-UNIT space: (0,0)..(p.w,p.h) always covers the whole
    // canvas regardless of region offset/zoom. (Clearing with CSS-px region
    // coordinates here computed a wrong device rect and left stale strokes
    // behind on every zoom — the "lines shift at high zoom" bug.)
    ctx.clearRect(0, 0, p.w, p.h);
    for (const s of this.strokes) {
      if (s.page === pageIndex) drawStroke(ctx, s);
    }
  }

  redrawAllOverlays() {
    for (const idx of this._pooled) this.redrawOverlay(idx);
  }

  // -------------------------------------------------------- coordinates
  // Uses cached page geometry (one rect read total), not per-page rect reads,
  // so pointer handling is O(1) regardless of document size.
  // The inner div's own rect is used as the origin so that CSS centering
  // (narrow documents on wide screens) cannot bias the conversion — this
  // keeps stored coordinates identical across devices.

  pointToPage(clientX, clientY) {
    const r = this.inner.getBoundingClientRect();
    const ix = clientX - r.left;
    const iy = clientY - r.top;
    for (const p of this.pages) {
      const w = p.w * this.scale, h = p.h * this.scale;
      if (ix >= p.left && ix <= p.left + w && iy >= p.top && iy <= p.top + h) {
        return { p, x: (ix - p.left) / this.scale, y: (iy - p.top) / this.scale };
      }
    }
    return null;
  }

  getCamera() {
    const r = this.scrollEl.getBoundingClientRect();
    const pt = this.pointToPage(r.left + r.width / 2, r.top + r.height / 2);
    if (!pt) return null;
    return { p: pt.p.index, fy: pt.y / pt.p.h, fx: pt.x / pt.p.w };
  }

  setCamera(cam) {
    const p = this.pages[cam.p - 1];
    if (!p) return;
    this._suppressUntil = Date.now() + 300;
    const targetY = p.top + cam.fy * p.h * this.scale;
    const targetX = p.left + cam.fx * p.w * this.scale;
    this.scrollEl.scrollTop = targetY - this.scrollEl.clientHeight / 2;
    this.scrollEl.scrollLeft = targetX - this.scrollEl.clientWidth / 2;
    this.rerenderVisible();
  }

  currentPage() {
    const cam = this.getCamera();
    return cam ? cam.p : 1;
  }

  _onScroll() {
    if (this._scrollThrottle) return;
    this._scrollThrottle = setTimeout(() => {
      this._scrollThrottle = null;
      this.rerenderVisible();
    }, 120);
    if (Date.now() >= this._suppressUntil) {
      const cam = this.getCamera();
      if (cam) this.dispatchEvent(new CustomEvent("usercamera", { detail: cam }));
    }
  }
}
