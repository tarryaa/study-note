// 設定（localStorage に保存）
const KEY = 'bn.settings.v1';

export const ACCENTS = {
  indigo: '#5b6cf0',
  blue: '#2f7ff0',
  teal: '#12a19a',
  green: '#2f9e5b',
  orange: '#ef7a2d',
  pink: '#e5507f',
  violet: '#8a5cf6',
  graphite: '#4b5563',
};

export const DEFAULTS = {
  theme: 'system', // system | light | dark
  accent: 'indigo',
  dockPos: 'top', // top | bottom | left | right
  fingerDraw: 'auto', // auto | on | off
  penSeen: false,
  scribble: true,
  scribbleLevel: 6, // ぐしゃぐしゃ消しの感度 1（控えめ）〜 10（敏感）
  holdShape: true,
  prediction: true,
  twoFingerUndo: true,
  autoRevert: false,
  zoomMargin: 1.3, // いちばん縮小したときのページまわりの余白（ツールバーの高さの何倍か）
  zoomMarginBottom: 0.6,
  pinchLevel: 5, // 2 本指ズームの感度 1〜10（5 = 指の開き具合そのまま）
  panLevel: 5, // 移動の感度 1〜10（5 = 指の動きそのまま）
  glideLevel: 5, // 指を離したあとの滑り 1〜10
  pageLevel: 5, // ページのめくりやすさ 1（重い）〜 10（軽い）
  libSort: 'updated',
  libView: 'grid',
  newNote: { template: 'ruled7', paper: '#ffffff', size: 'a4p', cover: 'indigo' },
  tplSp: {}, // テンプレートごとに最後に選んだ間隔（mm）
  tools: {
    pen: { colors: ['#1d1d1f', '#1f5fd1', '#e5484d', '#1f8a4c'], ci: 0, widths: [1.2, 2.2, 4], wi: 1, type: 'fountain', sens: 1 },
    hl: { colors: ['#ffd60a', '#7ee0a1', '#ff9ec7', '#8cc8ff'], ci: 0, widths: [10, 16, 26], wi: 1, alpha: 0.38, straight: false },
    eraser: { mode: 'partial', sizes: [10, 24, 48], si: 1, hlOnly: false },
    lasso: { mode: 'free' },
    shape: { kind: 'rect', colors: ['#1d1d1f', '#1f5fd1', '#e5484d', '#1f8a4c'], ci: 0, widths: [1.5, 2.5, 4.5], wi: 1, fill: 'none', square: false },
    stamp: { id: null, scale: 1 },
    text: { colors: ['#1d1d1f', '#1f5fd1', '#e5484d', '#1f8a4c'], ci: 0, sizes: [14, 20, 30], si: 1 },
  },
  tool: 'pen',
  lastNote: null,
  sidebar: true,
  expanded: {},
  welcomed: false,
};

function merge(d, s) {
  if (Array.isArray(d)) return Array.isArray(s) && s.length === d.length ? s : d.slice();
  if (d && typeof d === 'object') {
    const o = {};
    for (const k in d) o[k] = merge(d[k], s && typeof s === 'object' ? s[k] : undefined);
    if (s && typeof s === 'object' && Object.keys(d).length === 0) Object.assign(o, s);
    return o;
  }
  return s === undefined ? d : s;
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    const s = merge(DEFAULTS, raw);
    // 以前の 3 段階（控えめ / ふつう / 敏感）からの引き継ぎ。前より少ない往復で反応する段階にする
    if (raw && raw.scribbleLevel == null && raw.scribbleSens != null) s.scribbleLevel = [5, 6, 8][raw.scribbleSens] || 6;
    return s;
  } catch (_) {
    return merge(DEFAULTS, {});
  }
}

export const settings = load();
const subs = new Set();

export function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (_) {}
  for (const f of subs) f(settings);
}
export function onSettings(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
export function resetSettings() {
  const fresh = merge(DEFAULTS, {});
  const penSeen = settings.penSeen;
  for (const k of Object.keys(settings)) delete settings[k];
  Object.assign(settings, fresh, { welcomed: true, penSeen });
  saveSettings();
}
