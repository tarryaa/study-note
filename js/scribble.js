// 「ぐしゃぐしゃ書き」検出（スクリブルで消去）
// raw: [x, y, p, t, ...]（ページ座標） z: 表示倍率  level: 感度 1（控えめ）〜 10（敏感）
//
// 「あ」「ぬ」「め」のような交差やループのある普通の字では反応しないように:
//  - 手ぶれ・細かいカーブを拾わないよう、線の大きさに応じた許容誤差で折れ線に単純化してから調べる
//  - 判定は「今書いている 1 本の線」だけで行う（ほかの線との重なりは判定に使わない）
//  - ジグザグ：ほぼ真逆に折り返す（約 140° 以上）往復が、途切れずに何回も続いたときだけ。
//    字の中にたまたまある 1〜2 回の折り返し・ゆるい曲がり・ループは数えない
//  - ぐるぐる：同じ向きに何周も回っていて、しかも同じ場所に重なっている（線の長さ ≫ 大きさ）場合だけ
//  - 回転量は「向きつき」で合計するので、手ぶれの左右の揺れは打ち消し合って溜まらない
// 感度 1（控えめ）〜 10（敏感）。数字が大きいほど、少ない往復・ゆるい折り返しで反応する
//   rev   : 続けて必要な往復（折り返し）の回数
//   cos   : 折り返しとみなす向きの変化（-1 = 真逆）
//   ratio : 線の長さ ÷ 大きさ（同じ所を行き来しているほど大きい）
//   loops / loopRatio : ぐるぐるの周回数と、そのときの長さ ÷ 大きさ
//   speed : 平均の速さ（画面上 px/ms）
const LEVELS = {
  rev: [6, 5, 5, 4, 4, 4, 3, 3, 2, 2],
  cos: [-0.9, -0.88, -0.86, -0.84, -0.82, -0.8, -0.78, -0.75, -0.72, -0.68],
  ratio: [3.6, 3.4, 3.2, 3.0, 2.8, 2.7, 2.6, 2.4, 2.2, 2.0],
  loops: [4.5, 4, 4, 3.5, 3.5, 3, 3, 2.5, 2.5, 2],
  loopRatio: [9, 8.5, 8, 7.5, 7, 6.5, 6, 5.5, 5, 4.5],
  speed: [0.35, 0.32, 0.3, 0.28, 0.25, 0.22, 0.2, 0.17, 0.14, 0.12],
};
export function scribbleParams(level) {
  const x = Math.min(9, Math.max(0, (+level || 6) - 1));
  const i = Math.min(8, Math.floor(x)), f = x - i;
  const P = {};
  for (const k in LEVELS) P[k] = LEVELS[k][i] + (LEVELS[k][i + 1] - LEVELS[k][i]) * f;
  P.rev = Math.round(P.rev);
  return P;
}

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

export function detectScribble(raw, z, level = 6, info = null) {
  // 途中で間が空いた所（ペンが離れていた所）があれば、そこから後ろだけを 1 本の線として調べる
  let n = raw.length >> 2;
  for (let i = n - 1; i > 0; i--) {
    if (raw[i * 4 + 3] - raw[i * 4 - 1] > 110) {
      raw = raw.slice(i * 4);
      n = raw.length >> 2;
      break;
    }
  }
  if (n < 8) return false;
  const P = scribbleParams(level);
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
  if (info) info.ratio = +ratio.toFixed(2);
  if (ratio < Math.min(P.ratio, P.loopRatio)) return false;
  const dt = raw[(n - 1) * 4 + 3] - raw[3];
  if (dt > 0 && (len * z) / dt < P.speed) return false;

  // 大きさの 4%（最低でも画面上 2.5px）より細かい揺れは無視して折れ線にする
  const tol = Math.max(2.5 / z, diag * 0.04);
  const V = simplifyIdx(raw, n, tol);
  const m = V.length;
  if (m < 3) return false;
  const minSeg = Math.max(7 / z, diag * 0.08);
  // 十分長い区間だけを取り出す（折り返し部分の丸みで出来る短い区間は飛ばす）
  const segs = [];
  let turn = 0;
  for (let k = 1; k < m; k++) {
    const a = V[k - 1] * 4, b = V[k] * 4;
    const dx = raw[b] - raw[a], dy = raw[b + 1] - raw[a + 1];
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) continue;
    if (segs.length) {
      const p = segs[segs.length - 1];
      turn += Math.atan2(p.dx * dy - p.dy * dx, p.dx * dx + p.dy * dy);
    }
    segs.push({ dx, dy, L, dt: raw[b + 3] - raw[a + 3] });
  }
  const long = segs.filter((g) => g.L >= minSeg);
  // ジグザグ：長い区間どうしが「ほぼ真逆・同じくらいの長さ・素早い」往復を、途切れずに何回続けたか
  // （字の中にたまたま 1〜2 回ある折り返しは、続けて数えないので反応しない）
  let run = 0, best = 0;
  for (let j = 1; j < long.length; j++) {
    const p = long[j - 1], q = long[j];
    const cos = (p.dx * q.dx + p.dy * q.dy) / (p.L * q.L);
    const similar = Math.min(p.L, q.L) / Math.max(p.L, q.L) >= 0.3;
    // 1 往復ぶんには必ず時間がかかる（時間 0 で戻る＝入力データの重複なので数えない）
    const quick = p.dt > 0 && q.dt > 0 && q.dt <= 450 && p.dt <= 450;
    if (cos < P.cos && similar && quick) {
      run++;
      if (run > best) best = run;
    } else run = 0;
  }
  const loops = Math.abs(turn) / (Math.PI * 2);
  if (info) {
    info.run = best;
    info.loops = +loops.toFixed(2);
  }
  if (best >= P.rev && ratio >= P.ratio) return true;
  // ぐるぐる：同じ向きに何周も、同じ場所で回っている
  return loops >= P.loops && ratio >= P.loopRatio;
}
