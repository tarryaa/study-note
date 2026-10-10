// 図形：書いてペンを止めたときの図形認識 ＋ 図形ツールの形状生成
// 認識結果 { kind, pts: Float32Array [x, y, r, ...], center?, tt? }
//   kind: line / arc / curve / polyline / rect / triangle / ellipse / polygon

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function polyLen(P) {
  let L = 0;
  for (let i = 1; i < P.length; i++) L += dist(P[i - 1], P[i]);
  return L;
}

// 弧長で等間隔に N 点へ再サンプル
function resample(P, N) {
  const L = polyLen(P);
  if (L <= 0) return [P[0].slice()];
  const step = L / (N - 1);
  const out = [P[0].slice()];
  let acc = 0;
  let prev = P[0];
  for (let i = 1; i < P.length; i++) {
    const cur = P[i];
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

// Douglas–Peucker（残した点のインデックスを返す）
function dpIdx(P, tol) {
  if (P.length <= 2) return P.map((_, i) => i);
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
  const out = [];
  keep.forEach((k, i) => k && out.push(i));
  return out;
}
const dpOpen = (P, tol) => dpIdx(P, tol).map((i) => P[i]);

function angleAt(p, c, q) {
  const ax = p[0] - c[0], ay = p[1] - c[1], bx = q[0] - c[0], by = q[1] - c[1];
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < 1e-9 || lb < 1e-9) return Math.PI;
  return Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb))));
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

// 最小二乗の直線当てはめ（主成分）
function fitLine(P) {
  const n = P.length;
  let cx = 0, cy = 0;
  for (const p of P) { cx += p[0]; cy += p[1]; }
  cx /= n; cy /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of P) {
    const dx = p[0] - cx, dy = p[1] - cy;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(th), uy = Math.sin(th);
  let maxDev = 0, ss = 0, tmin = Infinity, tmax = -Infinity;
  for (const p of P) {
    const dx = p[0] - cx, dy = p[1] - cy;
    const t = dx * ux + dy * uy;
    const d = Math.abs(-dx * uy + dy * ux);
    if (d > maxDev) maxDev = d;
    ss += d * d;
    if (t < tmin) tmin = t;
    if (t > tmax) tmax = t;
  }
  return { cx, cy, ux, uy, maxDev, rms: Math.sqrt(ss / n), len: tmax - tmin };
}

// 円の当てはめ（Kåsa 法）
function fitCircle(P) {
  const n = P.length;
  let mx = 0, my = 0;
  for (const p of P) { mx += p[0]; my += p[1]; }
  mx /= n; my /= n;
  let Suu = 0, Svv = 0, Suv = 0, Suuu = 0, Svvv = 0, Suvv = 0, Svuu = 0;
  for (const p of P) {
    const u = p[0] - mx, v = p[1] - my;
    Suu += u * u; Svv += v * v; Suv += u * v;
    Suuu += u * u * u; Svvv += v * v * v; Suvv += u * v * v; Svuu += v * u * u;
  }
  const det = Suu * Svv - Suv * Suv;
  if (Math.abs(det) < 1e-9) return null;
  const a = 0.5 * (Suuu + Suvv), b = 0.5 * (Svvv + Svuu);
  const uc = (a * Svv - b * Suv) / det, vc = (b * Suu - a * Suv) / det;
  const cx = uc + mx, cy = vc + my;
  const r = Math.sqrt(uc * uc + vc * vc + (Suu + Svv) / n);
  let err = 0;
  for (const p of P) err += Math.abs(Math.hypot(p[0] - cx, p[1] - cy) - r);
  return { cx, cy, r, err: err / n / r };
}

function snapAng(a, step, tol) {
  const s = Math.round(a / step) * step;
  return Math.abs(a - s) < tol ? s : a;
}

function ellipsePts(e) {
  let { a, b, th } = e;
  if (Math.abs(a - b) / Math.max(a, b) < 0.22) {
    // 縦横の差が 2 割強くらいまでなら正円にする
    a = b = e.r || (a + b) / 2;
    th = 0;
  } else th = snapAng(th, Math.PI / 2, 0.14);
  const N = 72;
  const out = [];
  const c = Math.cos(th), s = Math.sin(th);
  for (let i = 0; i <= N; i++) {
    const t = ((i % N) / N) * Math.PI * 2;
    const u = a * Math.cos(t), v = b * Math.sin(t);
    out.push([e.cx + u * c - v * s, e.cy + u * s + v * c]);
  }
  return out;
}

function rectify(V) {
  for (let i = 0; i < 4; i++) {
    const ang = angleAt(V[(i + 3) % 4], V[i], V[(i + 1) % 4]);
    if (Math.abs(ang - Math.PI / 2) > 0.45) return V;
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

// Catmull-Rom で点列をなめらかにつなぐ
function catmull(V, z) {
  if (V.length < 3) return V.slice();
  const out = [V[0].slice()];
  for (let i = 0; i < V.length - 1; i++) {
    const p0 = V[Math.max(0, i - 1)], p1 = V[i], p2 = V[i + 1], p3 = V[Math.min(V.length - 1, i + 2)];
    const n = Math.max(2, Math.min(40, Math.ceil((dist(p1, p2) * z) / 4)));
    for (let k = 1; k <= n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return out;
}

// ---- 曲線を整える：1 本の 3 次ベジェ曲線で近似（両端は固定）
function bezierFit(P) {
  const n = P.length;
  if (n < 4) return null;
  const P0 = P[0], P3 = P[n - 1];
  const t = [0];
  let L = 0;
  for (let i = 1; i < n; i++) t.push((L += dist(P[i - 1], P[i])));
  if (L <= 0) return null;
  for (let i = 0; i < n; i++) t[i] /= L;
  const at = (C1, C2, u) => {
    const mu = 1 - u, a = mu * mu * mu, b = 3 * mu * mu * u, c = 3 * mu * u * u, d = u * u * u;
    return [a * P0[0] + b * C1[0] + c * C2[0] + d * P3[0], a * P0[1] + b * C1[1] + c * C2[1] + d * P3[1]];
  };
  let C1 = null, C2 = null;
  for (let iter = 0; iter < 5; iter++) {
    let a11 = 0, a12 = 0, a22 = 0, bx1 = 0, by1 = 0, bx2 = 0, by2 = 0;
    for (let i = 0; i < n; i++) {
      const u = t[i], mu = 1 - u;
      const A1 = 3 * mu * mu * u, A2 = 3 * mu * u * u, B0 = mu * mu * mu, B3 = u * u * u;
      const rx = P[i][0] - B0 * P0[0] - B3 * P3[0], ry = P[i][1] - B0 * P0[1] - B3 * P3[1];
      a11 += A1 * A1; a12 += A1 * A2; a22 += A2 * A2;
      bx1 += A1 * rx; by1 += A1 * ry; bx2 += A2 * rx; by2 += A2 * ry;
    }
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-12) return null;
    C1 = [(bx1 * a22 - bx2 * a12) / det, (by1 * a22 - by2 * a12) / det];
    C2 = [(a11 * bx2 - a12 * bx1) / det, (a11 * by2 - a12 * by1) / det];
    // 各点に対応する位置 t を少しずつ合わせ直す（ニュートン法）
    for (let i = 1; i < n - 1; i++) {
      const u = t[i], mu = 1 - u;
      const q = at(C1, C2, u);
      const d1x = 3 * mu * mu * (C1[0] - P0[0]) + 6 * mu * u * (C2[0] - C1[0]) + 3 * u * u * (P3[0] - C2[0]);
      const d1y = 3 * mu * mu * (C1[1] - P0[1]) + 6 * mu * u * (C2[1] - C1[1]) + 3 * u * u * (P3[1] - C2[1]);
      const d2x = 6 * mu * (C2[0] - 2 * C1[0] + P0[0]) + 6 * u * (P3[0] - 2 * C2[0] + C1[0]);
      const d2y = 6 * mu * (C2[1] - 2 * C1[1] + P0[1]) + 6 * u * (P3[1] - 2 * C2[1] + C1[1]);
      const ex = q[0] - P[i][0], ey = q[1] - P[i][1];
      const num = ex * d1x + ey * d1y, den = d1x * d1x + d1y * d1y + ex * d2x + ey * d2y;
      if (Math.abs(den) > 1e-12) t[i] = Math.min(1, Math.max(0, u - num / den));
    }
  }
  let maxErr = 0;
  for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, dist(at(C1, C2, t[i]), P[i]));
  return { at: (u) => at(C1, C2, u), maxErr, len: polyLen([P0, C1, C2, P3]) };
}

// 開いた線をなめらかにならす（両端は動かさない）
function smoothOpen(P, sigma) {
  const n = P.length, out = [P[0].slice()];
  const w = Math.ceil(sigma * 2.5);
  for (let i = 1; i < n - 1; i++) {
    const k = Math.min(w, i, n - 1 - i);
    let sx = 0, sy = 0, sw = 0;
    for (let j = -k; j <= k; j++) {
      const g = Math.exp(-(j * j) / (2 * sigma * sigma));
      sx += P[i + j][0] * g;
      sy += P[i + j][1] * g;
      sw += g;
    }
    out.push([sx / sw, sy / sw]);
  }
  out.push(P[n - 1].slice());
  return out;
}

// ---- 閉じた図形：はっきり曲がっている所（角）を数えて形を決め、角と角のあいだに直線を当てはめて角を作り直す
// （角が少し丸い・書き終わりが少しはみ出した、くらいでは余計な角ができない）
function closedLoop(R, size) {
  let P = R.slice();
  const n = P.length;
  // 書き終わりが書き始めを通り越していたら、いちばん近づいた所で切る
  let best = n - 1, bd = Infinity;
  for (let i = Math.floor(n * 0.7); i < n; i++) {
    const d = dist(P[i], P[0]);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  if (bd < size * 0.18) P = P.slice(0, best + 1);
  return resample(P.concat([P[0].slice()]), 97).slice(0, 96);
}
function turnProfile(Q, w) {
  const n = Q.length, T = new Float64Array(n);
  for (let i = 0; i < n; i++) T[i] = Math.PI - angleAt(Q[(i - w + n) % n], Q[i], Q[(i + w) % n]);
  return T;
}
// 曲がり具合の山（角の候補）を、強い順に・近すぎるものを除いて
function cornerCands(T, minTurn, sep) {
  const n = T.length;
  const order = [...T.keys()].filter((i) => T[i] >= minTurn).sort((a, b) => T[b] - T[a]);
  const out = [];
  for (const i of order) {
    if (out.every((j) => Math.min(Math.abs(i - j), n - Math.abs(i - j)) > sep)) out.push(i);
  }
  return out;
}
function lineCross(A, B) {
  const det = A.ux * B.uy - A.uy * B.ux;
  if (Math.abs(det) < 0.12) return null;
  const dx = B.cx - A.cx, dy = B.cy - A.cy;
  const t = (dx * B.uy - dy * B.ux) / det;
  return [A.cx + A.ux * t, A.cy + A.uy * t];
}
function polyFromCorners(Q, C, size) {
  const n = Q.length, k = C.length;
  const lines = [];
  for (let j = 0; j < k; j++) {
    const a = C[j], len = (C[(j + 1) % k] - a + n) % n || n;
    const m = Math.max(1, Math.floor(len * 0.18));
    const pts = [];
    for (let s = m; s <= len - m; s++) pts.push(Q[(a + s) % n]);
    if (pts.length < 2) pts.push(Q[a], Q[(a + len) % n]);
    lines.push(fitLine(pts));
  }
  const V = [];
  for (let j = 0; j < k; j++) {
    const p = lineCross(lines[(j - 1 + k) % k], lines[j]);
    V.push(p && dist(p, Q[C[j]]) < size * 0.25 ? p : Q[C[j]].slice());
  }
  return V;
}
// 三角形の 1 辺がほぼ水平・垂直なら、ぴったりそろえる
function levelTriangle(V) {
  const c = centroidOf(V);
  let best = null;
  for (let i = 0; i < 3; i++) {
    const p = V[i], q = V[(i + 1) % 3];
    const a = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const sn = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
    if (Math.abs(a - sn) < 0.1 && (best === null || Math.abs(a - sn) < Math.abs(best))) best = a - sn;
  }
  if (best === null) return V;
  const cs = Math.cos(-best), sn = Math.sin(-best);
  return V.map((p) => [c[0] + (p[0] - c[0]) * cs - (p[1] - c[1]) * sn, c[1] + (p[0] - c[0]) * sn + (p[1] - c[1]) * cs]);
}

const toPts = (V, r) => {
  const out = new Float32Array(V.length * 3);
  V.forEach((p, i) => {
    out[i * 3] = p[0];
    out[i * 3 + 1] = p[1];
    out[i * 3 + 2] = r;
  });
  return out;
};
const closeLoop = (V) => V.concat([V[0].slice()]);
function centroidOf(V) {
  let x = 0, y = 0;
  for (const p of V) { x += p[0]; y += p[1]; }
  return [x / V.length, y / V.length];
}
// 弧長パラメータ（0〜1）
function arcParams(V) {
  const tt = new Float32Array(V.length);
  let L = 0;
  for (let i = 1; i < V.length; i++) {
    L += dist(V[i - 1], V[i]);
    tt[i] = L;
  }
  if (L > 0) for (let i = 0; i < V.length; i++) tt[i] /= L;
  return tt;
}

export function snapLineEnd(sx, sy, ex, ey) {
  const dx = ex - sx, dy = ey - sy;
  const L = Math.hypot(dx, dy);
  if (L < 1e-6) return [ex, ey];
  const a = Math.atan2(dy, dx);
  const s = snapAng(a, Math.PI / 4, 0.06);
  if (s === a) return [ex, ey];
  return [sx + Math.cos(s) * L, sy + Math.sin(s) * L];
}

export function recognizeShape(dense, z) {
  const n = Math.floor(dense.length / 3);
  if (n < 2) return null;
  const P = [];
  let rs = 0;
  for (let i = 0; i < n; i++) {
    P.push([dense[i * 3], dense[i * 3 + 1]]);
    rs += dense[i * 3 + 2];
  }
  const r = rs / n;
  const L = polyLen(P);
  if (L * z < 20) return null;
  const R = resample(P, 72);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of P) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  const size = Math.max(x1 - x0, y1 - y0, 1e-6);
  const S = P[0], E = P[n - 1];
  const chord = dist(S, E);

  // ---- 直線（書き始め・書き終わりの「ひっかけ」は無視して判定）
  {
    const spacing = L / (R.length - 1);
    const trimN = Math.max(0, Math.min(8, Math.round(Math.min(L * 0.08, 14 / z) / spacing)));
    const core = R.slice(trimN, R.length - trimN);
    const coreL = L * ((core.length - 1) / (R.length - 1));
    const f = fitLine(core);
    if (chord > 0.72 * L && f.len > 0.85 * coreL && f.maxDev < Math.max(4.5 / z, f.len * 0.06) && f.rms < Math.max(1.8 / z, f.len * 0.025)) {
      const proj = (p) => (p[0] - f.cx) * f.ux + (p[1] - f.cy) * f.uy;
      const tS = proj(S), tE = proj(E);
      const a = [f.cx + f.ux * tS, f.cy + f.uy * tS];
      const b0 = [f.cx + f.ux * tE, f.cy + f.uy * tE];
      const b = snapLineEnd(a[0], a[1], b0[0], b0[1]);
      return { kind: 'line', pts: toPts([a, b], r) };
    }
  }

  const closed = chord < Math.max(0.2 * L, 16 / z);
  if (!closed) {
    // ---- 弧
    const c = fitCircle(R);
    if (c && c.err < 0.04 && c.r * z > 12) {
      let sweep = 0;
      let prev = Math.atan2(R[0][1] - c.cy, R[0][0] - c.cx);
      for (let i = 1; i < R.length; i++) {
        const a = Math.atan2(R[i][1] - c.cy, R[i][0] - c.cx);
        let d = a - prev;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        sweep += d;
        prev = a;
      }
      const sag = Math.max(...R.map((p) => distPtSeg(p, S, E)));
      if (Math.abs(sweep) > 0.5 && Math.abs(sweep) < 5.7 && sag > chord * 0.06) {
        const a0 = Math.atan2(S[1] - c.cy, S[0] - c.cx);
        const N = Math.max(16, Math.min(160, Math.ceil((Math.abs(sweep) * c.r * z) / 5)));
        const V = [];
        for (let i = 0; i <= N; i++) {
          const a = a0 + (sweep * i) / N;
          V.push([c.cx + Math.cos(a) * c.r, c.cy + Math.sin(a) * c.r]);
        }
        return { kind: 'arc', pts: toPts(V, r), tt: arcParams(V) };
      }
    }
    // ---- 折れ線（まっすぐな辺＋はっきりした角）
    const tol = Math.max(4 / z, size * 0.07);
    const idx = dpIdx(R, tol);
    if (idx.length >= 3 && idx.length <= 6) {
      let ok = true;
      for (let k = 0; k < idx.length - 1 && ok; k++) {
        const a = R[idx[k]], b = R[idx[k + 1]];
        const segL = dist(a, b);
        for (let i = idx[k] + 1; i < idx[k + 1]; i++) {
          if (distPtSeg(R[i], a, b) > Math.max(3 / z, segL * 0.05)) { ok = false; break; }
        }
      }
      for (let k = 1; k < idx.length - 1 && ok; k++) {
        if (Math.PI - angleAt(R[idx[k - 1]], R[idx[k]], R[idx[k + 1]]) < 0.45) ok = false;
      }
      if (ok) {
        const V = idx.map((i) => R[i].slice());
        V[0] = S.slice();
        V[V.length - 1] = E.slice();
        return { kind: 'polyline', pts: toPts(V, r) };
      }
    }
    // ---- なめらかな曲線：まず 1 本のきれいなベジェ曲線で近似できるか試す。だめなら手ぶれを強めにならす
    const R2 = R.slice();
    R2[0] = S.slice();
    R2[R2.length - 1] = E.slice();
    const bz = bezierFit(R2);
    if (bz && bz.maxErr < Math.max(4 / z, size * 0.06)) {
      const N = Math.max(16, Math.min(160, Math.ceil((bz.len * z) / 4)));
      const C = [];
      for (let i = 0; i <= N; i++) C.push(bz.at(i / N));
      return { kind: 'curve', pts: toPts(C, r), tt: arcParams(C) };
    }
    const sm = smoothOpen(R2, 3);
    const vi = dpIdx(sm, Math.max(3 / z, size * 0.05));
    if (vi.length <= 12) {
      const V = vi.map((i) => sm[i].slice());
      const C = catmull(V, z);
      return { kind: 'curve', pts: toPts(C, r), tt: arcParams(C) };
    }
    return null;
  }

  // ---- 閉じた図形
  const Q = closedLoop(R, size);
  const T = turnProfile(Q, 4);
  const cand = cornerCands(T, 0.6, 5);
  const strong = cand.filter((i) => T[i] >= 0.95).length;
  const clear = cand.filter((i) => T[i] >= 0.8).length; // 角らしい所の数（多角形の角数を少なく見積もりすぎないため）
  const el = fitEllipse(Q);
  // 角がある図形：角の少ない形から順に試して、当てはまる最初のものにする（三角形が台形に、四角形が多角形にならない）
  if (strong >= 3 || (cand.length >= 3 && !(el && el.err < 0.08))) {
    for (let k = 3; k <= Math.min(8, cand.length); k++) {
      const C = cand.slice(0, k).sort((x, y) => x - y);
      let V = polyFromCorners(Q, C, size);
      const err = polyErr(Q, V, true) / size;
      // はっきりした角が k 個より多いのに k 角形にするのは、ほぼぴったり当てはまるときだけ（五角形が四角形にならないように）
      if (err >= (k < clear ? 0.022 : k <= 4 ? 0.055 : 0.04)) continue;
      if (k === 3) V = levelTriangle(V);
      if (k === 4) V = rectify(V);
      const kind = k === 3 ? 'triangle' : k === 4 ? 'rect' : 'polygon';
      return { kind, pts: toPts(closeLoop(V), r), center: centroidOf(V) };
    }
  }
  // 角のない図形：円・楕円（縦横の差が小さければ正円）
  if (el && el.err < 0.12 && strong <= 2) {
    const c = fitCircle(Q);
    if (c) {
      el.cx = c.cx;
      el.cy = c.cy;
      el.r = c.r;
    }
    return { kind: 'ellipse', pts: toPts(ellipsePts(el), r), center: [el.cx, el.cy] };
  }
  return null;
}

// ---------------------------------------------------------------- 図形ツール
export const SHAPE_KINDS = [
  { id: 'line', label: '直線' },
  { id: 'arrow', label: '矢印' },
  { id: 'darrow', label: '両矢印' },
  { id: 'rect', label: '四角形' },
  { id: 'rrect', label: '角丸四角' },
  { id: 'ellipse', label: '円・楕円' },
  { id: 'tri', label: '三角形' },
  { id: 'rtri', label: '直角三角形' },
  { id: 'diamond', label: 'ひし形' },
  { id: 'penta', label: '五角形' },
  { id: 'hexa', label: '六角形' },
  { id: 'star', label: '星' },
];
export const isOpenShape = (k) => k === 'line' || k === 'arrow' || k === 'darrow';

function arrowHead(ax, ay, bx, by, w) {
  const L = Math.hypot(bx - ax, by - ay) || 1;
  const hl = Math.min(L * 0.45, Math.max(7 + w * 2.6, L * 0.2), 30 + w * 4);
  const ux = (bx - ax) / L, uy = (by - ay) / L;
  const c = Math.cos(0.47), s = Math.sin(0.47);
  return [
    [bx - hl * (ux * c - uy * s), by - hl * (uy * c + ux * s)],
    [bx - hl * (ux * c + uy * s), by - hl * (uy * c - ux * s)],
  ];
}

// (x0,y0) から (x1,y1) までドラッグしたときの図形の点列（[x, y] の配列）と閉じているか
export function shapeGeometry(kind, x0, y0, x1, y1, { w = 2, square = false } = {}) {
  if (isOpenShape(kind)) {
    if (square) [x1, y1] = snapLineEnd(x0, y0, x1, y1);
    if (kind === 'line') return { V: [[x0, y0], [x1, y1]], closed: false };
    const [h1, h2] = arrowHead(x0, y0, x1, y1, w);
    if (kind === 'arrow') return { V: [[x0, y0], [x1, y1], h1, [x1, y1], h2], closed: false };
    const [g1, g2] = arrowHead(x1, y1, x0, y0, w);
    return { V: [g1, [x0, y0], g2, [x0, y0], [x1, y1], h1, [x1, y1], h2], closed: false };
  }
  if (square) {
    const m = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    x1 = x0 + Math.sign(x1 - x0 || 1) * m;
    y1 = y0 + Math.sign(y1 - y0 || 1) * m;
  }
  const l = Math.min(x0, x1), r = Math.max(x0, x1), t = Math.min(y0, y1), b = Math.max(y0, y1);
  const cx = (l + r) / 2, cy = (t + b) / 2, rx = (r - l) / 2, ry = (b - t) / 2;
  let V;
  switch (kind) {
    case 'rect': V = [[l, t], [r, t], [r, b], [l, b]]; break;
    case 'rrect': {
      const rad = Math.min(rx, ry) * 0.45;
      V = [];
      const corner = (ccx, ccy, a0) => {
        for (let i = 0; i <= 8; i++) {
          const a = a0 + (i / 8) * (Math.PI / 2);
          V.push([ccx + Math.cos(a) * rad, ccy + Math.sin(a) * rad]);
        }
      };
      corner(r - rad, t + rad, -Math.PI / 2);
      corner(r - rad, b - rad, 0);
      corner(l + rad, b - rad, Math.PI / 2);
      corner(l + rad, t + rad, Math.PI);
      break;
    }
    case 'ellipse': {
      V = [];
      for (let i = 0; i < 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        V.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
      }
      break;
    }
    case 'tri': V = [[cx, t], [r, b], [l, b]]; break;
    case 'rtri': V = [[l, t], [r, b], [l, b]]; break;
    case 'diamond': V = [[cx, t], [r, cy], [cx, b], [l, cy]]; break;
    case 'penta':
    case 'hexa': {
      const k = kind === 'penta' ? 5 : 6;
      V = [];
      for (let i = 0; i < k; i++) {
        const a = -Math.PI / 2 + (i / k) * Math.PI * 2;
        V.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
      }
      break;
    }
    case 'star': {
      V = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
        const f = i % 2 ? 0.42 : 1;
        V.push([cx + Math.cos(a) * rx * f, cy + Math.sin(a) * ry * f]);
      }
      break;
    }
    default: V = [[l, t], [r, t], [r, b], [l, b]];
  }
  return { V: closeLoop(V), closed: true };
}

export function shapeSvg(kind) {
  const g = isOpenShape(kind) ? shapeGeometry(kind, 4.5, 19.5, 19.5, 4.5, { w: 1.2 }) : shapeGeometry(kind, 4, 5, 20, 19, { w: 1.2 });
  const d = g.V.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join('');
  return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}
