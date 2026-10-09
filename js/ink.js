// 手書きストロークの幾何計算
//  - 筆圧つき可変幅ストロークを「円 + 接線台形」の和集合として 1 つの Path2D にする
//    （全サブパスの向きを揃えているので nonzero 塗りで穴・欠けが出ない）
//  - ライブ描画用のスムージング（中点二次ベジェ）と、確定時の間引き（Douglas–Peucker）
//  - 消しゴム用の当たり判定・分割
// 点列は Float32Array [x, y, r, x, y, r, ...]（r = 半径、ページ座標）

export const PEN_TYPES = {
  fountain: { label: '万年筆', sens: 1 },
  ball: { label: 'ボールペン', sens: 0.22 },
  brush: { label: '筆ペン', sens: 1.7 },
};

// 筆圧 → 半径。Apple Pencil の普段の筆圧(≈0.3)で指定太さになるように調整
export function radiusFor(w, p, sens) {
  const q = Math.min(1.75, Math.pow(Math.max(0, p) / 0.3, 0.7));
  const f = 0.35 + 0.65 * q;
  return Math.max(w * 0.07, w * 0.5 * (1 + (f - 1) * sens));
}

const TAU = Math.PI * 2;
function circle(P, x, y, r) {
  P.moveTo(x + r, y);
  P.arc(x, y, r, 0, TAU, true); // 反時計回り＝台形と同じ向き
  P.closePath();
}

// 可変幅ストロークのパスを逐次組み立てる
export class InkPath {
  constructor() {
    this.path = new Path2D();
    this.n = 0;
    this.x = 0; this.y = 0; this.r = 0;
    this.q = false; // 直前に台形があるか
    this.circled = false; // 現在の端点に円があるか
    this.a1x = 0; this.a1y = 0; this.a2x = 0; this.a2y = 0;
  }
  push(x, y, r) {
    const P = this.path;
    if (this.n === 0) {
      circle(P, x, y, r);
      this.x = x; this.y = y; this.r = r; this.n = 1; this.circled = true; this.q = false;
      return;
    }
    const dx = x - this.x, dy = y - this.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-4) {
      if (r > this.r) { circle(P, x, y, r); this.r = r; this.circled = true; this.q = false; }
      return;
    }
    const sa = (this.r - r) / d;
    if (sa >= 0.999 || sa <= -0.999) {
      // 一方の円がもう一方を包含 → 台形は不要
      if (sa <= -0.999) circle(P, x, y, r);
      this.x = x; this.y = y; this.r = r; this.n++;
      this.q = false; this.circled = true;
      return;
    }
    const ca = Math.sqrt(1 - sa * sa);
    const ux = dx / d, uy = dy / d;
    const n1x = ux * sa - uy * ca, n1y = uy * sa + ux * ca;
    const n2x = ux * sa + uy * ca, n2y = uy * sa - ux * ca;
    // 関節の隙間（外側のくさび）が見える大きさなら円で埋める
    if (this.q && !this.circled) {
      const c1 = n1x * this.a1x + n1y * this.a1y;
      const c2 = n2x * this.a2x + n2y * this.a2y;
      const k = 0.02 / this.r;
      if (Math.min(c1, c2) < 1 - 0.5 * k * k) circle(P, this.x, this.y, this.r);
    }
    const lx = this.x, ly = this.y, lr = this.r;
    P.moveTo(lx + n1x * lr, ly + n1y * lr);
    P.lineTo(x + n1x * r, y + n1y * r);
    P.lineTo(x + n2x * r, y + n2y * r);
    P.lineTo(lx + n2x * lr, ly + n2y * lr);
    P.closePath();
    this.a1x = n1x; this.a1y = n1y; this.a2x = n2x; this.a2y = n2y;
    this.q = true; this.circled = false;
    this.x = x; this.y = y; this.r = r; this.n++;
  }
  cap() {
    if (this.n > 0 && !this.circled) {
      circle(this.path, this.x, this.y, this.r);
      this.circled = true;
    }
  }
}

// 確定済みストロークは SVG パス文字列から Path2D を作る
// （Path2D のメソッドを数千回呼ぶより桁違いに速い。InkPath と同じ形状・同じ向き）
const fx = (v) => Math.round(v * 1000) / 1000;
function svgCircle(out, x, y, r) {
  const R = fx(r);
  out.push(`M${fx(x + r)} ${fx(y)}A${R} ${R} 0 1 0 ${fx(x - r)} ${fx(y)}A${R} ${R} 0 1 0 ${fx(x + r)} ${fx(y)}Z`);
}
export function buildInkPath(pts) {
  const n = pts.length / 3;
  const out = [];
  let x = 0, y = 0, r = 0, q = false, circled = false;
  let a1x = 0, a1y = 0, a2x = 0, a2y = 0;
  for (let i = 0; i < n; i++) {
    const px = pts[i * 3], py = pts[i * 3 + 1], pr = pts[i * 3 + 2];
    if (i === 0) {
      svgCircle(out, px, py, pr);
      x = px; y = py; r = pr; circled = true;
      continue;
    }
    const dx = px - x, dy = py - y, d = Math.hypot(dx, dy);
    if (d < 1e-4) {
      if (pr > r) { svgCircle(out, px, py, pr); r = pr; circled = true; q = false; }
      continue;
    }
    const sa = (r - pr) / d;
    if (sa >= 0.999 || sa <= -0.999) {
      if (sa <= -0.999) svgCircle(out, px, py, pr);
      x = px; y = py; r = pr; q = false; circled = true;
      continue;
    }
    const ca = Math.sqrt(1 - sa * sa), ux = dx / d, uy = dy / d;
    const n1x = ux * sa - uy * ca, n1y = uy * sa + ux * ca;
    const n2x = ux * sa + uy * ca, n2y = uy * sa - ux * ca;
    if (q && !circled) {
      const k = 0.02 / r;
      if (Math.min(n1x * a1x + n1y * a1y, n2x * a2x + n2y * a2y) < 1 - 0.5 * k * k) svgCircle(out, x, y, r);
    }
    out.push(`M${fx(x + n1x * r)} ${fx(y + n1y * r)}L${fx(px + n1x * pr)} ${fx(py + n1y * pr)}L${fx(px + n2x * pr)} ${fx(py + n2y * pr)}L${fx(x + n2x * r)} ${fx(y + n2y * r)}Z`);
    a1x = n1x; a1y = n1y; a2x = n2x; a2y = n2y;
    q = true; circled = false;
    x = px; y = py; r = pr;
  }
  if (n && !circled) svgCircle(out, x, y, r);
  return new Path2D(out.join(''));
}

export function buildLinePath(pts) {
  const n = pts.length / 3;
  if (!n) return new Path2D();
  const out = [`M${fx(pts[0])} ${fx(pts[1])}`];
  if (n === 1) out.push(`L${fx(pts[0] + 0.01)} ${fx(pts[1])}`);
  for (let i = 1; i < n; i++) out.push(`L${fx(pts[i * 3])} ${fx(pts[i * 3 + 1])}`);
  return new Path2D(out.join(''));
}

// ---------- 拡大しても角が出ない滑らかな線 ----------
// 保存している点列は折れ線なので、強く拡大すると角（カクカク）が見えてしまう。
// 表示倍率に応じて、点と点のあいだを centripetal Catmull-Rom で補間して細かくする。
//  - 曲がり方が急な点（50° 以上）は「角」として補間しない（図形やカクッとした字はシャープなまま）
//  - 1 デバイスピクセルの 1/10 未満の誤差しか出ない区間は分割しない（普段の倍率では元の点列そのまま）
const CORNER_COS = Math.cos((50 * Math.PI) / 180);
export const LOD_K0 = 4; // この倍率（デバイスピクセル/ページ座標）までは補間なし相当
export const lodOf = (k) => (k <= LOD_K0 ? 0 : Math.min(5, Math.ceil(Math.log2(k / LOD_K0) - 1e-9)));
const lodK = (l) => LOD_K0 * Math.pow(2, l);

function crPoint(out, x0, y0, x1, y1, x2, y2, x3, y3, u) {
  // Barry–Goldman（centripetal：ノット間隔 = 距離^0.5）
  const t1 = Math.sqrt(Math.hypot(x1 - x0, y1 - y0)) || 1e-6;
  const t2 = t1 + (Math.sqrt(Math.hypot(x2 - x1, y2 - y1)) || 1e-6);
  const t3 = t2 + (Math.sqrt(Math.hypot(x3 - x2, y3 - y2)) || 1e-6);
  const t = t1 + (t2 - t1) * u;
  const a1x = ((t1 - t) * x0 + t * x1) / t1, a1y = ((t1 - t) * y0 + t * y1) / t1;
  const a2x = ((t2 - t) * x1 + (t - t1) * x2) / (t2 - t1), a2y = ((t2 - t) * y1 + (t - t1) * y2) / (t2 - t1);
  const a3x = ((t3 - t) * x2 + (t - t2) * x3) / (t3 - t2), a3y = ((t3 - t) * y2 + (t - t2) * y3) / (t3 - t2);
  const b1x = ((t2 - t) * a1x + t * a2x) / t2, b1y = ((t2 - t) * a1y + t * a2y) / t2;
  const b2x = ((t3 - t) * a2x + (t - t1) * a3x) / (t3 - t1), b2y = ((t3 - t) * a2y + (t - t1) * a3y) / (t3 - t1);
  out[0] = ((t2 - t) * b1x + (t - t1) * b2x) / (t2 - t1);
  out[1] = ((t2 - t) * b1y + (t - t1) * b2y) / (t2 - t1);
}

// pts を倍率 k で滑らかに見える点列にする（sharp = 図形：補間しない）
export function refinePts(pts, k, sharp) {
  const n = pts.length / 3;
  if (sharp || n < 3) return pts;
  const tol = 0.1 / k;
  const closed = n > 3 && Math.hypot(pts[0] - pts[(n - 1) * 3], pts[1] - pts[(n - 1) * 3 + 1]) < 1e-3;
  const X = (i) => pts[i * 3], Y = (i) => pts[i * 3 + 1];
  // i の前後で急に曲がっているか
  const corner = (i) => {
    let a = i - 1, b = i + 1;
    if (closed) {
      if (a < 0) a = n - 2;
      if (b > n - 1) b = 1;
    } else if (a < 0 || b > n - 1) return true;
    const ux = X(i) - X(a), uy = Y(i) - Y(a), vx = X(b) - X(i), vy = Y(b) - Y(i);
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu < 1e-6 || lv < 1e-6) return true;
    return (ux * vx + uy * vy) / (lu * lv) < CORNER_COS;
  };
  const isC = new Uint8Array(n);
  for (let i = 0; i < n; i++) isC[i] = corner(i) ? 1 : 0;
  const out = [pts[0], pts[1], pts[2]];
  const q = [0, 0];
  let added = 0;
  for (let i = 0; i < n - 1; i++) {
    const x1 = X(i), y1 = Y(i), x2 = X(i + 1), y2 = Y(i + 1);
    const r1 = pts[i * 3 + 2], r2 = pts[i * 3 + 5];
    let x0, y0, x3, y3;
    if (isC[i]) { x0 = 2 * x1 - x2; y0 = 2 * y1 - y2; }
    else { const a = i - 1 < 0 ? n - 2 : i - 1; x0 = X(a); y0 = Y(a); }
    if (isC[i + 1]) { x3 = 2 * x2 - x1; y3 = 2 * y2 - y1; }
    else { const b = i + 2 > n - 1 ? 1 : i + 2; x3 = X(b); y3 = Y(b); }
    let m = 1;
    if (!(isC[i] && isC[i + 1])) {
      crPoint(q, x0, y0, x1, y1, x2, y2, x3, y3, 0.5);
      const dev = Math.hypot(q[0] - (x1 + x2) / 2, q[1] - (y1 + y2) / 2);
      if (dev > tol) m = Math.min(32, Math.ceil(Math.sqrt(dev / tol)));
    }
    for (let s = 1; s < m; s++) {
      const u = s / m;
      crPoint(q, x0, y0, x1, y1, x2, y2, x3, y3, u);
      out.push(q[0], q[1], r1 + (r2 - r1) * u);
      added++;
    }
    out.push(x2, y2, r2);
  }
  return added ? Float32Array.from(out) : pts;
}

// 倍率 k で描くためのパス（拡大の段階ごとにキャッシュ）
export function strokePath(pts, isHl, k, sharp) {
  const p = refinePts(pts, lodK(lodOf(k)), sharp);
  return isHl ? buildLinePath(p) : buildInkPath(p);
}

const pathCache = new WeakMap();
export function itemPath(it, k = 2) {
  const l = lodOf(k);
  let arr = pathCache.get(it);
  if (!arr) pathCache.set(it, (arr = []));
  let p = arr[l];
  if (!p) p = arr[l] = strokePath(it.pts, it.k === 'hl', k, it.sh);
  return p;
}
// 書き終わった直後は、ライブ描画で作ったパスをそのまま使う
// （書いている時と 1px も違わない形で確定させる。ペンを離した瞬間に線が変わって見えない）
export function setItemPath(it, path, k = 2) {
  if (!path) return;
  let arr = pathCache.get(it);
  if (!arr) pathCache.set(it, (arr = []));
  arr[lodOf(k)] = path;
}

export function computeBB(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1], r = pts[i + 2];
    if (x - r < x0) x0 = x - r;
    if (y - r < y0) y0 = y - r;
    if (x + r > x1) x1 = x + r;
    if (y + r > y1) y1 = y + r;
  }
  return [x0, y0, x1, y1];
}

// Douglas–Peucker（半径の変化も距離に含める）
export function simplify(pts, tol) {
  const n = pts.length / 3;
  if (n <= 2) return Float32Array.from(pts);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [0, n - 1];
  while (stack.length) {
    const b = stack.pop(), a = stack.pop();
    const ax = pts[a * 3], ay = pts[a * 3 + 1], ar = pts[a * 3 + 2];
    const bx = pts[b * 3], by = pts[b * 3 + 1], br = pts[b * 3 + 2];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i * 3], py = pts[i * 3 + 1], pr = pts[i * 3 + 2];
      let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(px - (ax + dx * t), py - (ay + dy * t)) + Math.abs(pr - (ar + (br - ar) * t)) * 0.4;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push(a, idx, idx, b);
    }
  }
  let m = 0;
  for (let i = 0; i < n; i++) if (keep[i]) m++;
  const out = new Float32Array(m * 3);
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    out[j++] = pts[i * 3];
    out[j++] = pts[i * 3 + 1];
    out[j++] = pts[i * 3 + 2];
  }
  return out;
}

// 書いている最中のストローク
export class LiveStroke {
  constructor({ kind, w, sens = 1, z = 1 }) {
    this.kind = kind;
    this.w = w;
    this.sens = sens;
    this.z = z;
    this.raw = []; // x, y, p, t
    this.dense = []; // x, y, r（平滑化済み）
    this.ink = kind === 'hl' ? null : new InkPath();
    this.line = kind === 'hl' ? new Path2D() : null;
    this.tol = 0.05 / z;
    this.minStep = 0.22 / z;
    this.ps = -1;
    this.len = 0;
    this.bb = [Infinity, Infinity, -Infinity, -Infinity];
    // 長い線は一定点数ごとに「凍結」して、毎フレーム描き直す量を一定に保つ
    this.chunks = [];
    this.frozen = [];
    this.chunkN = 0;
    this.cbb = [Infinity, Infinity, -Infinity, -Infinity];
  }
  get current() {
    return this.ink ? this.ink.path : this.line;
  }
  takeFrozen() {
    const f = this.frozen;
    this.frozen = [];
    return f;
  }
  fullPath() {
    if (!this.chunks.length) return this.current;
    const P = new Path2D();
    for (const c of this.chunks) P.addPath(c);
    P.addPath(this.current);
    return P;
  }
  rad(p) {
    return this.kind === 'hl' ? this.w / 2 : radiusFor(this.w, p, this.sens);
  }
  add(x, y, p, t) {
    const raw = this.raw;
    this.ps = this.ps < 0 ? p : this.ps + (p - this.ps) * 0.5;
    const ps = this.ps;
    const L = raw.length;
    if (L) {
      const d = Math.hypot(x - raw[L - 4], y - raw[L - 3]);
      if (d < 0.03 / this.z) {
        raw[L - 2] = ps;
        raw[L - 1] = t;
        return;
      }
      this.len += d;
    }
    raw.push(x, y, ps, t);
    const pad = this.kind === 'hl' ? this.w / 2 + 1 : this.w * 1.2 + 1;
    const b = this.bb;
    if (x - pad < b[0]) b[0] = x - pad;
    if (y - pad < b[1]) b[1] = y - pad;
    if (x + pad > b[2]) b[2] = x + pad;
    if (y + pad > b[3]) b[3] = y + pad;
    const m = raw.length >> 2;
    if (m === 1) this.emit(x, y, this.rad(ps), true);
    else if (m === 2) this.emit((raw[0] + x) / 2, (raw[1] + y) / 2, this.rad((raw[2] + ps) / 2), false);
    else {
      const i0 = (m - 3) * 4, i1 = i0 + 4, i2 = i1 + 4;
      this.curve(
        (raw[i0] + raw[i1]) / 2, (raw[i0 + 1] + raw[i1 + 1]) / 2, (raw[i0 + 2] + raw[i1 + 2]) / 2,
        raw[i1], raw[i1 + 1], raw[i1 + 2],
        (raw[i1] + raw[i2]) / 2, (raw[i1 + 1] + raw[i2 + 1]) / 2, (raw[i1 + 2] + raw[i2 + 2]) / 2
      );
    }
  }
  curve(ax, ay, ap, cx, cy, cp, bx, by, bp) {
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    const dev = L > 1e-6 ? Math.abs((cx - ax) * dy - (cy - ay) * dx) / L : Math.hypot(cx - ax, cy - ay);
    const k = Math.min(16, Math.max(1, Math.ceil(Math.sqrt(dev / (2 * this.tol)))));
    for (let i = 1; i <= k; i++) {
      const t = i / k, mt = 1 - t, a = mt * mt, b = 2 * mt * t, c = t * t;
      this.emit(a * ax + b * cx + c * bx, a * ay + b * cy + c * by, this.rad(a * ap + b * cp + c * bp), false);
    }
  }
  emit(x, y, r, force) {
    const d = this.dense, n = d.length;
    if (n && !force) {
      if (Math.abs(x - d[n - 3]) + Math.abs(y - d[n - 2]) < this.minStep && Math.abs(r - d[n - 1]) < 0.04) return;
    }
    d.push(x, y, r);
    if (this.ink) this.ink.push(x, y, r);
    else if (n === 0) this.line.moveTo(x, y);
    else this.line.lineTo(x, y);
    const pad = this.kind === 'hl' ? this.w / 2 + 1 : r + 1;
    const b = this.cbb;
    if (x - pad < b[0]) b[0] = x - pad;
    if (y - pad < b[1]) b[1] = y - pad;
    if (x + pad > b[2]) b[2] = x + pad;
    if (y + pad > b[3]) b[3] = y + pad;
    if (++this.chunkN >= 120) {
      const done = this.current;
      this.chunks.push(done);
      this.frozen.push(done);
      if (this.ink) {
        this.ink = new InkPath();
        this.ink.push(x, y, r);
      } else {
        this.line = new Path2D();
        this.line.moveTo(x, y);
      }
      this.chunkN = 1;
      this.cbb = [x - pad, y - pad, x + pad, y + pad];
    }
  }
  // 未確定の末端＋予測点
  tip(pred) {
    const raw = this.raw, L = raw.length;
    const d = this.dense, n = d.length;
    if (!L || !n) return null;
    const lx = raw[L - 4], ly = raw[L - 3], lr = this.rad(this.ps);
    if (this.ink) {
      const b = new InkPath();
      b.push(d[n - 3], d[n - 2], d[n - 1]);
      b.push(lx, ly, lr);
      if (pred) for (const q of pred) b.push(q[0], q[1], lr);
      b.cap();
      return b.path;
    }
    const P = new Path2D();
    P.moveTo(d[n - 3], d[n - 2]);
    P.lineTo(lx + 0.001, ly);
    if (pred) for (const q of pred) P.lineTo(q[0], q[1]);
    return P;
  }
  lastPoint() {
    const raw = this.raw, L = raw.length;
    return L ? [raw[L - 4], raw[L - 3], this.rad(this.ps)] : null;
  }
  finish() {
    const raw = this.raw, L = raw.length;
    if (!L) return;
    if (L >> 2 >= 2) this.emit(raw[L - 4], raw[L - 3], this.rad(this.ps), true);
    if (this.ink) this.ink.cap();
  }
  points() {
    const tol = this.kind === 'hl' ? 0.2 / this.z : Math.min(0.1, 0.06 / this.z);
    return simplify(this.dense, tol);
  }
  // 図形認識用：平滑化済みの点＋最後の生点
  allPoints() {
    const lp = this.lastPoint();
    return lp ? this.dense.concat(lp) : this.dense.slice();
  }
}

// ---------- 当たり判定 ----------
export function distPtSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
function cross(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}
function segSegDist(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = cross(cx, cy, dx, dy, ax, ay), d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy), d4 = cross(ax, ay, bx, by, dx, dy);
  if (d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0) return 0;
  return Math.min(
    distPtSeg(ax, ay, cx, cy, dx, dy),
    distPtSeg(bx, by, cx, cy, dx, dy),
    distPtSeg(cx, cy, ax, ay, bx, by),
    distPtSeg(dx, dy, ax, ay, bx, by)
  );
}

export function hitStrokeCircle(it, cx, cy, R) {
  const bb = it.bb;
  if (cx + R < bb[0] || cx - R > bb[2] || cy + R < bb[1] || cy - R > bb[3]) return false;
  const p = it.pts, n = p.length / 3;
  if (n === 1) return Math.hypot(p[0] - cx, p[1] - cy) <= R + p[2];
  for (let i = 0; i < n - 1; i++) {
    const r = Math.max(p[i * 3 + 2], p[i * 3 + 5]);
    if (distPtSeg(cx, cy, p[i * 3], p[i * 3 + 1], p[i * 3 + 3], p[i * 3 + 4]) <= R + r) return true;
  }
  return false;
}

export function hitStrokeSegment(it, ax, ay, bx, by, R) {
  const bb = it.bb;
  if (Math.max(ax, bx) + R < bb[0] || Math.min(ax, bx) - R > bb[2] || Math.max(ay, by) + R < bb[1] || Math.min(ay, by) - R > bb[3]) return false;
  const p = it.pts, n = p.length / 3;
  if (n === 1) return distPtSeg(p[0], p[1], ax, ay, bx, by) <= R + p[2];
  for (let i = 0; i < n - 1; i++) {
    const r = Math.max(p[i * 3 + 2], p[i * 3 + 5]);
    if (segSegDist(ax, ay, bx, by, p[i * 3], p[i * 3 + 1], p[i * 3 + 3], p[i * 3 + 4]) <= R + r) return true;
  }
  return false;
}

// 部分消し：円 (cx,cy,R) に掛かった部分を取り除き、残った断片の配列を返す（無関係なら null）
export function splitStroke(it, cx, cy, R) {
  const p = it.pts, n = p.length / 3;
  if (n === 1) return Math.hypot(p[0] - cx, p[1] - cy) <= R + p[2] ? [] : null;
  const frags = [];
  let cur = [];
  let touched = false;
  if (Math.hypot(p[0] - cx, p[1] - cy) > R + p[2] * 0.5) cur.push(p[0], p[1], p[2]);
  else touched = true;
  for (let i = 0; i < n - 1; i++) {
    const ax = p[i * 3], ay = p[i * 3 + 1], ar = p[i * 3 + 2];
    const bx = p[i * 3 + 3], by = p[i * 3 + 4], br = p[i * 3 + 5];
    const Re = R + (ar + br) * 0.25;
    const dx = bx - ax, dy = by - ay, fx = ax - cx, fy = ay - cy;
    const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - Re * Re;
    let t1 = 2, t2 = -1;
    if (A > 1e-12) {
      const disc = B * B - 4 * A * C;
      if (disc > 0) {
        const s = Math.sqrt(disc);
        t1 = (-B - s) / (2 * A);
        t2 = (-B + s) / (2 * A);
      }
    } else if (C <= 0) {
      t1 = -1;
      t2 = 2;
    }
    if (t2 <= 0 || t1 >= 1) {
      if (!cur.length) cur.push(ax, ay, ar);
      cur.push(bx, by, br);
      continue;
    }
    touched = true;
    if (t1 > 0) {
      if (!cur.length) cur.push(ax, ay, ar);
      cur.push(ax + dx * t1, ay + dy * t1, ar + (br - ar) * t1);
    }
    if (cur.length >= 6) frags.push(cur);
    cur = [];
    if (t2 < 1) cur.push(ax + dx * t2, ay + dy * t2, ar + (br - ar) * t2, bx, by, br);
  }
  if (cur.length >= 6) frags.push(cur);
  if (!touched) return null;
  return frags
    .filter((f) => {
      let L = 0;
      for (let i = 3; i < f.length; i += 3) L += Math.hypot(f[i] - f[i - 3], f[i + 1] - f[i - 2]);
      return L > 0.4;
    })
    .map((f) => Float32Array.from(f));
}

// ---------- スクリブル消去用 ----------
// 点群 [x, y, ...] の凸包（[x, y, ...]）
export function convexHull(xy) {
  const pts = [];
  for (let i = 0; i < xy.length; i += 2) pts.push([xy[i], xy[i + 1]]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return xy.slice();
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) {
    while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
    lo.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop();
    up.push(p);
  }
  const h = lo.slice(0, -1).concat(up.slice(0, -1));
  return h.flat();
}

// ストロークを一定間隔で取り出しながら各点に fn(x, y, r) を呼ぶ
function walkStroke(it, step, fn) {
  const p = it.pts, n = p.length / 3;
  for (let i = 0; i < n; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], r = p[i * 3 + 2];
    if (i > 0) {
      const px = p[i * 3 - 3], py = p[i * 3 - 2], pr = p[i * 3 - 1];
      const k = Math.ceil(Math.hypot(x - px, y - py) / step);
      for (let j = 1; j < k; j++) {
        const t = j / k;
        fn(px + (x - px) * t, py + (y - py) * t, pr + (r - pr) * t);
      }
    }
    fn(x, y, r);
  }
}

// ストロークのうち多角形 P の内側にある割合
export function insideFraction(it, P, step = 2) {
  let inside = 0, total = 0;
  walkStroke(it, step, (x, y) => {
    total++;
    if (pointInPoly(x, y, P)) inside++;
  });
  return total ? inside / total : 0;
}

// 多角形 P の外側に残る部分だけを断片として返す
export function cutStrokeByPoly(it, P, step = 1.2) {
  const frags = [];
  let cur = [];
  walkStroke(it, step, (x, y, r) => {
    if (!pointInPoly(x, y, P)) cur.push(x, y, r);
    else if (cur.length) {
      if (cur.length >= 6) frags.push(cur);
      cur = [];
    }
  });
  if (cur.length >= 6) frags.push(cur);
  return frags.map((f) => simplify(f, 0.06)).filter((f) => {
    let L = 0;
    for (let i = 3; i < f.length; i += 3) L += Math.hypot(f[i] - f[i - 3], f[i + 1] - f[i - 2]);
    return L > 0.6;
  });
}

export function pointInPoly(x, y, P) {
  let inside = false;
  const n = P.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = P[i * 2], yi = P[i * 2 + 1], xj = P[j * 2], yj = P[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
