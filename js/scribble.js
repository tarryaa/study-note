// 「ぐしゃぐしゃ書き」検出（スクリブルで消去）
// raw: [x, y, p, t, ...]（ページ座標） z: 表示倍率  sens: 0 控えめ / 1 ふつう / 2 敏感
//
// ・入力点がまばらでも判定できるように、線に沿って一定間隔で補間し直してから調べる
// ・ジグザグ（折り返し）だけでなく、ぐるぐる（回転）でも判定する
const PARAMS = [
  { rev: 5, turns: 7, ratio: 2.6, speed: 0.28 },
  { rev: 3, turns: 5, ratio: 2.0, speed: 0.1 },
  { rev: 2, turns: 4, ratio: 1.7, speed: 0.05 },
];

export function detectScribble(raw, z, sens = 1) {
  const n = raw.length >> 2;
  if (n < 6) return false;
  const P = PARAMS[sens] || PARAMS[1];
  // 長さ・範囲
  let len = 0;
  let x0 = raw[0], y0 = raw[1], x1 = x0, y1 = y0;
  for (let i = 1; i < n; i++) {
    const x = raw[i * 4], y = raw[i * 4 + 1];
    len += Math.hypot(x - raw[i * 4 - 4], y - raw[i * 4 - 3]);
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const diag = Math.hypot(x1 - x0, y1 - y0);
  if (diag * z < 10 || len * z < 50) return false;
  if (len < diag * P.ratio) return false;
  const dt = raw[(n - 1) * 4 + 3] - raw[3];
  if (dt > 0 && (len * z) / dt < P.speed) return false;

  // 画面上 3px 間隔で補間しながら再サンプル
  const step = 3 / z;
  const q = [raw[0], raw[1]];
  let acc = 0;
  for (let i = 1; i < n; i++) {
    let px = raw[i * 4 - 4], py = raw[i * 4 - 3];
    const x = raw[i * 4], y = raw[i * 4 + 1];
    let d = Math.hypot(x - px, y - py);
    while (acc + d >= step && d > 0) {
      const t = (step - acc) / d;
      px += (x - px) * t;
      py += (y - py) * t;
      q.push(px, py);
      d = Math.hypot(x - px, y - py);
      acc = 0;
    }
    acc += d;
  }
  const m = q.length / 2;
  if (m < 8) return false;
  const dirs = [];
  for (let i = 0; i < m - 1; i++) {
    const dx = q[i * 2 + 2] - q[i * 2], dy = q[i * 2 + 3] - q[i * 2 + 1];
    const L = Math.hypot(dx, dy) || 1;
    dirs.push(dx / L, dy / L);
  }
  const k = dirs.length / 2;
  // 折り返しの回数
  let rev = 0;
  for (let i = 2; i < k - 1; ) {
    const ax = dirs[(i - 2) * 2] + dirs[(i - 1) * 2], ay = dirs[(i - 2) * 2 + 1] + dirs[(i - 1) * 2 + 1];
    const bx = dirs[i * 2] + dirs[(i + 1) * 2], by = dirs[i * 2 + 1] + dirs[(i + 1) * 2 + 1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la > 0.5 && lb > 0.5 && (ax * bx + ay * by) / (la * lb) < -0.45) {
      rev++;
      i += 2;
    } else i++;
  }
  // 回転量の合計（半回転 = 1）。手ぶれを拾わないよう 6px ごとの向きで測る
  let turn = 0;
  let px = 0, py = 0, has = false;
  for (let i = 0; i + 2 < m; i += 2) {
    const dx = q[i * 2 + 4] - q[i * 2], dy = q[i * 2 + 5] - q[i * 2 + 1];
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) continue;
    const ux = dx / L, uy = dy / L;
    if (has) turn += Math.acos(Math.max(-1, Math.min(1, ux * px + uy * py)));
    px = ux; py = uy; has = true;
  }
  const turns = turn / Math.PI;
  return rev >= P.rev || turns >= P.turns;
}
