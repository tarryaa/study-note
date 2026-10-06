// 「ぐしゃぐしゃ書き」検出（スクリブルで消去）
// raw: [x, y, p, t, ...]（ページ座標） z: 表示倍率  sens: 0 低 / 1 中 / 2 高
const PARAMS = [
  { rev: 6, speed: 0.4, ratio: 2.8 },
  { rev: 4, speed: 0.2, ratio: 2.2 },
  { rev: 3, speed: 0.1, ratio: 1.9 },
];

export function detectScribble(raw, z, sens = 1) {
  const n = raw.length >> 2;
  if (n < 10) return false;
  const P = PARAMS[sens] || PARAMS[1];
  // 画面上 4px 間隔で再サンプリング
  const step = 4 / z;
  const q = [raw[0], raw[1]];
  let acc = 0;
  let px = raw[0], py = raw[1];
  let len = 0;
  let x0 = px, y0 = py, x1 = px, y1 = py;
  for (let i = 1; i < n; i++) {
    const x = raw[i * 4], y = raw[i * 4 + 1];
    const d = Math.hypot(x - px, y - py);
    len += d;
    acc += d;
    if (acc >= step) {
      q.push(x, y);
      acc = 0;
    }
    px = x; py = y;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const m = q.length / 2;
  if (m < 10) return false;
  const diag = Math.hypot(x1 - x0, y1 - y0);
  if (diag * z < 14) return false;
  if (len < diag * P.ratio) return false;
  const dt = raw[(n - 1) * 4 + 3] - raw[3];
  const speed = (len * z) / Math.max(1, dt); // 画面 px / ms
  if (speed < P.speed) return false;
  // 方向ベクトル
  const dirs = [];
  for (let i = 0; i < m - 1; i++) {
    const dx = q[i * 2 + 2] - q[i * 2], dy = q[i * 2 + 3] - q[i * 2 + 1];
    const L = Math.hypot(dx, dy) || 1;
    dirs.push(dx / L, dy / L);
  }
  const k = dirs.length / 2;
  let rev = 0;
  for (let i = 2; i < k - 1; ) {
    const ax = dirs[(i - 2) * 2] + dirs[(i - 1) * 2], ay = dirs[(i - 2) * 2 + 1] + dirs[(i - 1) * 2 + 1];
    const bx = dirs[i * 2] + dirs[(i + 1) * 2], by = dirs[i * 2 + 1] + dirs[(i + 1) * 2 + 1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la > 0.6 && lb > 0.6 && (ax * bx + ay * by) / (la * lb) < -0.55) {
      rev++;
      i += 3;
    } else i++;
  }
  return rev >= P.rev;
}
