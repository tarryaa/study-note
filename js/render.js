// ページの描画（用紙テンプレート・ストローク・画像・テキスト）
import { itemPath, computeBB } from './ink.js';
import { isDarkColor } from './util.js';
import { tplSpacing } from './store.js';

export const FONT = '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic UI", "Meiryo", sans-serif';
export const LINE_H = 1.45;
const MM = 3.7795;

export function drawTemplate(ctx, page, scale = 1, r = null) {
  const t = page.template;
  if (!t || t === 'blank') return;
  const W = page.w, H = page.h;
  const dark = isDarkColor(page.paper);
  const line = dark ? 'rgba(255,255,255,0.15)' : 'rgba(64,104,168,0.28)';
  const soft = dark ? 'rgba(255,255,255,0.10)' : 'rgba(64,104,168,0.17)';
  const strong = dark ? 'rgba(255,255,255,0.28)' : 'rgba(64,104,168,0.50)';
  const lw = Math.max(0.55, 1.05 / scale);
  const ry0 = r ? r.y - 4 : -Infinity, ry1 = r ? r.y + r.h + 4 : Infinity;
  const rx0 = r ? r.x - 4 : -Infinity, rx1 = r ? r.x + r.w + 4 : Infinity;
  ctx.save();
  ctx.lineWidth = lw;
  ctx.strokeStyle = line;
  ctx.fillStyle = line;
  const hl = (y, x0 = 0, x1 = W) => {
    if (y < ry0 || y > ry1) return;
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
  };
  const vl = (x, y0 = 0, y1 = H) => {
    if (x < rx0 || x > rx1) return;
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
  };
  const dots = (sp, rad, ox, oy, x0 = 0, x1 = W, y0 = 0, y1 = H) => {
    ctx.beginPath();
    for (let y = oy; y <= y1; y += sp) {
      if (y < y0 || y < ry0 || y > ry1) continue;
      for (let x = ox; x <= x1; x += sp) {
        if (x < x0 || x < rx0 || x > rx1) continue;
        ctx.moveTo(x + rad, y);
        ctx.arc(x, y, rad, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  };
  switch (t) {
    case 'ruled7':
    case 'ruled6':
    case 'dotruled': {
      const sp = tplSpacing(page) * MM;
      const top = 20 * MM;
      const bottom = H - 12 * MM;
      ctx.beginPath();
      for (let y = top + sp; y <= bottom; y += sp) hl(y);
      ctx.stroke();
      ctx.strokeStyle = strong;
      ctx.beginPath();
      hl(top);
      ctx.stroke();
      if (t === 'dotruled') {
        ctx.fillStyle = strong;
        const ox = (W % (sp * 2)) / 2;
        dots(sp, Math.max(0.9, 0.9 / scale), ox, top, 0, W, top + sp, bottom + 0.5);
      }
      break;
    }
    case 'grid5': {
      const mm = tplSpacing(page);
      const sp = mm * MM;
      const ox = (W % sp) / 2, oy = (H % sp) / 2;
      ctx.strokeStyle = soft;
      ctx.beginPath();
      for (let x = ox; x <= W; x += sp) vl(x);
      for (let y = oy; y <= H; y += sp) hl(y);
      ctx.stroke();
      ctx.strokeStyle = line;
      ctx.beginPath();
      // 太線：細かい方眼は 1cm ごと、それ以外は 4 マスごと
      const sp2 = sp * (mm <= 3 ? Math.max(2, Math.round(10 / mm)) : 4);
      for (let x = ox; x <= W; x += sp2) vl(x);
      for (let y = oy; y <= H; y += sp2) hl(y);
      ctx.stroke();
      break;
    }
    case 'dot5': {
      const sp = tplSpacing(page) * MM;
      ctx.fillStyle = dark ? 'rgba(255,255,255,0.32)' : 'rgba(64,104,168,0.45)';
      dots(sp, Math.max(0.85, 0.8 / scale), (W % sp) / 2, (H % sp) / 2);
      break;
    }
    case 'cornell': {
      const sp = tplSpacing(page) * MM;
      const top = 24 * MM;
      const sum = H * 0.78;
      const cue = W * 0.3;
      ctx.beginPath();
      for (let y = top + sp; y < sum - 2; y += sp) hl(y);
      ctx.stroke();
      ctx.strokeStyle = strong;
      ctx.lineWidth = lw * 1.4;
      ctx.beginPath();
      hl(top);
      hl(sum);
      vl(cue, top, sum);
      ctx.stroke();
      break;
    }
    case 'music': {
      const gap = 2.3 * MM;
      const staffGap = 13 * MM;
      const mx = 12 * MM;
      ctx.strokeStyle = strong;
      ctx.beginPath();
      for (let y = 22 * MM; y + gap * 4 < H - 12 * MM; y += gap * 4 + staffGap) {
        for (let i = 0; i < 5; i++) hl(y + i * gap, mx, W - mx);
        vl(mx, y, y + gap * 4);
        vl(W - mx, y, y + gap * 4);
      }
      ctx.stroke();
      break;
    }
  }
  ctx.restore();
}

// ---------- テキスト ----------
const mctx = document.createElement('canvas').getContext('2d');
export const textFont = (fs) => `${fs}px ${FONT}`;
const TOKEN = /[A-Za-z0-9À-ɏ'’._\-:;,!?%&@#$*+=/()[\]"]+|\s+|[\s\S]/gu;

export function layoutText(text, fs, w) {
  mctx.font = textFont(fs);
  const W = (s) => mctx.measureText(s).width;
  const out = [];
  for (const para of String(text).split('\n')) {
    if (para === '') {
      out.push('');
      continue;
    }
    const toks = para.match(TOKEN) || [];
    let line = '';
    for (const tk of toks) {
      if (W(line + tk) <= w) {
        line += tk;
        continue;
      }
      if (/^\s+$/.test(tk)) {
        out.push(line);
        line = '';
        continue;
      }
      if (line) {
        out.push(line.replace(/\s+$/, ''));
        line = '';
      }
      if (W(tk) <= w) {
        line = tk;
        continue;
      }
      for (const ch of tk) {
        if (line && W(line + ch) > w) {
          out.push(line);
          line = ch;
        } else line += ch;
      }
    }
    out.push(line);
  }
  return out;
}

const linesCache = new WeakMap();
export function textLines(it) {
  let l = linesCache.get(it);
  if (!l) {
    l = layoutText(it.text, it.fs, it.w);
    linesCache.set(it, l);
  }
  return l;
}
export function textHeight(text, fs, w) {
  return Math.max(1, layoutText(text, fs, w).length) * fs * LINE_H;
}

function drawText(ctx, it) {
  const lines = textLines(it);
  const lh = it.fs * LINE_H;
  ctx.save();
  ctx.translate(it.cx, it.cy);
  if (it.r) ctx.rotate(it.r);
  ctx.translate(-it.w / 2, -it.h / 2);
  ctx.font = textFont(it.fs);
  ctx.fillStyle = it.c;
  ctx.textBaseline = 'middle';
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], 0, i * lh + lh / 2);
  ctx.restore();
}

function drawImageItem(ctx, it, assets) {
  const a = assets && assets.get(it.asset);
  ctx.save();
  ctx.translate(it.cx, it.cy);
  if (it.r) ctx.rotate(it.r);
  if (a && a.ok) {
    ctx.drawImage(a.img, -it.w / 2, -it.h / 2, it.w, it.h);
  } else {
    ctx.fillStyle = 'rgba(128,128,128,0.14)';
    ctx.fillRect(-it.w / 2, -it.h / 2, it.w, it.h);
  }
  ctx.restore();
}

const fillCache = new WeakMap();
function fillPath(it) {
  let p = fillCache.get(it);
  if (!p) {
    p = new Path2D();
    const s = it.pts;
    for (let i = 0; i < s.length; i += 3) p[i ? 'lineTo' : 'moveTo'](s[i], s[i + 1]);
    p.closePath();
    fillCache.set(it, p);
  }
  return p;
}

// k = 描画の倍率（デバイスピクセル / ページ座標）。拡大時は線を滑らかに補間したパスを使う
export function drawItem(ctx, it, dark, assets, k = 2) {
  if (it.t === 's') {
    if (it.f) {
      // 図形ツールの塗りつぶし
      ctx.save();
      ctx.globalAlpha = it.fa == null ? 1 : it.fa;
      ctx.fillStyle = it.f;
      ctx.fill(fillPath(it));
      ctx.restore();
    }
    if (it.k === 'hl') {
      ctx.save();
      ctx.globalAlpha = it.a == null ? 0.38 : it.a;
      ctx.globalCompositeOperation = dark ? 'screen' : 'multiply';
      ctx.strokeStyle = it.c;
      ctx.lineWidth = it.w;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(itemPath(it, k));
      ctx.restore();
    } else {
      ctx.fillStyle = it.c;
      ctx.fill(itemPath(it, k));
    }
  } else if (it.t === 'i') drawImageItem(ctx, it, assets);
  else if (it.t === 'x') drawText(ctx, it);
}

export function drawItems(ctx, page, opts = {}) {
  const { hidden, rect, assets, scale = 2 } = opts;
  const dark = isDarkColor(page.paper);
  const items = page.items;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (hidden && hidden.has(it)) continue;
    if (rect) {
      const b = it.bb;
      if (b[0] > rect.x + rect.w || b[2] < rect.x || b[1] > rect.y + rect.h || b[3] < rect.y) continue;
    }
    drawItem(ctx, it, dark, assets, scale);
  }
}

// 画像から作ったページの背景
function drawBg(ctx, page, assets) {
  if (!page.bg) return;
  const a = assets && assets.get(page.bg);
  if (a && a.ok) ctx.drawImage(a.img, 0, 0, page.w, page.h);
}

// ページ全体（ctx の変換は呼び出し側で設定しない。sx, sy で拡大）
export function renderPageTo(ctx, page, sx, sy, opts = {}) {
  ctx.setTransform(sx, 0, 0, sy, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = page.paper;
  ctx.fillRect(0, 0, page.w, page.h);
  drawBg(ctx, page, opts.assets);
  drawTemplate(ctx, page, sx);
  drawItems(ctx, page, { ...opts, scale: Math.max(sx, sy) });
}

// ページの一部だけ描き直す（ctx はページ座標に変換済み）
export function renderRegion(ctx, page, r, scale, opts = {}) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.fillStyle = page.paper;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  drawBg(ctx, page, opts.assets);
  drawTemplate(ctx, page, scale, r);
  drawItems(ctx, page, { ...opts, rect: r, scale });
  ctx.restore();
}

export function itemBounds(it) {
  if (it.t === 's') return computeBB(it.pts);
  const c = Math.abs(Math.cos(it.r || 0)), s = Math.abs(Math.sin(it.r || 0));
  const ex = (c * it.w + s * it.h) / 2, ey = (s * it.w + c * it.h) / 2;
  return [it.cx - ex, it.cy - ey, it.cx + ex, it.cy + ey];
}

// 回転した矩形（画像・テキスト）に点が含まれるか
export function hitBox(it, x, y, pad = 0) {
  const dx = x - it.cx, dy = y - it.cy;
  const c = Math.cos(-(it.r || 0)), s = Math.sin(-(it.r || 0));
  const lx = dx * c - dy * s, ly = dx * s + dy * c;
  return Math.abs(lx) <= it.w / 2 + pad && Math.abs(ly) <= it.h / 2 + pad;
}

export function renderThumb(page, width, assets) {
  const cv = document.createElement('canvas');
  const s = width / page.w;
  cv.width = Math.max(1, Math.round(page.w * s));
  cv.height = Math.max(1, Math.round(page.h * s));
  const ctx = cv.getContext('2d');
  renderPageTo(ctx, page, cv.width / page.w, cv.height / page.h, { assets });
  return cv;
}
