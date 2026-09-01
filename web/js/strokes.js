// Stroke geometry + rendering. All coordinates are in PDF page units
// (the pdf.js viewport at scale=1), so they are independent of zoom level.

export function drawStroke(ctx, s) {
  const pts = s.points;
  if (!pts || pts.length === 0) return;
  ctx.save();
  ctx.strokeStyle = s.color || "#111";
  ctx.fillStyle = s.color || "#111";
  ctx.lineJoin = "round";

  if (s.mode === "highlight") {
    ctx.globalAlpha = 0.32;
    ctx.globalCompositeOperation = "multiply";
    ctx.lineWidth = s.width || 14;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (pts.length === 1) ctx.lineTo(pts[0].x + 0.01, pts[0].y);
    ctx.stroke();
  } else {
    ctx.lineCap = "round";
    const base = s.width || 2;
    if (pts.length === 1) {
      const r = base * (0.5 + 0.7 * (pts[0].p ?? 0.5)) / 2;
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, Math.max(r, 0.4), 0, Math.PI * 2);
      ctx.fill();
    } else {
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i].p ?? 0.5;
        ctx.lineWidth = Math.max(base * (0.45 + 0.9 * p), 0.4);
        ctx.beginPath();
        ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
        ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

export function drawSegment(ctx, s, from, to) {
  // fast incremental path used while the finger/stylus is still down
  ctx.save();
  if (s.mode === "highlight") {
    ctx.globalAlpha = 0.32;
    ctx.globalCompositeOperation = "multiply";
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  } else {
    ctx.strokeStyle = s.color;
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max((s.width || 2) * (0.45 + 0.9 * (to.p ?? 0.5)), 0.4);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }
  ctx.restore();
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return Math.hypot(ex, ey);
}

// Returns true if point (page units) is within radius (+half stroke width) of the stroke.
export function hitTest(s, x, y, radius) {
  const pts = s.points;
  if (!pts || !pts.length) return false;
  const half = (s.width || 2) / 2;
  const r = radius + half;
  if (pts.length === 1) return Math.hypot(pts[0].x - x, pts[0].y - y) <= r;
  for (let i = 1; i < pts.length; i++) {
    if (distToSeg(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= r) return true;
  }
  return false;
}
