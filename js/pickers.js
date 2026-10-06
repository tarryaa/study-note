// テンプレート・紙の色・サイズ・表紙色の選択 UI
import { h } from './util.js';
import { TEMPLATES, PAPERS, PAGE_SIZES, COVERS, FOLDER_COLORS } from './store.js';
import { drawTemplate } from './render.js';

export function templateGrid(state, onChange) {
  const grid = h('div', { class: 'tpl-grid' });
  const items = TEMPLATES.map((t) => {
    const cv = h('canvas', { class: 'tpl-cv' });
    const b = h('button', { class: 'tpl', type: 'button' }, h('span', { class: 'tpl-paper' }, cv), h('span', { class: 'tpl-label', text: t.label }));
    b.addEventListener('click', () => {
      state.template = t.id;
      sync();
      onChange && onChange();
    });
    grid.append(b);
    return { t, b, cv };
  });
  function draw() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = 64, H = 86;
    for (const { t, cv } of items) {
      cv.width = W * dpr;
      cv.height = H * dpr;
      cv.style.width = W + 'px';
      cv.style.height = H + 'px';
      const ctx = cv.getContext('2d');
      // ページ左上の一部を拡大して見せる（細かい罫線でも分かるように）
      const s = (W * dpr) / 300;
      ctx.setTransform(s, 0, 0, s, -20 * s, -40 * s);
      ctx.fillStyle = state.paper;
      ctx.fillRect(0, 0, 794, 1123);
      drawTemplate(ctx, { w: 794, h: 1123, template: t.id, paper: state.paper }, s);
    }
  }
  function sync() {
    for (const { t, b } of items) b.classList.toggle('on', t.id === state.template);
  }
  draw();
  sync();
  grid.redraw = draw;
  return grid;
}

function swatchRow(list, get, set, onChange, cls) {
  const row = h('div', { class: 'swatches ' + (cls || '') });
  const btns = list.map((o) => {
    const b = h('button', { class: 'swatch', type: 'button', title: o.label || '', 'aria-label': o.label || o.c });
    b.style.setProperty('--c', o.c);
    b.addEventListener('click', () => {
      set(o.value);
      sync();
      onChange && onChange();
    });
    row.append(b);
    return { o, b };
  });
  function sync() {
    for (const { o, b } of btns) b.classList.toggle('on', o.value === get());
  }
  sync();
  return row;
}

export function paperSwatches(state, onChange) {
  return swatchRow(PAPERS.map((p) => ({ c: p.c, value: p.c, label: p.label })), () => state.paper, (v) => (state.paper = v), onChange, 'paper');
}

export function coverSwatches(state, onChange) {
  return swatchRow(Object.entries(COVERS).map(([k, c]) => ({ c, value: k, label: k })), () => state.cover, (v) => (state.cover = v), onChange);
}

export function folderSwatches(state, onChange) {
  return swatchRow(FOLDER_COLORS.map((c) => ({ c, value: c })), () => state.color, (v) => (state.color = v), onChange);
}

export function sizeKeyOf(w, hh) {
  for (const [k, s] of Object.entries(PAGE_SIZES)) if (Math.abs(s.w - w) < 1 && Math.abs(s.h - hh) < 1) return k;
  return null;
}

export function sizeChips(state, onChange) {
  const row = h('div', { class: 'size-chips' });
  const btns = Object.entries(PAGE_SIZES).map(([k, s]) => {
    const r = s.w / s.h;
    const iw = r >= 1 ? 22 : Math.round(22 * r), ih = r >= 1 ? Math.round(22 / r) : 22;
    const b = h('button', { class: 'chip size-chip', type: 'button' }, h('i', { class: 'size-ico', style: { width: iw + 'px', height: Math.min(30, ih) + 'px' } }), h('span', { text: s.label }));
    b.addEventListener('click', () => {
      state.size = k;
      sync();
      onChange && onChange();
    });
    row.append(b);
    return { k, b };
  });
  function sync() {
    for (const { k, b } of btns) b.classList.toggle('on', k === state.size);
  }
  sync();
  return row;
}
