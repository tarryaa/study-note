// UI 部品：ポップオーバー / メニュー / シート / ダイアログ / トースト / 各種コントロール
import { h, clamp, esc } from './util.js';
import { icon } from './icons.js';

const root = () => document.getElementById('overlay-root');
const layers = []; // 開いているポップ・シート（Esc で上から閉じる）

export function closeTop() {
  const f = layers[layers.length - 1];
  if (f) {
    f();
    return true;
  }
  return false;
}
export function closeAllPops() {
  for (const f of layers.slice().reverse()) if (f.isPop) f();
}
export const hasLayers = () => layers.length > 0;

// 長押し・ドラッグの共通処理（スクロール中は反応しない）
export const dragState = { active: false };
export function pressable(el, o) {
  let st = null;
  const longMs = o.longMs || 420;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (o.ignore && o.ignore(e)) return;
    st = { id: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType, long: false, drag: false };
    el.classList.add('pressing');
    if (e.pointerType !== 'mouse') {
      st.timer = setTimeout(() => {
        if (!st) return;
        st.long = true;
        dragState.active = true;
        try { el.setPointerCapture(st.id); } catch (_) {}
        el.classList.add('long');
        o.onLongStart && o.onLongStart(st);
      }, longMs);
    }
  });
  el.addEventListener('pointermove', (e) => {
    if (!st || e.pointerId !== st.id) return;
    const d = Math.hypot(e.clientX - st.x, e.clientY - st.y);
    if (!st.long) {
      if (st.type === 'mouse') {
        if (d > 6 && o.onDragStart) {
          st.long = true;
          st.drag = true;
          dragState.active = true;
          try { el.setPointerCapture(st.id); } catch (_) {}
          el.classList.remove('pressing');
          o.onDragStart(st, e);
        }
      } else if (d > 10) {
        clearTimeout(st.timer);
        el.classList.remove('pressing');
        st = null;
      }
      return;
    }
    if (!st.drag) {
      if (d > 6 && o.onDragStart) {
        st.drag = true;
        el.classList.remove('pressing', 'long');
        o.onDragStart(st, e);
      }
      return;
    }
    o.onDragMove && o.onDragMove(e, st);
  });
  const end = (e, cancel) => {
    if (!st || e.pointerId !== st.id) return;
    clearTimeout(st.timer);
    const s = st;
    st = null;
    el.classList.remove('pressing', 'long');
    dragState.active = false;
    if (s.drag) return o.onDragEnd && o.onDragEnd(e, s, cancel);
    if (cancel) return;
    if (s.long) return o.onLong && o.onLong(e, s);
    o.onTap && o.onTap(e, s);
  };
  el.addEventListener('pointerup', (e) => end(e, false));
  el.addEventListener('pointercancel', (e) => end(e, true));
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (st && st.type !== 'mouse') return;
    if (st) {
      clearTimeout(st.timer);
      el.classList.remove('pressing');
      st = null;
    }
    o.onLong && o.onLong(e, { x: e.clientX, y: e.clientY });
  });
}

export function anchorRect(a) {
  if (!a) return { x: innerWidth / 2, y: innerHeight / 2, w: 0, h: 0 };
  if (a.getBoundingClientRect) {
    const r = a.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  return { x: a.x, y: a.y, w: a.w || 0, h: a.h || 0 };
}

export function popover(anchor, content, opts = {}) {
  if (!opts.stack) closeAllPops();
  const backdrop = h('div', { class: 'pop-backdrop' });
  const el = h('div', { class: 'pop ' + (opts.className || '') }, content);
  root().append(backdrop, el);
  const place = () => {
    const r = anchorRect(anchor);
    const vw = innerWidth, vh = innerHeight, m = 10;
    const pw = el.offsetWidth, ph = el.offsetHeight;
    let left, top, ox, oy;
    const side = opts.placement === 'side' || (opts.placement === 'auto-side' && (r.x < 120 || r.x + r.w > vw - 120));
    if (side) {
      const right = r.x + r.w + 10;
      left = right + pw <= vw - m ? right : r.x - pw - 10;
      top = clamp(r.y + r.h / 2 - ph / 2, m, Math.max(m, vh - ph - m));
      ox = left > r.x ? '0' : '100%';
      oy = `${clamp(r.y + r.h / 2 - top, 0, ph)}px`;
    } else {
      const below = vh - (r.y + r.h), above = r.y;
      if (opts.placement === 'above' ? above < ph + m && below > above : below >= ph + m || below >= above) {
        top = r.y + r.h + 8;
        oy = '0';
      } else {
        top = r.y - ph - 8;
        oy = '100%';
      }
      top = clamp(top, m, Math.max(m, vh - ph - m));
      left = clamp(r.x + r.w / 2 - pw / 2, m, Math.max(m, vw - pw - m));
      ox = `${clamp(r.x + r.w / 2 - left, 0, pw)}px`;
    }
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.transformOrigin = `${ox} ${oy}`;
  };
  place();
  requestAnimationFrame(() => el.classList.add('in'));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    const i = layers.indexOf(close);
    if (i >= 0) layers.splice(i, 1);
    el.classList.remove('in');
    el.classList.add('out');
    backdrop.remove();
    setTimeout(() => el.remove(), 220);
    opts.onClose && opts.onClose();
  };
  close.isPop = true;
  backdrop.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    close();
  });
  layers.push(close);
  return { el, close, place };
}

export function menu(anchor, items, opts = {}) {
  const list = h('div', { class: 'menu' });
  let pop = null;
  for (const it of items) {
    if (!it) continue;
    if (it === '-') {
      list.append(h('div', { class: 'menu-sep' }));
      continue;
    }
    if (it.header) {
      list.append(h('div', { class: 'menu-header', text: it.header }));
      continue;
    }
    if (it.el) {
      list.append(it.el);
      continue;
    }
    const lead = it.icon ? icon(it.icon) : it.swatch ? `<i class="mi-sw" style="background:${esc(it.swatch)}"></i>` : '';
    const b = h(
      'button',
      { class: 'menu-item' + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : '') },
      h('span', { class: 'mi-ic', html: lead }),
      h('span', { class: 'mi-label', text: it.label }),
      it.hint ? h('span', { class: 'mi-hint', text: it.hint }) : null,
      it.checked ? h('span', { class: 'mi-check', html: icon('check') }) : null
    );
    if (it.disabled) b.disabled = true;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!it.keepOpen) pop.close();
      if (it.action) it.action(b);
    });
    list.append(b);
  }
  pop = popover(anchor, list, { ...opts, className: 'menu-pop ' + (opts.className || '') });
  return pop;
}

export function sheet({ title, body, foot, className = '', onClose, dismissable = true, head }) {
  const scrim = h('div', { class: 'scrim' });
  const xBtn = h('button', { class: 'ib sheet-x', html: icon('x'), 'aria-label': '閉じる' });
  const panel = h(
    'div',
    { class: 'sheet ' + className, role: 'dialog' },
    h('div', { class: 'sheet-head' }, head || h('h2', { text: title || '' }), xBtn),
    h('div', { class: 'sheet-body' }, body),
    foot ? h('div', { class: 'sheet-foot' }, foot) : null
  );
  root().append(scrim, panel);
  requestAnimationFrame(() => {
    scrim.classList.add('in');
    panel.classList.add('in');
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    const i = layers.indexOf(close);
    if (i >= 0) layers.splice(i, 1);
    scrim.classList.remove('in');
    panel.classList.remove('in');
    panel.classList.add('out');
    setTimeout(() => {
      scrim.remove();
      panel.remove();
    }, 300);
    onClose && onClose();
  };
  if (dismissable) scrim.addEventListener('click', close);
  xBtn.addEventListener('click', close);
  layers.push(close);
  return { close, panel };
}

export function confirmDialog({ title, message, ok = 'OK', cancel = 'キャンセル', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const okBtn = h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), text: ok });
    const cancelBtn = h('button', { class: 'btn', text: cancel });
    const s = sheet({
      title,
      body: message ? h('p', { class: 'dialog-msg', text: message }) : null,
      foot: [cancelBtn, okBtn],
      className: 'dialog',
      onClose: () => {
        if (!done) {
          done = true;
          resolve(false);
        }
      },
    });
    okBtn.addEventListener('click', () => {
      done = true;
      resolve(true);
      s.close();
    });
    cancelBtn.addEventListener('click', () => s.close());
  });
}

export function promptDialog({ title, value = '', placeholder = '', ok = 'OK', message }) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { class: 'input', type: 'text', placeholder, enterkeyhint: 'done', autocomplete: 'off' });
    input.value = value;
    const okBtn = h('button', { class: 'btn primary', text: ok });
    const cancelBtn = h('button', { class: 'btn', text: 'キャンセル' });
    const s = sheet({
      title,
      body: h('div', { class: 'dialog-form' }, message ? h('p', { class: 'dialog-msg', text: message }) : null, input),
      foot: [cancelBtn, okBtn],
      className: 'dialog',
      onClose: () => {
        if (!done) {
          done = true;
          resolve(null);
        }
      },
    });
    const submit = () => {
      if (done) return;
      done = true;
      resolve(input.value.trim());
      s.close();
    };
    okBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        submit();
      }
    });
    cancelBtn.addEventListener('click', () => s.close());
    input.focus();
    input.select();
  });
}

let toastWrap = null;
export function toast(msg, { action, onAction, duration = 2600, icon: ic } = {}) {
  if (!toastWrap) {
    toastWrap = h('div', { class: 'toasts' });
    document.body.append(toastWrap);
  }
  while (toastWrap.children.length > 2) toastWrap.firstChild.remove();
  const t = h('div', { class: 'toast' }, ic ? h('span', { class: 't-ic', html: icon(ic) }) : null, h('span', { class: 't-msg', text: msg }));
  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    t.classList.remove('in');
    t.classList.add('out');
    setTimeout(() => t.remove(), 320);
  };
  if (action) {
    const b = h('button', { class: 't-act', text: action });
    b.addEventListener('click', () => {
      dismiss();
      onAction && onAction();
    });
    t.append(b);
  }
  toastWrap.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  timer = setTimeout(dismiss, duration);
  return dismiss;
}

let hudEl = null, hudT = 0;
export function hud(text, ic) {
  if (!hudEl) {
    hudEl = h('div', { class: 'hud' });
    document.body.append(hudEl);
  }
  hudEl.innerHTML = (ic ? icon(ic) : '') + `<span>${esc(text)}</span>`;
  hudEl.classList.remove('show');
  void hudEl.offsetWidth;
  hudEl.classList.add('show');
  clearTimeout(hudT);
  hudT = setTimeout(() => hudEl.classList.remove('show'), 950);
}

// ---------- コントロール ----------
export function segmented(options, value, onChange) {
  const el = h('div', { class: 'seg' });
  el.style.setProperty('--n', options.length);
  const pill = h('span', { class: 'seg-pill' });
  el.append(pill);
  const btns = options.map((o) => {
    const b = h('button', { class: 'seg-btn', html: (o.icon ? icon(o.icon) : '') + `<span>${esc(o.label)}</span>` });
    b.addEventListener('click', () => {
      set(o.value);
      onChange(o.value);
    });
    el.append(b);
    return b;
  });
  function set(v) {
    value = v;
    const i = Math.max(0, options.findIndex((o) => o.value === v));
    btns.forEach((b, j) => b.classList.toggle('on', j === i));
    pill.style.transform = `translateX(${i * 100}%)`;
  }
  set(value);
  el.set = set;
  return el;
}

export function toggle(value, onChange) {
  const el = h('button', { class: 'switch' + (value ? ' on' : ''), role: 'switch', 'aria-checked': String(!!value) }, h('i'));
  el.addEventListener('click', () => {
    value = !value;
    el.classList.toggle('on', value);
    el.setAttribute('aria-checked', String(value));
    onChange(value);
  });
  return el;
}

export function slider({ min, max, step = 1, value, onInput, format = (v) => v }) {
  const out = h('span', { class: 'slider-val', text: format(value) });
  const input = h('input', { type: 'range', class: 'range', min, max, step });
  input.value = value;
  const fill = () => input.style.setProperty('--p', ((input.value - min) / (max - min)) * 100 + '%');
  fill();
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    out.textContent = format(v);
    fill();
    onInput(v);
  });
  return h('div', { class: 'slider' }, input, out);
}

export function row(label, control, hint) {
  return h(
    'div',
    { class: 'set-row' },
    h('div', { class: 'set-label' }, h('span', { text: label }), hint ? h('small', { text: hint }) : null),
    h('div', { class: 'set-ctl' }, control)
  );
}

export function section(title, ...rows) {
  return h('section', { class: 'set-sec' }, title ? h('h3', { text: title }) : null, h('div', { class: 'set-card' }, ...rows));
}

export const PEN_PALETTE = [
  '#1d1d1f', '#48484a', '#8e8e93', '#c7c7cc', '#ffffff',
  '#0b3d91', '#1f5fd1', '#3b8cf0', '#5ac8fa', '#9fd2ff',
  '#a3201b', '#e5484d', '#ff7a6b', '#ec5a9a', '#ffadc8',
  '#0d6b3d', '#1f8a4c', '#34c759', '#7bd389', '#b6ebb3',
  '#b9420c', '#f07a2a', '#f5b42a', '#ffd60a', '#fff0a3',
  '#4c1d95', '#7c4dff', '#b388ff', '#8d6e63', '#c9a27e',
];
export const HL_PALETTE = [
  '#ffd60a', '#ffe680', '#ffb340', '#ff9e7a', '#ff9ec7',
  '#f7a8ff', '#c9a7ff', '#8cc8ff', '#7fe0e0', '#7ee0a1',
  '#c4f08c', '#e0e0e0',
];

export function colorGrid(colors, value, onPick, { custom = true } = {}) {
  const grid = h('div', { class: 'color-grid' });
  const norm = (c) => String(c || '').toLowerCase();
  const mark = (el) => {
    for (const x of grid.querySelectorAll('.cg-sw')) x.classList.toggle('on', x === el);
  };
  for (const c of colors) {
    const b = h('button', { class: 'cg-sw' + (norm(c) === norm(value) ? ' on' : ''), 'aria-label': c });
    b.style.setProperty('--c', c);
    b.addEventListener('click', () => {
      mark(b);
      onPick(c, false);
    });
    grid.append(b);
  }
  if (custom) {
    const lab = h('label', { class: 'cg-sw cg-custom', title: 'カスタム', html: icon('plus') });
    const inp = h('input', { type: 'color' });
    inp.value = /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#333333';
    inp.addEventListener('input', () => {
      lab.style.setProperty('--c', inp.value);
      mark(lab);
      onPick(inp.value, true);
    });
    lab.append(inp);
    grid.append(lab);
  }
  return grid;
}
