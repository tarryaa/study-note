// 手書きストロークの幾何計算
//  - 筆圧つき可変幅ストロークを、縁が重ならない 1 本の閉じた輪郭（アウトライン）にする
//  - ライブ描画用のスムージング（筆圧の時間平滑化・中点二次ベジェ）と、確定時の間引き（Douglas–Peucker）
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

// ---------- 輪郭（アウトライン）の生成 ----------
// 以前は「点ごとの円 ＋ 円をつなぐ台形」を重ねて塗っていた。
// これだと筆圧のわずかな揺れで円が 1 つずつ膨らんで縁が数珠つなぎ（点々）になり、
// iPad の描画エンジンでは円と台形の縁が重なる所だけ輪郭が濃くなって、点が並んだように見えていた。
// → 線全体を「左の縁 → 先端の丸 → 右の縁 → 始端の丸」の 1 本の閉じた輪郭として作る。
//   縁が重ならないので、どの倍率でも 1 本のなめらかな線になる。
//   曲がり角は、外側を円弧でつなぎ、内側は中心を経由してつなぐ（一般的なストローク描画と同じ方式。nonzero で塗る）
const fx = (v) => Math.round(v * 1000) / 1000;
function svgCircle(out, x, y, r) {
  const R = fx(r);
  out.push(`M${fx(x + r)} ${fx(y)}A${R} ${R} 0 1 0 ${fx(x - r)} ${fx(y)}A${R} ${R} 0 1 0 ${fx(x + r)} ${fx(y)}Z`);
}

// P = [x, y, r, ...] の i0〜i1 番目（＋ extra の点）を 1 本の輪郭にした SVG パス文字列
// cap0 / cap1: 始端・終端を丸くする（false なら平らに切る：書いている途中の継ぎ目用）
//  - なだらかな所：前後の向きの二等分線方向へ、その点の太さだけずらした点を結ぶ（太さの変化がそのまま縁になる）
//  - 角（向きが 18° 以上変わる所）：外側は円弧、内側は中心を経由してつなぐ
const COS_SMOOTH = Math.cos((18 * Math.PI) / 180);
export function outlineSvg(P, i0, i1, extra, cap0 = true, cap1 = true) {
  const X = [], Y = [], R = [];
  const add = (x, y, r) => {
    const n = X.length;
    if (n && Math.abs(x - X[n - 1]) + Math.abs(y - Y[n - 1]) < 1e-4) {
      if (r > R[n - 1]) R[n - 1] = r;
      return;
    }
    X.push(x);
    Y.push(y);
    R.push(r);
  };
  for (let i = i0; i <= i1; i++) add(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
  if (extra) for (const q of extra) add(q[0], q[1], q[2]);
  const n = X.length;
  const out = [];
  if (!n) return '';
  if (n === 1) {
    svgCircle(out, X[0], Y[0], R[0]);
    return out[0];
  }
  const m = n - 1;
  const ux = new Float64Array(m), uy = new Float64Array(m);
  for (let s = 0; s < m; s++) {
    const dx = X[s + 1] - X[s], dy = Y[s + 1] - Y[s], d = Math.hypot(dx, dy);
    ux[s] = dx / d;
    uy[s] = dy / d;
  }
  // 各頂点：なだらかなら二等分線方向のずらし量（左側。右側は逆向き）
  const smooth = new Uint8Array(n), mx = new Float64Array(n), my = new Float64Array(n);
  for (let j = 1; j < m; j++) {
    const c = ux[j - 1] * ux[j] + uy[j - 1] * uy[j];
    if (c < COS_SMOOTH) continue;
    let bx = -uy[j - 1] - uy[j], by = ux[j - 1] + ux[j];
    const bl = Math.hypot(bx, by);
    const f = R[j] / (bl * Math.sqrt((1 + c) / 2));
    smooth[j] = 1;
    mx[j] = bx * f;
    my[j] = by * f;
  }
  const L = (x, y) => out.push(`L${fx(x)} ${fx(y)}`);
  const A = (r, x, y) => out.push(`A${fx(r)} ${fx(r)} 0 0 0 ${fx(x)} ${fx(y)}`);
  // 中心 q・半径 r の円周上を、向き n0 から n1 まで負の向きに回る円弧
  // （90° を超える円弧は 2 つに分ける：半円をそのまま書くと丸め誤差で弧が小さくなるため）
  const arc = (qx, qy, r, n0x, n0y, n1x, n1y) => {
    const dot = n0x * n1x + n0y * n1y, cr = n0x * n1y - n0y * n1x;
    if (dot < 0.2) {
      const h = Math.atan2(cr < 0 ? -cr : cr, dot) / 2;
      const c = Math.cos(h), sn = Math.sin(h);
      A(r, qx + (n0x * c + n0y * sn) * r, qy + (-n0x * sn + n0y * c) * r);
    }
    A(r, qx + n1x * r, qy + n1y * r);
  };
  // 角：たどる向きで縁の向きが n0 → n1 に変わる。外側（負の回転）なら円弧、内側は中心を経由
  const join = (qx, qy, r, n0x, n0y, n1x, n1y) => {
    const tx = qx + n1x * r, ty = qy + n1y * r;
    const dot = n0x * n1x + n0y * n1y;
    if (dot > 0.9998) return L(tx, ty);
    if (n0x * n1y - n0y * n1x < 0) arc(qx, qy, r, n0x, n0y, n1x, n1y);
    else {
      if (dot < 0.94) L(qx, qy);
      L(tx, ty);
    }
  };
  // 左の縁（前向き）。左の法線 = (-uy, ux)
  out.push(`M${fx(X[0] - uy[0] * R[0])} ${fx(Y[0] + ux[0] * R[0])}`);
  for (let j = 1; j < m; j++) {
    if (smooth[j]) L(X[j] + mx[j], Y[j] + my[j]);
    else {
      L(X[j] - uy[j - 1] * R[j], Y[j] + ux[j - 1] * R[j]);
      join(X[j], Y[j], R[j], -uy[j - 1], ux[j - 1], -uy[j], ux[j]);
    }
  }
  const e = m - 1;
  L(X[m] - uy[e] * R[m], Y[m] + ux[e] * R[m]);
  // 先端（半円）。右の法線 = (uy, -ux)
  if (cap1) {
    A(R[m], X[m] + ux[e] * R[m], Y[m] + uy[e] * R[m]);
    A(R[m], X[m] + uy[e] * R[m], Y[m] - ux[e] * R[m]);
  } else L(X[m] + uy[e] * R[m], Y[m] - ux[e] * R[m]);
  // 右の縁（後ろ向き）
  for (let j = m - 1; j >= 1; j--) {
    if (smooth[j]) L(X[j] - mx[j], Y[j] - my[j]);
    else {
      L(X[j] + uy[j] * R[j], Y[j] - ux[j] * R[j]);
      join(X[j], Y[j], R[j], uy[j], -ux[j], uy[j - 1], -ux[j - 1]);
    }
  }
  L(X[0] + uy[0] * R[0], Y[0] - ux[0] * R[0]);
  // 始端（半円）
  if (cap0) {
    A(R[0], X[0] - ux[0] * R[0], Y[0] - uy[0] * R[0]);
    A(R[0], X[0] - uy[0] * R[0], Y[0] + ux[0] * R[0]);
  }
  out.push('Z');
  return out.join('');
}

export function buildInkPath(pts) {
  return new Path2D(outlineSvg(pts, 0, pts.length / 3 - 1, null, true, true));
}

function lineSvg(P, i0, i1, extra) {
  const out = [];
  for (let i = i0; i <= i1; i++) out.push(`${out.length ? 'L' : 'M'}${fx(P[i * 3])} ${fx(P[i * 3 + 1])}`);
  if (extra) for (const q of extra) out.push(`${out.length ? 'L' : 'M'}${fx(q[0])} ${fx(q[1])}`);
  if (out.length === 1) out.push(`L${fx((i0 <= i1 ? P[i0 * 3] : extra[0][0]) + 0.01)} ${fx(i0 <= i1 ? P[i0 * 3 + 1] : extra[0][1])}`);
  return out.join('');
}
export function buildLinePath(pts) {
  const n = pts.length / 3;
  if (!n) return new Path2D();
  return new Path2D(lineSvg(pts, 0, n - 1, null));
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
//  - 筆圧は時間で平滑化（Apple Pencil の細かな揺れで太さがブツブツ変わらないように）
//  - 太さの変化は「進んだ距離あたり」で制限（急に膨らんだ所が玉のように見えるのを防ぐ）
//  - 位置は中点を通る二次ベジェで平滑化
//  - 長い線は前半（frozenN 点まで）を別のキャンバスに 1 本の輪郭として描いておき、毎回描き直す量を一定に保つ
const P_TAU = 26; // 筆圧の平滑化の時定数（ms）
const P_TAU0 = 8; // 書き始め（ペン先が付いた直後）は素早く追従
const R_SLOPE = 0.3; // 太さの変化の上限（半径の変化 / 進んだ距離）
export class LiveStroke {
  constructor({ kind, w, sens = 1, z = 1 }) {
    this.kind = kind;
    this.w = w;
    this.sens = sens;
    this.z = z;
    this.raw = []; // x, y, p, t
    this.dense = []; // x, y, r（平滑化済み）
    this.tol = 0.05 / z;
    this.minStep = 0.22 / z;
    this.ps = -1;
    this.pt = 0;
    this.t0 = 0;
    this.len = 0;
    this.bb = [Infinity, Infinity, -Infinity, -Infinity];
    this.frozenN = 0; // dense のうち、凍結済み（別キャンバスに描いた）点の数
  }
  get count() {
    return this.dense.length / 3;
  }
  rad(p) {
    return this.kind === 'hl' ? this.w / 2 : radiusFor(this.w, p, this.sens);
  }
  add(x, y, p, t) {
    const raw = this.raw;
    if (this.ps < 0) {
      this.ps = p;
      this.t0 = this.pt = t;
    } else {
      const dt = Math.max(0, Math.min(50, t - this.pt));
      this.pt = t;
      const tau = t - this.t0 < 40 ? P_TAU0 : P_TAU;
      this.ps += (p - this.ps) * (1 - Math.exp(-dt / tau));
    }
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
  // 直前の点から距離 ds 進む間に変えてよい太さの範囲に収める
  limitR(r, x, y) {
    const d = this.dense, n = d.length;
    if (!n) return r;
    const lim = R_SLOPE * Math.hypot(x - d[n - 3], y - d[n - 2]) + 1e-4;
    const pr = d[n - 1];
    return r > pr + lim ? pr + lim : r < pr - lim ? pr - lim : r;
  }
  emit(x, y, r, force) {
    const d = this.dense, n = d.length;
    if (n && !force) {
      if (Math.abs(x - d[n - 3]) + Math.abs(y - d[n - 2]) < this.minStep && Math.abs(r - d[n - 1]) < 0.04) return;
    }
    d.push(x, y, this.kind === 'hl' ? r : this.limitR(r, x, y));
  }
  // 未確定の末端（最後の入力点）＋予測点
  tipPts(pred) {
    const raw = this.raw, L = raw.length, d = this.dense, n = d.length;
    if (!L || !n) return null;
    const lx = raw[L - 4], ly = raw[L - 3];
    const lr = this.kind === 'hl' ? this.w / 2 : this.limitR(this.rad(this.ps), lx, ly);
    const out = [[lx, ly, lr]];
    if (pred) for (const q of pred) out.push([q[0], q[1], lr]);
    return out;
  }
  // 凍結していない部分（つなぎ目は 1 区間だけ重ねる）＋ペン先 のパス
  chunkPath(pred) {
    const n = this.count;
    const from = Math.max(0, this.frozenN - 1);
    const tip = this.tipPts(pred);
    if (this.kind === 'hl') return new Path2D(lineSvg(this.dense, from, n - 1, tip));
    return new Path2D(outlineSvg(this.dense, from, n - 1, tip, from === 0, true));
  }
  // 先頭から to 番目までのパス（凍結用。終端は平らに切る）
  prefixPath(to) {
    if (this.kind === 'hl') return new Path2D(lineSvg(this.dense, 0, to, null));
    return new Path2D(outlineSvg(this.dense, 0, to, null, true, false));
  }
  fullPath() {
    const n = this.count;
    if (this.kind === 'hl') return new Path2D(lineSvg(this.dense, 0, n - 1, null));
    return new Path2D(outlineSvg(this.dense, 0, n - 1, null, true, true));
  }
  // 凍結していない部分の範囲（描き直す範囲）
  chunkBB(pred) {
    const d = this.dense, n = this.count;
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    const inc = (x, y, r) => {
      const p = (this.kind === 'hl' ? this.w / 2 : r) + 1;
      if (x - p < b[0]) b[0] = x - p;
      if (y - p < b[1]) b[1] = y - p;
      if (x + p > b[2]) b[2] = x + p;
      if (y + p > b[3]) b[3] = y + p;
    };
    for (let i = Math.max(0, this.frozenN - 1); i < n; i++) inc(d[i * 3], d[i * 3 + 1], d[i * 3 + 2]);
    const tip = this.tipPts(pred);
    if (tip) for (const q of tip) inc(q[0], q[1], q[2]);
    return b;
  }
  lastPoint() {
    const raw = this.raw, L = raw.length;
    return L ? [raw[L - 4], raw[L - 3], this.rad(this.ps)] : null;
  }
  finish() {
    const raw = this.raw, L = raw.length;
    if (!L) return;
    if (L >> 2 >= 2) this.emit(raw[L - 4], raw[L - 3], this.rad(this.ps), true);
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
