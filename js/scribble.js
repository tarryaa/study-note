// 「ぐしゃぐしゃ書き」検出（スクリブルで消去）
// raw: [x, y, p, t, ...]（ページ座標） z: 表示倍率  sens: 0 控えめ / 1 ふつう / 2 敏感
//
// 「あ」「ぬ」「め」のような交差やループのある普通の字では反応しないように:
//  - 手ぶれ・細かいカーブを拾わないよう、線の大きさに応じた許容誤差で折れ線に単純化してから調べる
//  - ジグザグ：ほぼ真逆に折り返す（約 140° 以上）往復だけを数える。ゆるい曲がり・ループは数えない
//  - ぐるぐる：同じ向きに何周も回っていて、しかも同じ場所に重なっている（線の長さ ≫ 大きさ）場合だけ
//  - 回転量は「向きつき」で合計するので、手ぶれの左右の揺れは打ち消し合って溜まらない
const PARAMS = [
  // 控えめ（はっきり何度も往復したときだけ）
  { rev: 6, cos: -0.84, ratio: 3.2, loops: 4, loopRatio: 8, speed: 0.3 },
  // ふつう
  { rev: 4, cos: -0.76, ratio: 2.6, loops: 3, loopRatio: 6.5, speed: 0.2 },
  // 敏感
  { rev: 3, cos: -0.68, ratio: 2.2, loops: 2.5, loopRatio: 5.5, speed: 0.12 },
];

// 折れ線への単純化（Douglas–Peucker、x,y のみ）。残った点の番号を返す
function simplifyIdx(raw, n, tol) {
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [0, n - 1];
  const t2 = tol * tol;
  while (stack.length) {
    const b = stack.pop(), a = stack.pop();
    const ax = raw[a * 4], ay = raw[a * 4 + 1], dx = raw[b * 4] - ax, dy = raw[b * 4 + 1] - ay;
    const L2 = dx * dx + dy * dy;
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const px = raw[i * 4] - ax, py = raw[i * 4 + 1] - ay;
      let d;
      if (L2 > 1e-12) {
        let t = (px * dx + py * dy) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - dx * t, ey = py - dy * t;
        d = ex * ex + ey * ey;
      } else d = px * px + py * py;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > t2 && idx > 0) {
      keep[idx] = 1;
      stack.push(a, idx, idx, b);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

export function detectScribble(raw, z, sens = 1) {
  const n = raw.length >> 2;
  if (n < 8) return false;
  const P = PARAMS[sens] || PARAMS[1];
  // 長さ・範囲・速さ
  let len = 0;
  let x0 = raw[0], y0 = raw[1], x1 = x0, y1 = y0;
  for (let i = 1; i < n; i++) {
    const x = raw[i * 4], y = raw[i * 4 + 1];
    len += Math.hypot(x - raw[i * 4 - 4], y - raw[i * 4 - 3]);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const diag = Math.hypot(x1 - x0, y1 - y0);
  if (diag * z < 14 || len * z < 70) return false;
  const ratio = len / diag;
  if (ratio < Math.min(P.ratio, P.loopRatio)) return false;
  const dt = raw[(n - 1) * 4 + 3] - raw[3];
  if (dt > 0 && (len * z) / dt < P.speed) return false;

  // 大きさの 4%（最低でも画面上 2.5px）より細かい揺れは無視して折れ線にする
  const tol = Math.max(2.5 / z, diag * 0.04);
  const V = simplifyIdx(raw, n, tol);
  const m = V.length;
  if (m < 3) return false;
  const minSeg = Math.max(7 / z, diag * 0.08);
  let rev = 0, turn = 0;
  for (let k = 1; k < m - 1; k++) {
    const a = V[k - 1] * 4, b = V[k] * 4, c = V[k + 1] * 4;
    const ux = raw[b] - raw[a], uy = raw[b + 1] - raw[a + 1];
    const vx = raw[c] - raw[b], vy = raw[c + 1] - raw[b + 1];
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu < 1e-9 || lv < 1e-9) continue;
    const cos = (ux * vx + uy * vy) / (lu * lv);
    turn += Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    // ほぼ真逆への折り返しで、前後の区間がどちらも十分長いものだけ
    if (cos < P.cos && lu >= minSeg && lv >= minSeg) rev++;
  }
  if (rev >= P.rev && ratio >= P.ratio) return true;
  const loops = Math.abs(turn) / (Math.PI * 2);
  return loops >= P.loops && ratio >= P.loopRatio;
}
