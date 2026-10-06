// 図形認識（書いてペンを止めると直線・円・四角形・三角形などに補正）
// dense: [x, y, r, ...]  返り値: { kind, pts: Float32Array [x, y, r, ...] } | null

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function polyLen(P) {
  let L = 0;
  for (let i = 1; i < P.length; i++) L += dist(P[i - 1], P[i]);
  return L;
}

function resample(P, N) {
  const L = polyLen(P);
  if (L <= 0) return [P[0]];
  const step = L / (N - 1);
  const out = [P[0].slice()];
  let acc = 0;
  let prev = P[0];
  for (let i = 1; i < P.length; i++) {
    let cur = P[i];
    let d = dist(prev, cur);
    while (acc + d >= step && d > 0) {
      const t = (step - acc) / d;
      const q = [prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t];
      out.push(q);
      prev = q;
      d = dist(prev, cur);
      acc = 0;
    }
    acc += d;
    prev = cur;
  }
  if (out.length < N) out.push(P[P.length - 1].slice());
  return out;
}

function distPtSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
}
function distPtLine(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return dist(p, a);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / L;
}

function dpOpen(P, tol) {
  if (P.length <= 2) return P.slice();
  const keep = new Array(P.length).fill(false);
  keep[0] = keep[P.length - 1] = true;
  const st = [[0, P.length - 1]];
  while (st.length) {
    const [a, b] = st.pop();
    let md = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distPtSeg(P[i], P[a], P[b]);
      if (d > md) { md = d; idx = i; }
    }
    if (md > tol && idx > 0) {
      keep[idx] = true;
      st.push([a, idx], [idx, b]);
    }
  }
  return P.filter((_, i) => keep[i]);
}

function angleAt(p, c, q) {
  const ax = p[0] - c[0], ay = p[1] - c[1], bx = q[0] - c[0], by = q[1] - c[1];
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < 1e-9 || lb < 1e-9) return Math.PI;
  return Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb))));
}

function cornersClosed(R, size) {
  const tol = size * 0.09;
  const pts = R.slice();
  if (pts.length > 3 && dist(pts[0], pts[pts.length - 1]) < size * 0.2) pts.pop();
  let fi = 0, fd = 0;
  for (let i = 0; i < pts.length; i++) {
    const d = dist(pts[0], pts[i]);
    if (d > fd) { fd = d; fi = i; }
  }
  if (fi === 0) return [];
  const a = dpOpen(pts.slice(0, fi + 1), tol);
  const b = dpOpen(pts.slice(fi).concat([pts[0]]), tol);
  const V = a.concat(b.slice(1, -1));
  let changed = true;
  while (changed && V.length > 3) {
    changed = false;
    for (let i = 0; i < V.length; i++) {
      const p = V[(i - 1 + V.length) % V.length], c = V[i], q = V[(i + 1) % V.length];
      if (angleAt(p, c, q) > Math.PI * 0.8 || dist(p, c) < size * 0.12) {
        V.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return V;
}

function polyErr(R, V, closed) {
  let s = 0;
  const m = V.length;
  for (const p of R) {
    let md = Infinity;
    const segs = closed ? m : m - 1;
    for (let i = 0; i < segs; i++) md = Math.min(md, distPtSeg(p, V[i], V[(i + 1) % m]));
    s += md;
  }
  return s / R.length;
}

function fitEllipse(R) {
  const pts = R.length > 3 && dist(R[0], R[R.length - 1]) < 1e-6 ? R.slice(0, -1) : R;
  const n = pts.length;
  if (n < 6) return null;
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= n; cy /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) {
    const dx = p[0] - cx, dy = p[1] - cy;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const c = Math.cos(th), s = Math.sin(th);
  let s4u = 0, s4v = 0, s22 = 0, s2u = 0, s2v = 0;
  const UV = [];
  for (const p of pts) {
    const dx = p[0] - cx, dy = p[1] - cy;
    const u = dx * c + dy * s, v = -dx * s + dy * c;
    const u2 = u * u, v2 = v * v;
    s4u += u2 * u2; s4v += v2 * v2; s22 += u2 * v2; s2u += u2; s2v += v2;
    UV.push([u2, v2]);
  }
  const det = s4u * s4v - s22 * s22;
  if (Math.abs(det) < 1e-12) return null;
  const A = (s2u * s4v - s22 * s2v) / det;
  const B = (s4u * s2v - s22 * s2u) / det;
  if (!(A > 0 && B > 0)) return null;
  let err = 0;
  for (const [u2, v2] of UV) err += Math.abs(Math.sqrt(u2 * A + v2 * B) - 1);
  err /= n;
  return { cx, cy, a: 1 / Math.sqrt(A), b: 1 / Math.sqrt(B), th, err };
}

function snapAng(a, step, tol) {
  const s = Math.round(a / step) * step;
  return Math.abs(a - s) < tol ? s : a;
}

function ellipsePts(e, r) {
  let { a, b, th } = e;
  if (Math.abs(a - b) / Math.max(a, b) < 0.12) {
    a = b = (a + b) / 2;
    th = 0;
  } else th = snapAng(th, Math.PI / 2, 0.14);
  const N = 72;
  const out = new Float32Array((N + 1) * 3);
  const c = Math.cos(th), s = Math.sin(th);
  for (let i = 0; i <= N; i++) {
    const t = (i % N) / N * Math.PI * 2;
    const u = a * Math.cos(t), v = b * Math.sin(t);
    out[i * 3] = e.cx + u * c - v * s;
    out[i * 3 + 1] = e.cy + u * s + v * c;
    out[i * 3 + 2] = r;
  }
  return out;
}

function rectify(V) {
  for (let i = 0; i < 4; i++) {
    const ang = angleAt(V[(i + 3) % 4], V[i], V[(i + 1) % 4]);
    if (Math.abs(ang - Math.PI / 2) > 0.38) return V;
  }
  let sx = 0, sy = 0;
  for (let i = 0; i < 4; i++) {
    const p = V[i], q = V[(i + 1) % 4];
    const a = Math.atan2(q[1] - p[1], q[0] - p[0]) * 4;
    const L = dist(p, q);
    sx += Math.cos(a) * L;
    sy += Math.sin(a) * L;
  }
  const th = snapAng(Math.atan2(sy, sx) / 4, Math.PI / 2, 0.12);
  let cx = 0, cy = 0;
  for (const p of V) { cx += p[0] / 4; cy += p[1] / 4; }
  const ux = Math.cos(th), uy = Math.sin(th), vx = -uy, vy = ux;
  let hu = 0, hv = 0;
  for (const p of V) {
    const dx = p[0] - cx, dy = p[1] - cy;
    hu += Math.abs(dx * ux + dy * uy) / 4;
    hv += Math.abs(dx * vx + dy * vy) / 4;
  }
  return [
    [cx + ux * hu + vx * hv, cy + uy * hu + vy * hv],
    [cx - ux * hu + vx * hv, cy - uy * hu + vy * hv],
    [cx - ux * hu - vx * hv, cy - uy * hu - vy * hv],
    [cx + ux * hu - vx * hv, cy + uy * hu - vy * hv],
  ];
}

function toPts(V, r, close) {
  const L = close ? V.concat([V[0]]) : V;
  const out = new Float32Array(L.length * 3);
  L.forEach((p, i) => {
    out[i * 3] = p[0];
    out[i * 3 + 1] = p[1];
    out[i * 3 + 2] = r;
  });
  return out;
}

export function snapLineEnd(sx, sy, ex, ey) {
  const dx = ex - sx, dy = ey - sy;
  const L = Math.hypot(dx, dy);
  if (L < 1e-6) return [ex, ey];
  const a = Math.atan2(dy, dx);
  const s = snapAng(a, Math.PI / 4, 0.07);
  if (s === a) return [ex, ey];
  return [sx + Math.cos(s) * L, sy + Math.sin(s) * L];
}

export function recognizeShape(dense, z) {
  const n = Math.floor(dense.length / 3);
  if (n < 3) return null;
  const P = [];
  let rs = 0;
  for (let i = 0; i < n; i++) {
    P.push([dense[i * 3], dense[i * 3 + 1]]);
    rs += dense[i * 3 + 2];
  }
  const r = rs / n;
  const L = polyLen(P);
  if (L * z < 24) return null;
  const R = resample(P, 64);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of P) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  const size = Math.max(x1 - x0, y1 - y0);
  const S = P[0], E = P[n - 1];
  const chord = dist(S, E);

  // 直線
  if (chord > 0.8 * L) {
    let maxDev = 0;
    for (const p of R) maxDev = Math.max(maxDev, distPtLine(p, S, E));
    if (maxDev < Math.max(4 / z, chord * 0.065)) {
      const e = snapLineEnd(S[0], S[1], E[0], E[1]);
      return { kind: 'line', pts: new Float32Array([S[0], S[1], r, e[0], e[1], r]) };
    }
  }

  const closed = chord < Math.max(0.2 * L, 16 / z);
  if (!closed) {
    const V = dpOpen(R, Math.max(4 / z, size * 0.07));
    if (V.length >= 3 && V.length <= 5 && polyErr(R, V, false) / size < 0.03) {
      return { kind: 'polyline', pts: toPts(V, r, false) };
    }
    return null;
  }

  const V = cornersClosed(R, size);
  const pErr = V.length >= 3 ? polyErr(R, V, true) / size : Infinity;
  const el = fitEllipse(R);
  if ((V.length === 3 || V.length === 4) && pErr < 0.05 && (!el || pErr < el.err * 1.4)) {
    if (V.length === 4) return { kind: 'rect', pts: toPts(rectify(V), r, true) };
    return { kind: 'triangle', pts: toPts(V, r, true) };
  }
  if (el && el.err < 0.085) return { kind: 'ellipse', pts: ellipsePts(el, r) };
  if (V.length >= 5 && V.length <= 8 && pErr < 0.04) return { kind: 'polygon', pts: toPts(V, r, true) };
  return null;
}
