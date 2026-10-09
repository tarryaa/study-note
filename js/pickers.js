// テンプレート・紙の色・サイズ・表紙色の選択 UI
import { h } from './util.js';
import { icon } from './icons.js';
import { TEMPLATES, TPL_SP, SP_MIN, SP_MAX, fmtMM, PAPERS, PAGE_SIZES, COVERS, FOLDER_COLORS } from './store.js';
import { drawTemplate } from './render.js';

// opts.onImage を渡すと「画像から」タイルを出す（state.template === 'image' で選択状態）
// state.sp = { テンプレートID: 間隔mm } … 罫線・方眼・ドットの間隔を自由に選べる
const SP_PRESETS = [3, 4, 5, 6, 7, 8, 10];
export function templateGrid(state, onChange, opts = {}) {
  if (!state.sp || typeof state.sp !== 'object') state.sp = {};
  const spOf = (id) => {
    const v = +state.sp[id];
    return v >= SP_MIN && v <= SP_MAX ? v : TPL_SP[id] || 0;
  };
  const wrap = h('div', { class: 'tpl-wrap' });
  const grid = h('div', { class: 'tpl-grid' });
  let imgBtn = null, imgLabel = null;
  const items = TEMPLATES.map((t) => {
    const cv = h('canvas', { class: 'tpl-cv' });
    const label = h('span', { class: 'tpl-label' });
    const b = h('button', { class: 'tpl', type: 'button' }, h('span', { class: 'tpl-paper' }, cv), label);
    b.addEventListener('click', () => {
      state.template = t.id;
      sync();
      onChange && onChange();
    });
    grid.append(b);
    return { t, b, cv, label };
  });
  function drawOne({ t, cv }) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = 64, H = 86;
    if (cv.width !== W * dpr) {
      cv.width = W * dpr;
      cv.height = H * dpr;
      cv.style.width = W + 'px';
      cv.style.height = H + 'px';
    }
    const ctx = cv.getContext('2d');
    // ページ左上の一部を拡大して見せる（細かい罫線でも分かるように）
    const s = (W * dpr) / 300;
    ctx.setTransform(s, 0, 0, s, -20 * s, -40 * s);
    ctx.fillStyle = state.paper;
    ctx.fillRect(0, 0, 794, 1123);
    drawTemplate(ctx, { w: 794, h: 1123, template: t.id, paper: state.paper, sp: spOf(t.id) }, s);
  }
  function draw() {
    for (const it of items) drawOne(it);
  }
  if (opts.onImage) {
    imgLabel = h('span', { class: 'tpl-label', text: '画像から' });
    imgBtn = h('button', { class: 'tpl tpl-img', type: 'button' }, h('span', { class: 'tpl-paper img', html: icon('img-page') }), imgLabel);
    imgBtn.addEventListener('click', () => opts.onImage());
    grid.append(imgBtn);
  }

  // ---- 間隔（mm）
  const val = h('b', { class: 'sp-val' });
  const range = h('input', { type: 'range', class: 'range', min: SP_MIN, max: SP_MAX, step: 0.5, 'aria-label': '間隔' });
  const minus = h('button', { class: 'sp-step', type: 'button', 'aria-label': '狭く', text: '−' });
  const plus = h('button', { class: 'sp-step', type: 'button', 'aria-label': '広く', text: '+' });
  const chips = h('div', { class: 'sp-chips' });
  const chipBtns = SP_PRESETS.map((v) => {
    const b = h('button', { class: 'chip sp-chip', type: 'button', text: v + 'mm' });
    b.addEventListener('click', () => setSp(v));
    chips.append(b);
    return { v, b };
  });
  const spRow = h(
    'div',
    { class: 'tpl-sp' },
    h('div', { class: 'sp-head' }, h('span', { class: 'sp-title', text: '間隔' }), val),
    h('div', { class: 'sp-ctl' }, minus, range, plus),
    chips
  );
  function setSp(v) {
    const id = state.template;
    if (!TPL_SP[id]) return;
    v = Math.min(SP_MAX, Math.max(SP_MIN, Math.round(v * 2) / 2));
    state.sp[id] = v;
    const it = items.find((x) => x.t.id === id);
    if (it) drawOne(it);
    sync();
    onChange && onChange('sp');
  }
  range.addEventListener('input', () => setSp(parseFloat(range.value)));
  minus.addEventListener('click', () => setSp(spOf(state.template) - 0.5));
  plus.addEventListener('click', () => setSp(spOf(state.template) + 0.5));

  function sync() {
    for (const { t, b, label } of items) {
      b.classList.toggle('on', t.id === state.template);
      label.textContent = TPL_SP[t.id] ? `${t.label} ${fmtMM(spOf(t.id))}mm` : t.label;
    }
    if (imgBtn) {
      imgBtn.classList.toggle('on', state.template === 'image');
      const n = state.images ? state.images.length : 0;
      imgLabel.textContent = n ? `画像 ${n}枚` : '画像から';
    }
    const has = !!TPL_SP[state.template];
    spRow.hidden = !has;
    if (has) {
      const v = spOf(state.template);
      val.textContent = fmtMM(v) + ' mm';
      range.value = v;
      range.style.setProperty('--p', ((v - SP_MIN) / (SP_MAX - SP_MIN)) * 100 + '%');
      minus.disabled = v <= SP_MIN;
      plus.disabled = v >= SP_MAX;
      for (const { v: cv, b } of chipBtns) b.classList.toggle('on', Math.abs(cv - v) < 1e-6);
    }
  }
  wrap.append(grid, spRow);
  draw();
  sync();
  wrap.redraw = draw;
  wrap.sync = sync;
  return wrap;
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
