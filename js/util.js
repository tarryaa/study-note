// 汎用ユーティリティ
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function debounce(fn, ms) {
  let t = 0;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => clearTimeout(t);
  d.flush = (...a) => {
    clearTimeout(t);
    return fn(...a);
  };
  return d;
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function relTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const n = new Date();
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (same(d, n)) return `今日 ${hm}`;
  const y = new Date(n);
  y.setDate(n.getDate() - 1);
  if (same(d, y)) return `昨日 ${hm}`;
  const diff = (n - d) / 86400000;
  if (diff < 7 && diff > 0) return `${Math.ceil(diff)}日前`;
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function parseHex(hex) {
  let s = String(hex || '#000').replace('#', '');
  if (s.length === 3) s = s.split('').map((x) => x + x).join('');
  const n = parseInt(s.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function luminance(hex) {
  const c = parseHex(hex);
  return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
}
export const isDarkColor = (hex) => luminance(hex) < 0.42;

export function canvasToBlob(cv, type = 'image/png', q) {
  return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), type, q));
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// 共有シート（iPad）→ 失敗したらダウンロード
export async function shareFile(blob, name, title) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: title || name });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'aborted';
      if (e && e.name === 'NotAllowedError') return 'needs-gesture';
    }
  }
  downloadBlob(blob, name);
  return 'downloaded';
}

export function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
export async function dataURLToBlob(url) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(url);
  if (!m) throw new Error('bad data url');
  const bin = atob(m[3]);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type: m[1] || 'application/octet-stream' });
}

export function dateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function safeName(s) {
  return String(s || 'note').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'note';
}
