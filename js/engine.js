// キャンバスエンジン：表示・入力・ツール・取り消し
//
// 低遅延のための設計:
//  - 書いている線は画面サイズの専用キャンバス(ink)に、pointermove の中で即座に描く
//  - getCoalescedEvents で 240Hz の Apple Pencil 入力を全部拾う
//  - 予測描画（getPredictedEvents / 自前の速度外挿）で体感遅延を減らす
//  - ページは CSS transform でパン・ズーム（再描画なし）
//
// 画質のための設計:
//  - ページごとの「土台キャンバス」（ズームアウト時はズームに合わせて軽量化）
//  - 拡大時は画面に見えている部分だけを 512px のタイルに分けて、表示倍率ちょうどの解像度で描く
//    （パンで新しく見えた部分も、その場ですぐ高精細タイルを描き足す）
import { h, clamp, uid, isDarkColor, reducedMotion } from './util.js';
import { icon } from './icons.js';
import { settings, saveSettings } from './settings.js';
import {
  LiveStroke, buildInkPath, buildLinePath, computeBB, hitStrokeCircle, hitStrokeSegment,
  splitStroke, itemPath, setItemPath, PEN_TYPES, pointInPoly, convexHull, insideFraction, cutStrokeByPoly,
} from './ink.js';
import { detectScribble } from './scribble.js';
import { recognizeShape, snapLineEnd, shapeGeometry } from './shapes.js';
import { renderPageTo, renderRegion, drawItem, itemBounds, hitBox, textHeight, LINE_H } from './render.js';
import { newPageData, cloneItem } from './store.js';

const GAP = 72; // ページ同士の間隔（横並び）
export const MAX_Z = 10;
const BASE_PX = 4.5e6; // 土台キャンバス 1 枚の最大ピクセル数
const MEM_PX = 22e6; // 土台キャンバス全体の上限
const TILE = 512; // 高精細タイルの大きさ（デバイスピクセル）
const MAX_TILES = 110;
const SEL_PX = 10e6;
const EDGE = 18; // 拡大時にページの端を寄せる位置（px）
const HOLD_MS = 420; // 図形補正までの長押し時間
const PULL = 120; // 最後のページで横に引っ張ってページを追加するまでの距離
const now = () => performance.now();

export const clipboard = { items: null, bb: null, assets: new Map() };

function coalesced(e) {
  let evs = null;
  try { evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null; } catch (_) {}
  return evs && evs.length ? evs : [e];
}
export function unionBB(items) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const it of items) {
    const q = it.bb;
    if (!q) continue;
    if (q[0] < b[0]) b[0] = q[0];
    if (q[1] < b[1]) b[1] = q[1];
    if (q[2] > b[2]) b[2] = q[2];
    if (q[3] > b[3]) b[3] = q[3];
  }
  return b;
}
const overlap = (a, b) => !(a.x > b.x + b.w || a.x + a.w < b.x || a.y > b.y + b.h || a.y + a.h < b.y);
const rubberDist = (x, d) => (1 - 1 / ((x * 0.55) / d + 1)) * d;
function rubber(v, min, max, dim) {
  if (v < min) return min - rubberDist(min - v, dim);
  if (v > max) return max + rubberDist(v - max, dim);
  return v;
}
function softZoom(z, minZ) {
  if (z > MAX_Z) return MAX_Z * Math.pow(z / MAX_Z, 0.3);
  if (z < minZ) return minZ * Math.pow(z / minZ, 0.35);
  return z;
}
function polyPath(pts) {
  const P = new Path2D();
  for (let i = 0; i < pts.length; i += 3) P[i ? 'lineTo' : 'moveTo'](pts[i], pts[i + 1]);
  P.closePath();
  return P;
}

export function transformItem(it, cx, cy, m) {
  const cos = Math.cos(m.r), sin = Math.sin(m.r), s = m.s;
  const fx = (x, y) => cx + m.tx + (x - cx) * s * cos - (y - cy) * s * sin;
  const fy = (x, y) => cy + m.ty + (x - cx) * s * sin + (y - cy) * s * cos;
  if (it.t === 's') {
    const src = it.pts, p = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      p[i] = fx(src[i], src[i + 1]);
      p[i + 1] = fy(src[i], src[i + 1]);
      p[i + 2] = src[i + 2] * s;
    }
    return { ...it, pts: p, w: it.w * s, bb: computeBB(p) };
  }
  const o = { ...it, cx: fx(it.cx, it.cy), cy: fy(it.cx, it.cy), w: it.w * s, h: it.h * s, r: (it.r || 0) + m.r };
  if (it.t === 'x') o.fs = it.fs * s;
  o.bb = itemBounds(o);
  return o;
}
export const translateItem = (it, dx, dy) => transformItem(it, 0, 0, { tx: dx, ty: dy, s: 1, r: 0 });

export class Engine {
  constructor(stage, hooks = {}) {
    this.stage = stage;
    this.hooks = hooks;
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.world = h('div', { class: 'world' });
    this.ghost = h('button', {
      class: 'page-ghost',
      'data-ui': '',
      html: `<span class="pg-in"><span class="pg-ic">${icon('plus')}</span><b>新しいページ</b><small>タップ／横にスワイプ</small></span>`,
    });
    this.ghost.addEventListener('click', () => this.hooks.onAddPageEnd && this.hooks.onAddPageEnd());
    this.world.append(this.ghost);
    this.frozenCv = h('canvas', { class: 'ink-layer' });
    this.inkCv = h('canvas', { class: 'ink-layer' });
    this.inkWrap = h('div', { class: 'ink-wrap' }, this.frozenCv, this.inkCv);
    this.fxCv = h('canvas', { class: 'fx-layer' });
    this.selUi = h('div', { class: 'sel-ui' });
    this.cursor = h('div', { class: 'pen-cursor' });
    stage.append(this.world, this.inkWrap, this.fxCv, this.selUi, this.cursor);
    this.frozenCtx = this.frozenCv.getContext('2d');
    this.inkCtx = this.inkCv.getContext('2d');
    this.fxCtx = this.fxCv.getContext('2d');

    this.view = { tx: 0, ty: 0, z: 1 };
    this.insets = { top: 0, bottom: 0, left: 0, right: 0, tool: 58 };
    this.sw = 0;
    this.sh = 0;
    this.rect = { left: 0, top: 0 };
    this.pvs = [];
    this.pvMap = new Map();
    this.tiles = new Map();
    this.tool = 'pen';
    this.accent = '#5b6cf0';
    this.undoStack = [];
    this.redoStack = [];
    this.touches = new Map();
    this.tg = null;
    this.tapSess = null;
    this.lastTap = null;
    this.action = null;
    this.sel = null;
    this.textEdit = null;
    this.edits = null;
    this.assets = new Map();
    this.anim = 0;
    this.fxAnim = 0;
    this._rq = 0;
    this._settleT = 0;
    this._lvl = 0;
    this._lvlT = 0;
    this.lastViewChange = 0;
    this.inkDirty = null;
    this.frozenDirty = null;
    this.fxDirty = null;
    this.pull = 0;
    this.pullArmed = false;
    this.realPressure = false;
    this.loaded = false;
    this.viewInit = false;
    this.note = null;
    this.bind();
    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(stage);
  }

  // ---------------------------------------------------------------- 基本
  bind() {
    const st = this.stage;
    st.addEventListener('pointerdown', (e) => this.onDown(e));
    st.addEventListener('pointermove', (e) => this.onMove(e));
    st.addEventListener('pointerup', (e) => this.onUp(e, false));
    st.addEventListener('pointercancel', (e) => this.onUp(e, true));
    st.addEventListener('lostpointercapture', (e) => {
      const a = this.action;
      if (a && a.pointerId === e.pointerId && e.pointerType !== 'touch') this.onUp(e, false);
    });
    st.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'touch' && !this.action) this.hideCursor();
    });
    const pd = (e) => {
      if (!this.isUi(e.target)) e.preventDefault();
    };
    st.addEventListener('touchstart', pd, { passive: false });
    st.addEventListener('touchmove', pd, { passive: false });
    st.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    st.addEventListener('contextmenu', (e) => {
      if (!this.isUi(e.target)) e.preventDefault();
    });
    st.addEventListener('dblclick', (e) => e.preventDefault());
  }
  isUi(t) {
    return !!(t && t.closest && t.closest('button, input, textarea, select, [data-ui]'));
  }

  onResize() {
    const r = this.stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const changed = Math.abs(r.width - this.sw) > 1 || Math.abs(r.height - this.sh) > 1;
    const state = this.loaded && this.viewInit && this.sw && changed ? this.getViewState() : null;
    this.rect = r;
    this.sw = r.width;
    this.sh = r.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    const W = Math.round(this.sw * this.dpr), H = Math.round(this.sh * this.dpr);
    for (const cv of [this.inkCv, this.frozenCv, this.fxCv]) {
      if (cv.width !== W || cv.height !== H) {
        cv.width = W;
        cv.height = H;
      }
      cv.style.width = this.sw + 'px';
      cv.style.height = this.sh + 'px';
    }
    this.inkDirty = null;
    this.frozenDirty = null;
    this.fxDirty = null;
    if (!this.loaded) return;
    if (!this.viewInit) return this.initView();
    if (state) this.applyViewState(state, true);
    else this.onViewChanged();
  }

  setInsets(ins) {
    const state = this.loaded && this.viewInit && this.sw ? this.getViewState() : null;
    this.insets = { ...this.insets, ...ins };
    if (state) this.applyViewState(state, false);
  }

  // ---------------------------------------------------------------- 表示領域・余白・ズーム範囲
  area() {
    const i = this.insets;
    const l = i.left, t = i.top, r = this.sw - i.right, b = this.sh - i.bottom;
    return { l, t, r, b, w: Math.max(60, r - l), h: Math.max(60, b - t) };
  }
  margins() {
    const D = this.insets.tool || 58;
    return { t: D * settings.zoomMargin, s: D * settings.zoomMargin, b: D * settings.zoomMarginBottom };
  }
  // いちばん縮小したとき：ページ全体が見えて、まわりに余白が残る倍率
  minZoomFor(pv) {
    const A = this.area(), m = this.margins();
    const zw = (A.w - 2 * m.s) / pv.page.w, zh = (A.h - m.t - m.b) / pv.page.h;
    return clamp(Math.min(zw, zh), 0.05, MAX_Z);
  }
  fitWidthZoom(pv) {
    const A = this.area();
    return clamp((A.w - (this.sw < 700 ? 16 : 48)) / pv.page.w, this.minZoomFor(pv), MAX_Z);
  }
  fitZoom() {
    const pv = this.pvs[this.focusIndex()];
    return pv ? this.fitWidthZoom(pv) : 1;
  }
  // ページを基準にした移動範囲（ページが画面に収まるなら中央に置く）
  pageBounds(pv, z) {
    const A = this.area(), m = this.margins();
    const W = pv.page.w * z, H = pv.page.h * z;
    let minTx, maxTx, minTy, maxTy;
    if (W <= A.w - 2 * EDGE) minTx = maxTx = A.l + (A.w - W) / 2 - pv.x * z;
    else {
      maxTx = A.l + EDGE - pv.x * z;
      minTx = A.r - EDGE - (pv.x + pv.page.w) * z;
    }
    if (H <= A.h - 2 * EDGE) {
      const free = A.h - H;
      const ratio = m.t + m.b > 0 ? m.t / (m.t + m.b) : 0.5;
      minTy = maxTy = A.t + free * ratio - pv.y * z;
    } else {
      maxTy = A.t + EDGE - pv.y * z;
      minTy = A.b - EDGE - (pv.y + pv.page.h) * z;
    }
    return { minTx, maxTx, minTy, maxTy };
  }
  // ドラッグ中の範囲：横は最初〜最後のページ、縦は今のページ
  dragBounds(z) {
    const n = this.pvs.length;
    if (!n) return { minTx: 0, maxTx: 0, minTy: 0, maxTy: 0 };
    const bF = this.pageBounds(this.pvs[0], z), bL = this.pageBounds(this.pvs[n - 1], z);
    const b = this.pageBounds(this.pvs[this.focusIndex()], z);
    return { minTx: bL.minTx, maxTx: bF.maxTx, minTy: b.minTy, maxTy: b.maxTy };
  }
  focusIndex() {
    const n = this.pvs.length;
    if (!n) return 0;
    const { tx, ty, z } = this.view;
    const A = this.area();
    const cx = (A.l + A.r) / 2;
    let best = 0, bov = -1, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const pv = this.pvs[i];
      const x0 = pv.x * z + tx, x1 = x0 + pv.page.w * z, y0 = pv.y * z + ty, y1 = y0 + pv.page.h * z;
      const ov = Math.max(0, Math.min(x1, A.r) - Math.max(x0, A.l)) * Math.max(0, Math.min(y1, A.b) - Math.max(y0, A.t));
      const d = Math.abs((x0 + x1) / 2 - cx);
      if (ov > bov + 0.5 || (Math.abs(ov - bov) <= 0.5 && d < bd)) {
        best = i;
        bov = ov;
        bd = d;
      }
    }
    return best;
  }
  currentIndex() {
    return this.focusIndex();
  }

  // ---------------------------------------------------------------- 読み込み
  load(note, pages) {
    this.unload();
    this.note = note;
    for (const p of pages) this.pvs.push(this.createPV(p));
    this.loaded = true;
    this.viewInit = false;
    this.layout();
    if (this.sw) this.initView();
    this.hooks.onHistory && this.hooks.onHistory();
  }
  createPV(page) {
    const el = h('div', { class: 'page' });
    const cv = h('canvas', { class: 'page-cv' });
    const num = h('div', { class: 'page-num' });
    el.append(cv, num);
    const pv = { page, el, cv, ctx: null, scale: 0, sx: 1, sy: 1, dirty: true, hidden: null, x: 0, y: 0, num };
    this.pvMap.set(page, pv);
    this.world.insertBefore(el, this.ghost);
    return pv;
  }
  unload() {
    if (this.action) this.cancelAction();
    this.commitText();
    this.clearSelection();
    for (const [k, t] of this.tiles) this.removeTile(k, t);
    for (const pv of this.pvs) {
      pv.cv.width = 0;
      pv.cv.height = 0;
      pv.el.remove();
    }
    this.pvs = [];
    this.pvMap = new Map();
    this.undoStack = [];
    this.redoStack = [];
    this.clearInk();
    this.clearFx();
    cancelAnimationFrame(this.fxAnim);
    this.stopAnim();
    this.touches.clear();
    this.tg = null;
    this.tapSess = null;
    this.setPull(0);
    this.loaded = false;
    this.note = null;
  }
  pages() {
    return this.pvs.map((pv) => pv.page);
  }

  initView() {
    this.viewInit = true;
    const v = this.note && this.note.view;
    if (v && v.page != null && this.pvs[v.page] && isFinite(v.z) && isFinite(v.cx) && isFinite(v.cy)) this.applyViewState(v, true);
    else this.goToPage(0, { anim: false, fit: true });
  }
  getViewState() {
    const i = this.focusIndex();
    const pv = this.pvs[i];
    if (!pv) return null;
    const { tx, ty, z } = this.view;
    const A = this.area();
    return {
      page: i,
      z,
      cx: ((A.l + A.r) / 2 - tx) / z - pv.x,
      cy: ((A.t + A.b) / 2 - ty) / z - pv.y,
      fit: Math.abs(z - this.fitWidthZoom(pv)) / z < 0.02,
      min: Math.abs(z - this.minZoomFor(pv)) / z < 0.02,
    };
  }
  viewFromState(v) {
    const pv = this.pvs[v.page] || this.pvs[0];
    if (!pv) return null;
    const z = v.min ? this.minZoomFor(pv) : v.fit ? this.fitWidthZoom(pv) : clamp(v.z, this.minZoomFor(pv), MAX_Z);
    const A = this.area();
    const b = this.pageBounds(pv, z);
    return {
      tx: clamp((A.l + A.r) / 2 - (pv.x + v.cx) * z, b.minTx, b.maxTx),
      ty: clamp((A.t + A.b) / 2 - (pv.y + v.cy) * z, b.minTy, b.maxTy),
      z,
    };
  }
  applyViewState(v, instant) {
    const t = this.viewFromState(v);
    if (!t) return;
    if (instant) this.setView(t.tx, t.ty, t.z);
    else this.animateView(t, 320);
  }

  layout() {
    let x = 0;
    this.pvs.forEach((pv, i) => {
      const { w, h: ph } = pv.page;
      pv.x = x;
      pv.y = -ph / 2;
      const s = pv.el.style;
      s.left = pv.x + 'px';
      s.top = pv.y + 'px';
      s.width = w + 'px';
      s.height = ph + 'px';
      s.background = pv.page.paper;
      pv.num.textContent = String(i + 1);
      x += w + GAP;
    });
    const last = this.pvs[this.pvs.length - 1];
    if (last) {
      const g = this.ghost.style;
      g.left = last.x + last.page.w + GAP + 'px';
      g.top = last.y + 'px';
      g.width = last.page.w + 'px';
      g.height = last.page.h + 'px';
    }
  }

  // ---------------------------------------------------------------- 表示（パン・ズーム）
  setView(tx, ty, z) {
    const v = this.view;
    v.tx = tx;
    v.ty = ty;
    v.z = z;
    this.world.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${z})`;
    this.lastViewChange = now();
    this.onViewChanged();
  }
  onViewChanged() {
    this.updateVisibility();
    this.requestRender();
    if (this.sel) this.updateSelUi();
    if (this.textEdit) this.positionText();
    if (this.hooks.onView) this.hooks.onView(this.view);
    clearTimeout(this._settleT);
    this._settleT = setTimeout(() => this.settle(), 140);
  }
  isSettled() {
    return !this.tg && !this.anim && now() - this.lastViewChange > 100;
  }
  settle() {
    if (!this.loaded) return;
    if (this.tg || this.anim) {
      clearTimeout(this._settleT);
      this._settleT = setTimeout(() => this.settle(), 140);
      return;
    }
    this.requestRender();
    if (this.sel && Math.abs(this.sel.k - this.view.z * this.dpr) / this.sel.k > 0.3) this.renderSelCanvas();
    if (this.hooks.onSettle) this.hooks.onSettle();
  }
  stopAnim() {
    if (this.anim) {
      cancelAnimationFrame(this.anim);
      this.anim = 0;
    }
  }
  animateView(to, dur = 320) {
    this.stopAnim();
    const from = { ...this.view };
    const t0 = now();
    if (reducedMotion()) dur = 1;
    const step = () => {
      const t = Math.min(1, (now() - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      this.anim = t < 1 ? requestAnimationFrame(step) : 0;
      this.setView(from.tx + (to.tx - from.tx) * e, from.ty + (to.ty - from.ty) * e, from.z * Math.pow(to.z / from.z, e));
    };
    this.anim = requestAnimationFrame(step);
  }
  // ページから外れすぎていたら、ページが見える位置へ素早く戻す（横に強くはじくとページ送り）
  settleView(opts = {}) {
    if (!this.loaded || !this.pvs.length) return;
    const { tx, ty, z } = this.view;
    const A = this.area();
    let i = this.focusIndex();
    if (opts.vx && Math.abs(opts.vx) > 0.3) {
      const base = opts.from != null && this.pvs[opts.from] ? opts.from : i;
      if (this.pvs[base].page.w * z <= A.w * 1.05) i = clamp(base + (opts.vx < 0 ? 1 : -1), 0, this.pvs.length - 1);
    }
    const pv = this.pvs[i];
    const nz = clamp(z, this.minZoomFor(pv), MAX_Z);
    let ntx = tx, nty = ty;
    if (Math.abs(nz - z) > 1e-6) {
      const c = this.lastPinchC || { x: (A.l + A.r) / 2, y: (A.t + A.b) / 2 };
      const w = this.toWorld(c);
      ntx = c.x - w.x * nz;
      nty = c.y - w.y * nz;
    }
    const b = this.pageBounds(pv, nz);
    ntx = clamp(ntx, b.minTx, b.maxTx);
    nty = clamp(nty, b.minTy, b.maxTy);
    this.lastPinchC = null;
    const v = this.view;
    if (Math.abs(ntx - v.tx) > 0.5 || Math.abs(nty - v.ty) > 0.5 || Math.abs(nz - v.z) > 1e-4) {
      if (opts.instant) this.setView(ntx, nty, nz);
      else this.animateView({ tx: ntx, ty: nty, z: nz }, opts.dur || 300);
    }
  }
  snapBack() {
    this.settleView();
  }
  startInertia(vx, vy, from) {
    this.stopAnim();
    let last = now();
    const step = () => {
      const tn = now();
      const dt = Math.min(34, tn - last);
      last = tn;
      const decay = Math.pow(0.998, dt);
      vx *= decay;
      vy *= decay;
      let { tx, ty, z } = this.view;
      tx += vx * dt;
      ty += vy * dt;
      const b = this.dragBounds(z);
      const over = 60;
      if (ty > b.maxTy || ty < b.minTy) {
        vy *= Math.pow(0.5, dt / 16);
        ty = clamp(ty, b.minTy - over, b.maxTy + over);
      }
      if (tx > b.maxTx || tx < b.minTx) {
        vx *= Math.pow(0.5, dt / 16);
        tx = clamp(tx, b.minTx - over, b.maxTx + over);
      }
      if (Math.abs(vx) + Math.abs(vy) < 0.03) {
        this.anim = 0;
        this.setView(tx, ty, z);
        this.settleView({ from });
        return;
      }
      this.anim = requestAnimationFrame(step);
      this.setView(tx, ty, z);
    };
    this.anim = requestAnimationFrame(step);
  }
  zoomBy(f, center) {
    const A = this.area();
    const c = center || { x: (A.l + A.r) / 2, y: (A.t + A.b) / 2 };
    const pv = this.pvs[this.focusIndex()];
    if (!pv) return;
    const { tx, ty, z } = this.view;
    const nz = clamp(z * f, this.minZoomFor(pv), MAX_Z);
    const wx = (c.x - tx) / z, wy = (c.y - ty) / z;
    const b = this.pageBounds(pv, nz);
    this.animateView({ tx: clamp(c.x - wx * nz, b.minTx, b.maxTx), ty: clamp(c.y - wy * nz, b.minTy, b.maxTy), z: nz }, 260);
  }
  fitWidth() {
    this.goToPage(this.focusIndex(), { fit: true });
  }
  zoomOutFull() {
    const i = this.focusIndex();
    const pv = this.pvs[i];
    if (!pv) return;
    const z = this.minZoomFor(pv);
    const b = this.pageBounds(pv, z);
    this.animateView({ tx: b.maxTx, ty: b.maxTy, z }, 340);
  }
  toggleZoom(sp) {
    const w = this.toWorld(sp);
    const pv = this.pageAt(w, 0) || this.pvs[this.focusIndex()];
    if (!pv) return;
    const fit = this.fitWidthZoom(pv);
    const z = this.view.z;
    const target = z > fit * 1.3 ? fit : Math.min(MAX_Z, fit * 2.2);
    const b = this.pageBounds(pv, target);
    this.animateView({ tx: clamp(sp.x - w.x * target, b.minTx, b.maxTx), ty: clamp(sp.y - w.y * target, b.minTy, b.maxTy), z: target }, 340);
  }
  goToPage(i, { anim = true, fit = false } = {}) {
    const pv = this.pvs[i];
    if (!pv) return;
    const z = fit ? this.fitWidthZoom(pv) : clamp(this.view.z, this.minZoomFor(pv), MAX_Z);
    const b = this.pageBounds(pv, z);
    if (anim) this.animateView({ tx: b.maxTx, ty: b.maxTy, z }, 440);
    else this.setView(b.maxTx, b.maxTy, z);
  }
  scrollToPage(i, anim = true) {
    this.goToPage(i, { anim });
  }
  ensureVisible(pv, bb) {
    const { tx, ty, z } = this.view;
    const A = this.area();
    const x0 = (pv.x + bb[0]) * z + tx, y0 = (pv.y + bb[1]) * z + ty;
    const x1 = (pv.x + bb[2]) * z + tx, y1 = (pv.y + bb[3]) * z + ty;
    if (x1 > A.l && x0 < A.r && y1 > A.t && y0 < A.b) return;
    const nz = clamp(z, this.minZoomFor(pv), MAX_Z);
    const cx = pv.x + (bb[0] + bb[2]) / 2, cy = pv.y + (bb[1] + bb[3]) / 2;
    const b = this.pageBounds(pv, nz);
    this.animateView({ tx: clamp((A.l + A.r) / 2 - cx * nz, b.minTx, b.maxTx), ty: clamp((A.t + A.b) / 2 - cy * nz, b.minTy, b.maxTy), z: nz }, 380);
  }
  pageScreenRect(i) {
    const pv = this.pvs[i];
    if (!pv) return null;
    const { tx, ty, z } = this.view;
    return { x: pv.x * z + tx + this.rect.left, y: pv.y * z + ty + this.rect.top, w: pv.page.w * z, h: pv.page.h * z };
  }
  // 最後のページを横に引っ張ったときの「新しいページ」表示
  setPull(p) {
    const v = Math.max(0, p);
    if (v === this.pull) return;
    this.pull = v;
    const armed = v >= PULL;
    this.ghost.style.setProperty('--pull', String(Math.min(1, v / PULL)));
    this.ghost.classList.toggle('pulling', v > 4);
    if (armed !== this.pullArmed) {
      this.pullArmed = armed;
      this.ghost.classList.toggle('armed', armed);
    }
  }

  // ---------------------------------------------------------------- 描画
  visibleRect() {
    const { tx, ty, z } = this.view;
    return { x: -tx / z, y: -ty / z, w: this.sw / z, h: this.sh / z };
  }
  pvRect(pv) {
    return { x: pv.x, y: pv.y, w: pv.page.w, h: pv.page.h };
  }
  nearRect(f = 0.6) {
    const vr = this.visibleRect();
    const m = Math.max(vr.w, vr.h) * f;
    return { x: vr.x - m, y: vr.y - m, w: vr.w + 2 * m, h: vr.h + 2 * m };
  }
  updateVisibility() {
    if (!this.loaded) return;
    const near = this.nearRect(0.6), far = this.nearRect(1.6);
    let total = 0;
    const alive = [];
    for (const pv of this.pvs) {
      const r = this.pvRect(pv);
      if (!overlap(r, near) && pv.scale > 0 && !overlap(r, far)) this.releasePV(pv);
      if (pv.scale > 0) {
        total += pv.cv.width * pv.cv.height;
        alive.push(pv);
      }
    }
    // 土台キャンバスの総メモリを制限
    if (total > MEM_PX) {
      const vr = this.visibleRect();
      const cx = vr.x + vr.w / 2;
      alive.sort((a, b) => Math.abs(b.x + b.page.w / 2 - cx) - Math.abs(a.x + a.page.w / 2 - cx));
      for (const pv of alive) {
        if (total <= MEM_PX) break;
        if (overlap(this.pvRect(pv), near)) continue;
        total -= pv.cv.width * pv.cv.height;
        this.releasePV(pv);
      }
    }
  }
  releasePV(pv) {
    pv.cv.width = 0;
    pv.cv.height = 0;
    pv.scale = 0;
    pv.dirty = true;
    this.dropTiles(pv);
  }
  requestRender() {
    if (!this._rq) this._rq = requestAnimationFrame(() => this.renderTick());
  }
  baseCap(pv) {
    return Math.sqrt(BASE_PX / (pv.page.w * pv.page.h));
  }
  targetScale(pv) {
    const want = Math.ceil(this.view.z * this.dpr * 4) / 4;
    return Math.max(0.2, Math.min(this.baseCap(pv), want));
  }
  needsRender(pv) {
    if (pv.scale === 0 || pv.dirty) return true;
    if (!this.isSettled()) return false;
    const t = this.targetScale(pv);
    return pv.scale < t * 0.92 || pv.scale > t * 1.8;
  }
  needsTiles(pv) {
    return this.view.z * this.dpr > this.baseCap(pv) * 1.03;
  }
  renderTick() {
    this._rq = 0;
    if (!this.loaded) return;
    const t0 = now();
    const budget = this.tg ? 7 : 12;
    const near = this.nearRect(0.6);
    const vr = this.visibleRect();
    const cx = vr.x + vr.w / 2;
    const list = this.pvs.filter((pv) => overlap(this.pvRect(pv), near) && this.needsRender(pv));
    list.sort((a, b) => Math.abs(a.x + a.page.w / 2 - cx) - Math.abs(b.x + b.page.w / 2 - cx));
    for (let i = 0; i < list.length; i++) {
      if (i > 0 && now() - t0 > budget) {
        this.requestRender();
        return;
      }
      this.renderPV(list[i]);
    }
    this.updateTiles(t0, budget);
  }
  renderPV(pv) {
    const t = this.targetScale(pv);
    const W = Math.max(1, Math.round(pv.page.w * t)), H = Math.max(1, Math.round(pv.page.h * t));
    if (pv.cv.width !== W || pv.cv.height !== H) {
      pv.cv.width = W;
      pv.cv.height = H;
    }
    if (!pv.ctx) pv.ctx = pv.cv.getContext('2d');
    pv.sx = W / pv.page.w;
    pv.sy = H / pv.page.h;
    renderPageTo(pv.ctx, pv.page, pv.sx, pv.sy, { hidden: pv.hidden, assets: this.assets });
    pv.scale = t;
    pv.dirty = false;
  }
  renderAllNow() {
    const vr = this.visibleRect();
    for (const pv of this.pvs) if (overlap(this.pvRect(pv), vr) && this.needsRender(pv)) this.renderPV(pv);
    this.requestRender();
  }

  // ---- 高精細タイル
  tileLevel() {
    return Math.ceil(Math.log2(this.view.z * this.dpr) * 3 - 0.02);
  }
  updateTiles(t0, budget) {
    const lvl = this.tileLevel();
    const s = Math.pow(2, lvl / 3);
    const Tw = TILE / s;
    if (lvl !== this._lvl) {
      this._lvl = lvl;
      this._lvlT = now();
    }
    const pinching = this.tg && this.tg.mode === 'pinch';
    const allow = !pinching || now() - this._lvlT > 140;
    const vr = this.visibleRect();
    const pad = Math.max(vr.w, vr.h) * 0.15;
    const pre = { x: vr.x - pad, y: vr.y - pad, w: vr.w + 2 * pad, h: vr.h + 2 * pad };
    const cx = vr.x + vr.w / 2, cy = vr.y + vr.h / 2;
    const need = [];
    const keep = new Set();
    const tn = now();
    for (const pv of this.pvs) {
      if (!this.needsTiles(pv) || !overlap(this.pvRect(pv), pre)) continue;
      const nx = Math.ceil(pv.page.w / Tw), ny = Math.ceil(pv.page.h / Tw);
      const i0 = Math.max(0, Math.floor((pre.x - pv.x) / Tw)), i1 = Math.min(nx - 1, Math.floor((pre.x + pre.w - pv.x) / Tw));
      const j0 = Math.max(0, Math.floor((pre.y - pv.y) / Tw)), j1 = Math.min(ny - 1, Math.floor((pre.y + pre.h - pv.y) / Tw));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const key = pv.page.id + '|' + lvl + '|' + i + '|' + j;
          keep.add(key);
          const t = this.tiles.get(key);
          if (t && !t.dirty) {
            t.used = tn;
            continue;
          }
          const x = pv.x + i * Tw, y = pv.y + j * Tw;
          const vis = overlap({ x, y, w: Tw, h: Tw }, vr);
          need.push({ pv, i, j, key, d: Math.hypot(x + Tw / 2 - cx, y + Tw / 2 - cy) + (vis ? 0 : 1e7), vis });
        }
      }
    }
    need.sort((a, b) => a.d - b.d);
    let done = 0;
    if (allow) {
      for (const n of need) {
        if (done > 0 && now() - t0 > budget) break;
        this.renderTile(n.pv, n.i, n.j, lvl, s, Tw, n.key);
        done++;
      }
    }
    const pending = need.slice(done);
    if (pending.length) this.requestRender();
    // 見えている部分が新しい解像度で揃ったら、古い解像度のタイルを片付ける
    if (!pending.some((n) => n.vis)) {
      for (const [key, t] of this.tiles) {
        if (keep.has(key)) continue;
        if (t.lvl !== lvl || !this.needsTiles(t.pv)) this.removeTile(key, t);
      }
    }
    if (this.tiles.size > MAX_TILES) {
      const old = [...this.tiles].filter(([k]) => !keep.has(k)).sort((a, b) => a[1].used - b[1].used);
      while (this.tiles.size > MAX_TILES && old.length) {
        const [k, t] = old.shift();
        this.removeTile(k, t);
      }
    }
  }
  renderTile(pv, i, j, lvl, s, Tw, key) {
    let t = this.tiles.get(key);
    if (!t) {
      const x = i * Tw, y = j * Tw;
      // 隣のタイルと少し重ねて継ぎ目を消す
      const w = Math.min(Tw + (x + Tw < pv.page.w ? 1.5 / s : 0), pv.page.w - x);
      const hh = Math.min(Tw + (y + Tw < pv.page.h ? 1.5 / s : 0), pv.page.h - y);
      const cv = h('canvas', { class: 'tile' });
      const st = cv.style;
      st.left = x + 'px';
      st.top = y + 'px';
      st.width = w + 'px';
      st.height = hh + 'px';
      st.zIndex = String(10 + lvl);
      pv.el.append(cv);
      t = { key, cv, ctx: cv.getContext('2d'), pv, lvl, x, y, w, h: hh, s, dirty: true, used: 0 };
      this.tiles.set(key, t);
    }
    const W = Math.max(1, Math.round(t.w * s)), H = Math.max(1, Math.round(t.h * s));
    if (t.cv.width !== W || t.cv.height !== H) {
      t.cv.width = W;
      t.cv.height = H;
    }
    t.kx = W / t.w;
    t.ky = H / t.h;
    t.ctx.setTransform(t.kx, 0, 0, t.ky, -t.x * t.kx, -t.y * t.ky);
    renderRegion(t.ctx, pv.page, { x: t.x, y: t.y, w: t.w, h: t.h }, s, { hidden: pv.hidden, assets: this.assets });
    t.dirty = false;
    t.used = now();
  }
  removeTile(key, t) {
    t.cv.width = 0;
    t.cv.height = 0;
    t.cv.remove();
    this.tiles.delete(key);
  }
  dropTiles(pv) {
    for (const [k, t] of this.tiles) if (t.pv === pv) this.removeTile(k, t);
  }
  tilesOf(pv, bb) {
    const out = [];
    for (const t of this.tiles.values()) {
      if (t.pv !== pv || t.dirty) continue;
      if (bb && (bb[0] > t.x + t.w || bb[2] < t.x || bb[1] > t.y + t.h || bb[3] < t.y)) continue;
      out.push(t);
    }
    return out;
  }
  invalidatePage(pv) {
    pv.dirty = true;
    this.dropTiles(pv);
    this.requestRender();
  }
  repaintRegion(pv, bb, pad = 2) {
    if (!bb || !isFinite(bb[0])) return;
    if (pv.scale > 0 && !pv.dirty && pv.ctx) {
      const sx = pv.sx, sy = pv.sy;
      const x0 = Math.max(0, Math.floor((bb[0] - pad) * sx) / sx), y0 = Math.max(0, Math.floor((bb[1] - pad) * sy) / sy);
      const x1 = Math.min(pv.page.w, Math.ceil((bb[2] + pad) * sx) / sx), y1 = Math.min(pv.page.h, Math.ceil((bb[3] + pad) * sy) / sy);
      if (x1 > x0 && y1 > y0) {
        pv.ctx.setTransform(sx, 0, 0, sy, 0, 0);
        renderRegion(pv.ctx, pv.page, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, sx, { hidden: pv.hidden, assets: this.assets });
      }
    } else this.requestRender();
    const ex = [bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad];
    for (const t of this.tilesOf(pv, ex)) {
      const kx = t.kx, ky = t.ky;
      const x0 = Math.max(t.x, t.x + Math.floor((ex[0] - t.x) * kx) / kx), y0 = Math.max(t.y, t.y + Math.floor((ex[1] - t.y) * ky) / ky);
      const x1 = Math.min(t.x + t.w, t.x + Math.ceil((ex[2] - t.x) * kx) / kx), y1 = Math.min(t.y + t.h, t.y + Math.ceil((ex[3] - t.y) * ky) / ky);
      if (x1 <= x0 || y1 <= y0) continue;
      t.ctx.setTransform(kx, 0, 0, ky, -t.x * kx, -t.y * ky);
      renderRegion(t.ctx, pv.page, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, t.s, { hidden: pv.hidden, assets: this.assets });
    }
  }
  drawNew(pv, it) {
    const dark = isDarkColor(pv.page.paper);
    if (pv.scale > 0 && !pv.dirty && pv.ctx) {
      pv.ctx.setTransform(pv.sx, 0, 0, pv.sy, 0, 0);
      drawItem(pv.ctx, it, dark, this.assets);
    } else this.requestRender();
    for (const t of this.tilesOf(pv, it.bb)) {
      t.ctx.setTransform(t.kx, 0, 0, t.ky, -t.x * t.kx, -t.y * t.ky);
      drawItem(t.ctx, it, dark, this.assets);
    }
  }
  assetLoaded(id) {
    for (const pv of this.pvs) {
      if (pv.page.bg === id || pv.page.items.some((it) => it.t === 'i' && it.asset === id)) this.invalidatePage(pv);
    }
    if (this.sel && this.sel.items.some((it) => it.asset === id)) this.renderSelCanvas();
  }

  // ink / fx レイヤー
  inkTransform(pv) {
    const { tx, ty, z } = this.view;
    return [this.dpr * z, (tx + pv.x * z) * this.dpr, (ty + pv.y * z) * this.dpr];
  }
  devRect(pv, bb, pad) {
    const [k, ox, oy] = this.inkTransform(pv);
    const W = this.inkCv.width, H = this.inkCv.height;
    return [
      clamp(Math.floor(ox + (bb[0] - pad) * k), 0, W),
      clamp(Math.floor(oy + (bb[1] - pad) * k), 0, H),
      clamp(Math.ceil(ox + (bb[2] + pad) * k), 0, W),
      clamp(Math.ceil(oy + (bb[3] + pad) * k), 0, H),
    ];
  }
  clearTip() {
    const d = this.inkDirty;
    if (!d) return;
    this.inkCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.inkCtx.clearRect(d[0], d[1], d[2] - d[0], d[3] - d[1]);
    this.inkDirty = null;
  }
  clearInk() {
    this.clearTip();
    const d = this.frozenDirty;
    if (!d) return;
    this.frozenCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.frozenCtx.clearRect(d[0], d[1], d[2] - d[0], d[3] - d[1]);
    this.frozenDirty = null;
  }
  clearFx() {
    const d = this.fxDirty;
    if (!d) return;
    this.fxCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.fxCtx.clearRect(d[0], d[1], d[2] - d[0], d[3] - d[1]);
    this.fxDirty = null;
  }
  markFx(pv, bb, pad) {
    const r = this.devRect(pv, bb, pad);
    const d = this.fxDirty;
    this.fxDirty = d ? [Math.min(d[0], r[0]), Math.min(d[1], r[1]), Math.max(d[2], r[2]), Math.max(d[3], r[3])] : r;
  }
  resetInkStyle() {
    const s = this.inkWrap.style;
    s.opacity = '1';
    s.mixBlendMode = 'normal';
  }

  // ---------------------------------------------------------------- 入力の振り分け
  sp(e) {
    return { x: e.clientX - this.rect.left, y: e.clientY - this.rect.top };
  }
  toWorld(sp) {
    const { tx, ty, z } = this.view;
    return { x: (sp.x - tx) / z, y: (sp.y - ty) / z };
  }
  localPt(ev, pv) {
    const { tx, ty, z } = this.view;
    return [(ev.clientX - this.rect.left - tx) / z - pv.x, (ev.clientY - this.rect.top - ty) / z - pv.y];
  }
  pageAt(wp, tol = 0) {
    for (const pv of this.pvs) {
      if (wp.x >= pv.x - tol && wp.x <= pv.x + pv.page.w + tol && wp.y >= pv.y - tol && wp.y <= pv.y + pv.page.h + tol) return pv;
    }
    return null;
  }
  fingerDraws() {
    const m = settings.fingerDraw;
    return m === 'on' ? true : m === 'off' ? false : !settings.penSeen;
  }
  notePen() {
    if (!settings.penSeen) {
      settings.penSeen = true;
      saveSettings();
      this.hooks.onPenDetected && this.hooks.onPenDetected();
    }
  }
  pressureOf(ev) {
    if (ev.pointerType !== 'pen') return 0.3;
    const p = ev.pressure;
    if (p > 0 && p !== 0.5) this.realPressure = true;
    if (!(p > 0)) return 0.12;
    if (p === 0.5 && !this.realPressure) return 0.3;
    return p;
  }

  onDown(e) {
    if (!this.loaded || this.isUi(e.target)) return;
    const type = e.pointerType;
    if (type === 'touch') return this.touchDown(e);
    if (type === 'pen') this.notePen();
    if (type === 'mouse' && e.button !== 0) {
      if (e.button === 1 || e.button === 2) this.beginMousePan(e);
      return;
    }
    if (this.action) return;
    this.cancelTouchGesture();
    this.stopAnim();
    try { this.stage.setPointerCapture(e.pointerId); } catch (_) {}
    this.begin(e);
  }
  onMove(e) {
    if (!this.loaded) return;
    if (e.pointerType === 'touch') return this.touchMove(e);
    const a = this.action;
    if (a && a.pointerId === e.pointerId) return this.moveAction(a, e);
    if (this.mousePan && this.mousePan.id === e.pointerId) {
      const m = this.mousePan;
      const b = this.dragBounds(m.v0.z);
      this.setView(rubber(m.v0.tx + e.clientX - m.x, b.minTx, b.maxTx, this.sw), rubber(m.v0.ty + e.clientY - m.y, b.minTy, b.maxTy, this.sh), m.v0.z);
      return;
    }
    if (!a) this.hover(e);
  }
  onUp(e, cancel) {
    if (e.pointerType === 'touch') return this.touchUp(e, cancel);
    if (e.pointerType === 'pen') this.lastPenUp = now();
    if (this.mousePan && this.mousePan.id === e.pointerId) {
      const from = this.mousePan.from;
      this.mousePan = null;
      this.settleView({ from });
      return;
    }
    const a = this.action;
    if (a && a.pointerId === e.pointerId) this.endAction(a, e, cancel);
  }
  beginMousePan(e) {
    this.stopAnim();
    this.mousePan = { id: e.pointerId, x: e.clientX, y: e.clientY, v0: { ...this.view }, from: this.focusIndex() };
    try { this.stage.setPointerCapture(e.pointerId); } catch (_) {}
  }
  onWheel(e) {
    if (!this.loaded) return;
    e.preventDefault();
    this.stopAnim();
    const { tx, ty, z } = this.view;
    if (!this._wheelFrom && this._wheelFrom !== 0) this._wheelFrom = this.focusIndex();
    if (e.ctrlKey || e.metaKey) {
      const sp = this.sp(e);
      const pv = this.pvs[this.focusIndex()];
      const nz = clamp(z * Math.exp(-e.deltaY * 0.01), pv ? this.minZoomFor(pv) : 0.1, MAX_Z);
      const w = this.toWorld(sp);
      this.setView(sp.x - w.x * nz, sp.y - w.y * nz, nz);
      this.hooks.onZoom && this.hooks.onZoom(nz);
    } else {
      const k = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? this.sh : 1;
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX, dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      const b = this.dragBounds(z);
      this.setView(clamp(tx - dx * k, b.minTx - 40, b.maxTx + 40), clamp(ty - dy * k, b.minTy - 40, b.maxTy + 40), z);
    }
    clearTimeout(this._wheelT);
    this._wheelT = setTimeout(() => {
      const from = this._wheelFrom;
      this._wheelFrom = null;
      this.settleView({ from });
    }, 200);
  }

  // ---------------------------------------------------------------- 指（パン・ピンチ・タップ）
  touchDown(e) {
    if (this.action && this.action.pointerType === 'pen') return; // 書いている間の手のひらは無視
    // ペンを離した直後・ペンが浮いている間に置かれた指は手のひらとみなす
    if (!this.touches.size && !this.fingerDraws()) {
      const tn = now();
      if (tn - (this.lastPenUp || 0) < 250 || tn - (this.lastPenHover || 0) < 200) return;
      if (e.width > 70 && e.height > 70) return;
    }
    const sp = this.sp(e);
    this.touches.set(e.pointerId, { id: e.pointerId, x: sp.x, y: sp.y, sx: sp.x, sy: sp.y });
    if (!this.tapSess) this.tapSess = { t0: now(), max: 0, moved: false, drew: false, sp, from: this.focusIndex() };
    this.tapSess.max = Math.max(this.tapSess.max, this.touches.size);
    this.stopAnim();
    if (this.touches.size === 1 && !this.action) {
      // 指で描くモード、または選択範囲の上なら指でも操作（選択の移動など）
      if (this.fingerDraws() || (this.sel && this.hitSel(sp, 'touch'))) {
        try { this.stage.setPointerCapture(e.pointerId); } catch (_) {}
        this.begin(e);
        return;
      }
    }
    const a = this.action;
    if (a && a.pointerType === 'touch') {
      // 2 本目の指が来たら、描きかけ（短い）は取り消してジェスチャーへ
      if (a.kind === 'stroke' && now() - a.t0 >= 350) {
        this.endAction(a, null, false);
        this.tapSess.drew = true;
      } else this.cancelAction();
    }
    this.rebaseGesture();
  }
  rebaseGesture() {
    const pts = [...this.touches.values()];
    const v = { ...this.view };
    if (!pts.length) {
      this.tg = null;
      return;
    }
    if (pts.length === 1) {
      const p = pts[0];
      const mode = this.tg && (this.tg.mode === 'pan' || this.tg.mode === 'pinch') ? 'pan' : 'pending';
      this.tg = { mode, id: p.id, p0: { x: p.x, y: p.y }, v0: v, samples: [{ t: now(), x: p.x, y: p.y }] };
    } else {
      const a = pts[0], b = pts[1];
      const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const d = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
      this.tg = { mode: 'pinch', ids: [a.id, b.id], c0: c, d0: d, v0: v, w: { x: (c.x - v.tx) / v.z, y: (c.y - v.ty) / v.z } };
      this.setPull(0);
    }
  }
  cancelTouchGesture() {
    const g = this.tg;
    this.tg = null;
    this.touches.clear();
    this.tapSess = null;
    this.setPull(0);
    if (g && (g.mode === 'pan' || g.mode === 'pinch')) this.settleView();
  }
  touchMove(e) {
    const t = this.touches.get(e.pointerId);
    const a = this.action;
    if (a && a.pointerId === e.pointerId) {
      if (t) {
        const sp = this.sp(e);
        t.x = sp.x;
        t.y = sp.y;
      }
      return this.moveAction(a, e);
    }
    if (!t) return;
    const sp = this.sp(e);
    t.x = sp.x;
    t.y = sp.y;
    if (this.tapSess && Math.hypot(t.x - t.sx, t.y - t.sy) > 10) this.tapSess.moved = true;
    const g = this.tg;
    if (!g) return;
    if (g.mode === 'pending') {
      if (Math.hypot(t.x - g.p0.x, t.y - g.p0.y) < 8) return;
      g.mode = 'pan';
      g.p0 = { x: t.x, y: t.y };
      g.v0 = { ...this.view };
      g.samples = [];
    }
    if (g.mode === 'pan') {
      if (t.id !== g.id) return;
      const b = this.dragBounds(g.v0.z);
      const rawTx = g.v0.tx + t.x - g.p0.x;
      this.setView(rubber(rawTx, b.minTx, b.maxTx, this.sw), rubber(g.v0.ty + t.y - g.p0.y, b.minTy, b.maxTy, this.sh), g.v0.z);
      this.setPull(rawTx < b.minTx && this.focusIndex() === this.pvs.length - 1 ? b.minTx - rawTx : 0);
      const tn = now();
      g.samples.push({ t: tn, x: t.x, y: t.y });
      while (g.samples.length > 2 && tn - g.samples[0].t > 90) g.samples.shift();
    } else if (g.mode === 'pinch') {
      const A = this.touches.get(g.ids[0]), B = this.touches.get(g.ids[1]);
      if (!A || !B) return;
      const c = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
      const d = Math.max(10, Math.hypot(A.x - B.x, A.y - B.y));
      const pv = this.pvs[this.focusIndex()];
      const z = softZoom((g.v0.z * d) / g.d0, pv ? this.minZoomFor(pv) : 0.1);
      this.lastPinchC = c;
      this.setView(c.x - g.w.x * z, c.y - g.w.y * z, z);
      this.hooks.onZoom && this.hooks.onZoom(z);
    }
  }
  touchUp(e, cancel) {
    const a = this.action;
    if (a && a.pointerId === e.pointerId) {
      if (this.tapSess) this.tapSess.drew = a.kind !== 'none' && a.kind !== 'text';
      this.endAction(a, e, cancel);
    }
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    this.touches.delete(e.pointerId);
    const g = this.tg;
    const from = this.tapSess ? this.tapSess.from : null;
    if (g) {
      if (this.touches.size === 0) {
        this.tg = null;
        if (g.mode === 'pan') {
          const armed = this.pullArmed;
          this.setPull(0);
          const s = g.samples;
          let vx = 0, vy = 0;
          if (s.length >= 2) {
            const f = s[0], l = s[s.length - 1];
            const dt = l.t - f.t;
            if (dt > 0 && now() - l.t < 70) {
              vx = (l.x - f.x) / dt;
              vy = (l.y - f.y) / dt;
            }
          }
          const pv = this.pvs[from != null ? from : this.focusIndex()];
          const fitsX = pv && pv.page.w * this.view.z <= this.area().w * 1.05;
          if (armed && !cancel) {
            this.hooks.onPullAdd && this.hooks.onPullAdd();
          } else if (fitsX && Math.abs(vx) > 0.3 && Math.abs(vx) > Math.abs(vy) * 0.8) {
            this.settleView({ vx, from });
          } else if (Math.hypot(fitsX ? 0 : vx, vy) > 0.12) {
            this.startInertia(fitsX ? 0 : vx, vy, from);
          } else this.settleView({ from });
        } else if (g.mode === 'pinch') {
          this.settleView();
          this.hooks.onZoomEnd && this.hooks.onZoomEnd();
        }
      } else this.rebaseGesture();
    }
    if (this.touches.size === 0 && this.tapSess) {
      const s = this.tapSess;
      this.tapSess = null;
      if (!cancel && !s.moved && !s.drew && now() - s.t0 < 330) {
        if (s.max === 2 && settings.twoFingerUndo) {
          if (this.undo()) this.hooks.onGesture && this.hooks.onGesture('undo');
        } else if (s.max === 3 && settings.twoFingerUndo) {
          if (this.redo()) this.hooks.onGesture && this.hooks.onGesture('redo');
        } else if (s.max === 1) this.onTap(s.sp);
      }
    }
  }
  onTap(sp) {
    if (this.textEdit) return this.commitText();
    if (this.sel) return this.clearSelection();
    if (this.tool === 'text') return this.tapText(this.toWorld(sp));
    const tn = now();
    if (this.lastTap && tn - this.lastTap.t < 320 && Math.hypot(sp.x - this.lastTap.x, sp.y - this.lastTap.y) < 40) {
      this.lastTap = null;
      this.toggleZoom(sp);
      return;
    }
    this.lastTap = { t: tn, x: sp.x, y: sp.y };
  }

  // ---------------------------------------------------------------- ツール操作
  setTool(t) {
    if (this.tool === t) return;
    if (this.action) this.cancelAction();
    this.commitText();
    if (t !== 'lasso') this.clearSelection();
    this.tool = t;
    this.hideCursor();
  }
  begin(e) {
    const sp = this.sp(e);
    const wp = this.toWorld(sp);
    const base = { pointerId: e.pointerId, pointerType: e.pointerType, t0: now(), sp0: sp, kind: 'none' };
    if (this.textEdit) {
      this.commitText();
      this.action = base;
      return;
    }
    if (this.sel) {
      const hit = this.hitSel(sp, e.pointerType);
      if (hit) return this.beginSelDrag(base, hit);
      this.clearSelection();
      if (this.tool !== 'lasso') {
        this.action = base;
        return;
      }
    }
    const pv0 = this.pageAt(wp, 0);
    switch (this.tool) {
      case 'pen':
      case 'hl':
        if (!pv0) break;
        return this.beginStroke(base, pv0, e);
      case 'eraser':
        return this.beginErase(base, e);
      case 'lasso': {
        const pv = this.pageAt(wp, 40);
        if (!pv) break;
        return this.beginLasso(base, pv, wp);
      }
      case 'shape':
        if (!pv0) break;
        return this.beginShapeTool(base, pv0, e);
      case 'stamp':
        if (!pv0) break;
        return this.beginStamp(base, pv0, e);
      case 'text':
        this.action = { ...base, kind: 'text', wp };
        return;
      default:
        break;
    }
    this.action = base;
  }
  moveAction(a, e) {
    switch (a.kind) {
      case 'stroke': return this.moveStroke(a, e);
      case 'erase': return this.moveErase(a, e);
      case 'lasso': return this.moveLasso(a, e);
      case 'sel': return this.moveSel(a, e);
      case 'shapeTool': return this.moveShapeTool(a, e);
      case 'stamp': return this.moveStamp(a, e);
      default: return undefined;
    }
  }
  endAction(a, e, cancel) {
    this.action = null;
    switch (a.kind) {
      case 'stroke': this.endStroke(a); break;
      case 'erase': this.endErase(a); break;
      case 'lasso': this.endLasso(a, cancel); break;
      case 'sel': this.endSel(); break;
      case 'shapeTool': this.endShapeTool(a, cancel); break;
      case 'stamp': this.endStamp(a, cancel); break;
      case 'text':
        if (!cancel && e) {
          const sp = this.sp(e);
          if (Math.hypot(sp.x - a.sp0.x, sp.y - a.sp0.y) < 14) this.tapText(a.wp);
        }
        break;
      default: break;
    }
  }
  cancelAction() {
    const a = this.action;
    if (!a) return;
    this.action = null;
    if (a.kind === 'stroke') {
      clearTimeout(a.holdT);
      clearTimeout(a.predT);
      this.clearInk();
      this.clearFx();
      this.resetInkStyle();
    } else if (a.kind === 'erase') this.endErase(a);
    else if (a.kind === 'lasso') {
      clearTimeout(a.longT);
      cancelAnimationFrame(a.antsRaf);
      this.clearFx();
    } else if (a.kind === 'sel') this.endSel();
    else if (a.kind === 'shapeTool' || a.kind === 'stamp') this.clearInk();
  }

  // ---------------------------------------------------------------- ペン・蛍光ペン
  strokeOpts() {
    const T = settings.tools;
    if (this.tool === 'hl') {
      const t = T.hl;
      return { kind: 'hl', color: t.colors[t.ci], w: t.widths[t.wi], alpha: t.alpha, straight: t.straight, sens: 0 };
    }
    const t = T.pen;
    const pt = PEN_TYPES[t.type] || PEN_TYPES.fountain;
    return { kind: 'pen', color: t.colors[t.ci], w: t.widths[t.wi], sens: pt.sens * t.sens };
  }
  beginStroke(base, pv, e) {
    const o = this.strokeOpts();
    const live = new LiveStroke({ kind: o.kind, w: o.w, sens: o.sens, z: this.view.z });
    const a = (this.action = { ...base, kind: 'stroke', pv, live, o, scribble: false, targets: null, scrN: 0, scrTested: 1, shape: null, holdT: 0, anchor: null });
    const st = this.inkWrap.style;
    if (o.kind === 'hl') {
      st.opacity = String(o.alpha);
      st.mixBlendMode = isDarkColor(pv.page.paper) ? 'screen' : 'multiply';
    } else this.resetInkStyle();
    this.hideCursor();
    if (o.kind === 'hl' && o.straight) {
      const [x, y] = this.localPt(e, pv);
      const pts = new Float32Array([x, y, o.w / 2, x + 0.01, y, o.w / 2]);
      a.shape = { kind: 'line', pts, base: Float32Array.from(pts) };
      this.drawLive(a, null);
      return;
    }
    this.feed(a, [e]);
    this.drawLive(a, null);
    if (settings.holdShape) this.armHold(a, this.sp(e));
  }
  feed(a, evs) {
    const pv = a.pv;
    const { tx, ty, z } = this.view;
    const L = this.rect.left, T = this.rect.top;
    for (const ev of evs) a.live.add((ev.clientX - L - tx) / z - pv.x, (ev.clientY - T - ty) / z - pv.y, this.pressureOf(ev), ev.timeStamp);
  }
  moveStroke(a, e) {
    const evs = coalesced(e);
    if (a.shape) {
      const [x, y] = this.localPt(evs[evs.length - 1], a.pv);
      this.adjustShape(a, x, y);
      this.drawLive(a, null);
      return;
    }
    this.feed(a, evs);
    if (settings.scribble && a.o.kind === 'pen') this.checkScribble(a);
    const pred = settings.prediction && !a.scribble ? this.predict(a, e) : null;
    this.drawLive(a, pred);
    // ペンが止まったら予測部分を消す（止まった位置より先に線が残らないように）
    clearTimeout(a.predT);
    if (pred) a.predT = setTimeout(() => {
      if (this.action === a && !a.shape) this.drawLive(a, null);
    }, 45);
    if (a.anchor && !a.scribble) this.updateHold(a, this.sp(evs[evs.length - 1]));
  }
  predict(a, e) {
    let pe = null;
    try { pe = e.getPredictedEvents ? e.getPredictedEvents() : null; } catch (_) {}
    if (pe && pe.length) return pe.slice(-3).map((p) => this.localPt(p, a.pv));
    const raw = a.live.raw;
    const n = raw.length >> 2;
    if (n < 3) return null;
    const li = (n - 1) * 4, lt = raw[li + 3];
    let j = n - 2;
    while (j > 0 && lt - raw[j * 4 + 3] < 14) j--;
    const dt = lt - raw[j * 4 + 3];
    if (dt <= 0 || dt > 70) return null;
    const vx = (raw[li] - raw[j * 4]) / dt, vy = (raw[li + 1] - raw[j * 4 + 1]) / dt;
    const ms = 12;
    let px = vx * ms, py = vy * ms;
    const z = this.view.z;
    const L = Math.hypot(px, py), maxL = 26 / z;
    if (L * z < 1.2) return null;
    if (L > maxL) {
      px *= maxL / L;
      py *= maxL / L;
    }
    return [[raw[li] + px, raw[li + 1] + py]];
  }
  drawLive(a, pred) {
    const ctx = this.inkCtx, pv = a.pv, live = a.live;
    const [k, ox, oy] = this.inkTransform(pv);
    const hl = a.o.kind === 'hl';
    if (a.shape) this.clearInk();
    else {
      this.clearTip();
      // 凍結されたチャンクは別キャンバスへ 1 回だけ描く
      const frozen = live.takeFrozen();
      if (frozen.length) {
        const f = this.frozenCtx;
        f.setTransform(k, 0, 0, k, ox, oy);
        f.save();
        f.beginPath();
        f.rect(0, 0, pv.page.w, pv.page.h);
        f.clip();
        if (hl) {
          f.strokeStyle = a.o.color;
          f.lineWidth = a.o.w;
          f.lineCap = 'round';
          f.lineJoin = 'round';
          for (const p of frozen) f.stroke(p);
        } else {
          f.fillStyle = a.o.color;
          for (const p of frozen) f.fill(p);
        }
        f.restore();
        const r = this.devRect(pv, live.bb, a.o.w + 3);
        const d = this.frozenDirty;
        this.frozenDirty = d ? [Math.min(d[0], r[0]), Math.min(d[1], r[1]), Math.max(d[2], r[2]), Math.max(d[3], r[3])] : r;
      }
    }
    ctx.setTransform(k, 0, 0, k, ox, oy);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, pv.page.w, pv.page.h);
    ctx.clip();
    let bb;
    if (a.shape) {
      const pts = a.shape.pts;
      if (hl) {
        ctx.strokeStyle = a.o.color;
        ctx.lineWidth = a.o.w;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke(buildLinePath(pts));
      } else {
        ctx.fillStyle = a.o.color;
        ctx.fill(buildInkPath(pts));
      }
      bb = computeBB(pts);
    } else {
      const tip = live.tip(pred);
      if (hl) {
        ctx.strokeStyle = a.o.color;
        ctx.lineWidth = a.o.w;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke(live.line);
        if (tip) ctx.stroke(tip);
      } else {
        ctx.fillStyle = a.o.color;
        ctx.fill(live.ink.path);
        if (tip) ctx.fill(tip);
      }
      // 描き直す範囲は「今のチャンク＋ペン先」だけ
      bb = live.cbb.slice();
      const lp = live.lastPoint();
      for (const q of lp ? [lp].concat(pred || []) : pred || []) {
        if (q[0] < bb[0]) bb[0] = q[0];
        if (q[1] < bb[1]) bb[1] = q[1];
        if (q[0] > bb[2]) bb[2] = q[0];
        if (q[1] > bb[3]) bb[3] = q[1];
      }
    }
    ctx.restore();
    this.inkDirty = this.devRect(pv, bb, a.o.w + 3);
  }

  // ---- 長押しで図形に補正
  armHold(a, sp) {
    a.anchor = sp;
    clearTimeout(a.holdT);
    a.holdT = setTimeout(() => this.onHold(a), HOLD_MS);
  }
  updateHold(a, sp) {
    if (Math.hypot(sp.x - a.anchor.x, sp.y - a.anchor.y) > 6) this.armHold(a, sp);
  }
  onHold(a) {
    if (this.action !== a || a.scribble || a.shape) return;
    if (a.live.len * this.view.z < 20) return;
    const res = recognizeShape(a.live.allPoints(), this.view.z);
    if (!res) return;
    const lp = a.live.lastPoint();
    a.shape = { ...res, base: Float32Array.from(res.pts), hold: lp ? [lp[0], lp[1]] : null, th: 0 };
    this.drawLive(a, null);
    this.pulseAt(a.anchor);
    this.hooks.onShape && this.hooks.onShape(res.kind);
  }
  // 補正後もペンを離さずに動かすと形を調整できる
  adjustShape(a, x, y) {
    const sh = a.shape, B = sh.base, P = sh.pts;
    const n = B.length / 3;
    switch (sh.kind) {
      case 'line': {
        const e = snapLineEnd(B[0], B[1], x, y);
        P[3] = e[0];
        P[4] = e[1];
        break;
      }
      case 'polyline': {
        // 最後の辺だけが、ひとつ前の角を中心に 360° 回る
        const px = B[(n - 2) * 3], py = B[(n - 2) * 3 + 1];
        const e = snapLineEnd(px, py, x, y);
        P[(n - 1) * 3] = e[0];
        P[(n - 1) * 3 + 1] = e[1];
        break;
      }
      case 'arc':
      case 'curve': {
        // 始点を固定。始点に近い部分ほど動かず、ペン側ほど大きく回転・伸縮する
        const sx = B[0], sy = B[1];
        const v0x = B[(n - 1) * 3] - sx, v0y = B[(n - 1) * 3 + 1] - sy;
        const v1x = x - sx, v1y = y - sy;
        const L0 = Math.hypot(v0x, v0y), L1 = Math.hypot(v1x, v1y);
        if (L0 < 1e-3 || L1 < 1e-3) break;
        let th = Math.atan2(v1y, v1x) - Math.atan2(v0y, v0x);
        while (th - sh.th > Math.PI) th -= Math.PI * 2;
        while (th - sh.th < -Math.PI) th += Math.PI * 2;
        sh.th = th;
        const sc = L1 / L0;
        for (let i = 0; i < n; i++) {
          const t = sh.tt ? sh.tt[i] : i / (n - 1);
          const ang = th * t, s = Math.pow(sc, t);
          const c = Math.cos(ang), sn = Math.sin(ang);
          const dx = B[i * 3] - sx, dy = B[i * 3 + 1] - sy;
          P[i * 3] = sx + (dx * c - dy * sn) * s;
          P[i * 3 + 1] = sy + (dx * sn + dy * c) * s;
        }
        break;
      }
      default: {
        // 閉じた図形：中心からの距離に合わせて全体を拡大縮小（線の太さはそのまま）
        if (!sh.center || !sh.hold) break;
        const [cx, cy] = sh.center;
        const d0 = Math.hypot(sh.hold[0] - cx, sh.hold[1] - cy), d1 = Math.hypot(x - cx, y - cy);
        if (d0 < 1e-3) break;
        const s = clamp(d1 / d0, 0.05, 40);
        for (let i = 0; i < n; i++) {
          P[i * 3] = cx + (B[i * 3] - cx) * s;
          P[i * 3 + 1] = cy + (B[i * 3 + 1] - cy) * s;
        }
      }
    }
  }

  // ---- ぐしゃぐしゃ消し
  checkScribble(a, force) {
    const raw = a.live.raw;
    const n = raw.length >> 2;
    if (!a.scribble) {
      if (!force && (n < 6 || n - a.scrN < 3)) return;
      a.scrN = n;
      if (!detectScribble(raw, this.view.z, settings.scribbleSens)) return;
      a.scribble = true;
      a.targets = new Set();
      a.scrTested = 1;
      clearTimeout(a.holdT);
      this.inkWrap.style.opacity = '0.38';
    }
    const items = a.pv.page.items;
    const R = a.o.w * 0.5 + 2.5 / this.view.z;
    const newly = [];
    for (let i = Math.max(1, a.scrTested); i < n; i++) {
      const ax = raw[(i - 1) * 4], ay = raw[(i - 1) * 4 + 1], bx = raw[i * 4], by = raw[i * 4 + 1];
      for (let k = 0; k < items.length; k++) {
        const it = items[k];
        if (it.t !== 's' || a.targets.has(it)) continue;
        if (hitStrokeSegment(it, ax, ay, bx, by, R)) {
          a.targets.add(it);
          newly.push(it);
        }
      }
    }
    a.scrTested = n;
    if (a.targets.size && (newly.length || n - (a.tgtDrawn || 0) >= 6)) {
      a.tgtDrawn = n;
      this.drawTargets(a);
    }
  }
  // 消える予定の線を赤く表示（実際に消える範囲と同じ見た目に）
  drawTargets(a) {
    const pv = a.pv, raw = a.live.raw;
    const xy = [];
    for (let i = 0; i < raw.length; i += 4) xy.push(raw[i], raw[i + 1]);
    const hull = convexHull(xy);
    const hp = new Path2D();
    for (let i = 0; i < hull.length; i += 2) hp[i ? 'lineTo' : 'moveTo'](hull[i], hull[i + 1]);
    hp.closePath();
    this.clearFx();
    const ctx = this.fxCtx;
    const [k, ox, oy] = this.inkTransform(pv);
    ctx.setTransform(k, 0, 0, k, ox, oy);
    for (const it of a.targets) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, pv.page.w, pv.page.h);
      ctx.clip();
      if (hull.length >= 6 && insideFraction(it, hull, 3) < 0.45) ctx.clip(hp);
      if (it.k === 'hl') {
        ctx.strokeStyle = 'rgba(255,72,60,0.45)';
        ctx.lineWidth = it.w;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke(itemPath(it));
      } else {
        ctx.fillStyle = 'rgba(255,72,60,0.92)';
        ctx.fill(itemPath(it));
      }
      ctx.restore();
      this.markFx(pv, it.bb, 4);
    }
  }
  endStroke(a) {
    clearTimeout(a.holdT);
    clearTimeout(a.predT);
    const pv = a.pv;
    // 書き終わった時点でもう一度ぐしゃぐしゃ判定（途中で判定しきれなかった場合）
    if (!a.scribble && !a.shape && settings.scribble && a.o.kind === 'pen') this.checkScribble(a, true);
    if (a.scribble && a.targets && a.targets.size) {
      const targets = [...a.targets];
      this.clearInk();
      this.resetInkStyle();
      this.scribbleErase(pv, targets, a.live.raw);
      this.hooks.onScribbleErase && this.hooks.onScribbleErase(targets.length);
      return;
    }
    this.clearFx();
    let pts;
    if (a.shape) pts = a.shape.pts;
    else {
      a.live.finish();
      pts = a.live.points();
    }
    if (!pts || !pts.length) {
      this.clearInk();
      this.resetInkStyle();
      return;
    }
    const o = a.o;
    const it = { id: uid(), t: 's', k: o.kind, c: o.color, w: o.w, pts: Float32Array.from(pts) };
    if (o.kind === 'hl') it.a = o.alpha;
    it.bb = computeBB(it.pts);
    if (!a.shape && a.live.dense.length > 3) setItemPath(it, a.live.fullPath());
    this.beginEdit(pv);
    pv.page.items.push(it);
    this.commitEdits();
    this.drawNew(pv, it);
    this.clearInk();
    this.resetInkStyle();
    this.markDirty(pv.page);
  }
  // ぐしゃぐしゃ消し：ほぼ覆われた線は丸ごと、通り抜けているだけの長い線は覆った部分だけ消す
  scribbleErase(pv, targets, raw) {
    const xy = [];
    for (let i = 0; i < raw.length; i += 4) xy.push(raw[i], raw[i + 1]);
    const hull = convexHull(xy);
    const whole = [], partial = new Map();
    for (const it of targets) {
      const f = hull.length >= 6 ? insideFraction(it, hull) : 1;
      if (f >= 0.45) whole.push(it);
      else partial.set(it, cutStrokeByPoly(it, hull));
    }
    const wholeSet = new Set(whole);
    this.beginEdit(pv);
    const next = [];
    for (const it of pv.page.items) {
      if (wholeSet.has(it)) continue;
      const frags = partial.get(it);
      if (frags) {
        for (const f of frags) next.push({ ...it, id: uid(), pts: f, bb: computeBB(f), f: undefined, fa: undefined });
      } else next.push(it);
    }
    pv.page.items = next;
    this.commitEdits();
    this.repaintRegion(pv, unionBB(targets), 3);
    this.markDirty(pv.page);
    const hp = new Path2D();
    for (let i = 0; i < hull.length; i += 2) hp[i ? 'lineTo' : 'moveTo'](hull[i], hull[i + 1]);
    hp.closePath();
    this.dissolve(pv, targets, raw, new Set(partial.keys()), hp);
  }

  // ---------------------------------------------------------------- 図形ツール
  shapeOpts() {
    const t = settings.tools.shape;
    return { kind: t.kind, color: t.colors[t.ci], w: t.widths[t.wi], fill: t.fill, square: t.square };
  }
  beginShapeTool(base, pv, e) {
    const o = this.shapeOpts();
    const [x, y] = this.localPt(e, pv);
    this.action = { ...base, kind: 'shapeTool', pv, o, x0: x, y0: y, pts: null, closed: false };
    this.resetInkStyle();
    this.hideCursor();
    this.drawShapeTool(this.action, x, y);
  }
  moveShapeTool(a, e) {
    const evs = coalesced(e);
    const [x, y] = this.localPt(evs[evs.length - 1], a.pv);
    this.drawShapeTool(a, x, y);
  }
  drawShapeTool(a, x, y) {
    const g = shapeGeometry(a.o.kind, a.x0, a.y0, x, y, { w: a.o.w, square: a.o.square });
    const r = a.o.w / 2;
    const pts = new Float32Array(g.V.length * 3);
    g.V.forEach((p, i) => {
      pts[i * 3] = p[0];
      pts[i * 3 + 1] = p[1];
      pts[i * 3 + 2] = r;
    });
    a.pts = pts;
    a.closed = g.closed;
    this.clearInk();
    const ctx = this.inkCtx, pv = a.pv;
    const [k, ox, oy] = this.inkTransform(pv);
    ctx.setTransform(k, 0, 0, k, ox, oy);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, pv.page.w, pv.page.h);
    ctx.clip();
    if (a.closed && a.o.fill !== 'none') {
      ctx.globalAlpha = a.o.fill === 'solid' ? 1 : 0.2;
      ctx.fillStyle = a.o.color;
      ctx.fill(polyPath(pts));
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = a.o.color;
    ctx.fill(buildInkPath(pts));
    ctx.restore();
    this.inkDirty = this.devRect(pv, computeBB(pts), 4);
  }
  endShapeTool(a, cancel) {
    const pts = a.pts;
    this.clearInk();
    if (cancel || !pts) return;
    const bb = computeBB(pts);
    const z = this.view.z;
    if ((bb[2] - bb[0]) * z < 6 && (bb[3] - bb[1]) * z < 6) return;
    const pv = a.pv;
    const it = { id: uid(), t: 's', k: 'pen', c: a.o.color, w: a.o.w, pts, bb };
    if (a.closed && a.o.fill !== 'none') {
      it.f = a.o.color;
      it.fa = a.o.fill === 'solid' ? 1 : 0.2;
    }
    this.beginEdit(pv);
    pv.page.items.push(it);
    this.commitEdits();
    this.drawNew(pv, it);
    this.markDirty(pv.page);
  }

  // ---------------------------------------------------------------- スタンプ
  beginStamp(base, pv, e) {
    const st = this.hooks.getStamp && this.hooks.getStamp();
    if (!st) {
      this.action = base;
      this.hooks.onNoStamp && this.hooks.onNoStamp();
      return;
    }
    const [x, y] = this.localPt(e, pv);
    this.action = { ...base, kind: 'stamp', pv, st, x, y };
    this.resetInkStyle();
    this.hideCursor();
    this.drawStampPreview(this.action);
  }
  moveStamp(a, e) {
    const evs = coalesced(e);
    [a.x, a.y] = this.localPt(evs[evs.length - 1], a.pv);
    this.drawStampPreview(a);
  }
  drawStampPreview(a) {
    this.clearInk();
    const st = a.st, sc = st.scale || 1, pv = a.pv;
    const ctx = this.inkCtx;
    const [k, ox, oy] = this.inkTransform(pv);
    ctx.setTransform(k, 0, 0, k, ox, oy);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, pv.page.w, pv.page.h);
    ctx.clip();
    ctx.translate(a.x, a.y);
    ctx.scale(sc, sc);
    ctx.globalAlpha = 0.8;
    const dark = isDarkColor(pv.page.paper);
    for (const it of st.items) drawItem(ctx, it, dark, st.assets);
    ctx.restore();
    const b = st.bb;
    this.inkDirty = this.devRect(pv, [a.x + b[0] * sc, a.y + b[1] * sc, a.x + b[2] * sc, a.y + b[3] * sc], 4);
  }
  async endStamp(a, cancel) {
    this.clearInk();
    if (cancel) return;
    const st = a.st, sc = st.scale || 1, pv = a.pv;
    const amap = new Map();
    for (const [id, entry] of st.assets) {
      if (!this.hooks.importStampAsset) continue;
      const nid = await this.hooks.importStampAsset(id, entry);
      if (nid) amap.set(id, nid);
    }
    if (!this.pvMap.has(pv.page)) return;
    const items = st.items.map((it) => transformItem(cloneItem(it, amap), 0, 0, { tx: a.x, ty: a.y, s: sc, r: 0 }));
    this.beginEdit(pv);
    pv.page.items.push(...items);
    this.commitEdits();
    for (const it of items) this.drawNew(pv, it);
    this.markDirty(pv.page);
    this.pulseAt({ x: (pv.x + a.x) * this.view.z + this.view.tx, y: (pv.y + a.y) * this.view.z + this.view.ty });
  }

  // ---------------------------------------------------------------- 消しゴム
  eraserR() {
    const t = settings.tools.eraser;
    return t.sizes[t.si] / 2 / this.view.z;
  }
  beginErase(base, e) {
    const a = (this.action = { ...base, kind: 'erase', last: null, dirty: new Map(), changed: false });
    this.eraseEvents(a, [e]);
    this.showEraserCursor(this.sp(e));
  }
  moveErase(a, e) {
    const evs = coalesced(e);
    this.eraseEvents(a, evs);
    this.showEraserCursor(this.sp(evs[evs.length - 1]));
  }
  eraseEvents(a, evs) {
    const R = this.eraserR();
    for (const ev of evs) {
      const wp = this.toWorld(this.sp(ev));
      const samples = [];
      if (a.last) {
        const d = Math.hypot(wp.x - a.last.x, wp.y - a.last.y);
        const steps = Math.max(1, Math.ceil(d / (R * 0.5)));
        for (let i = 1; i <= steps; i++) samples.push({ x: a.last.x + ((wp.x - a.last.x) * i) / steps, y: a.last.y + ((wp.y - a.last.y) * i) / steps });
      } else samples.push(wp);
      a.last = wp;
      for (const p of samples) {
        for (const pv of this.pvs) {
          if (p.x < pv.x - R || p.x > pv.x + pv.page.w + R || p.y < pv.y - R || p.y > pv.y + pv.page.h + R) continue;
          this.eraseAt(a, pv, p.x - pv.x, p.y - pv.y, R);
        }
      }
    }
    for (const [pv, bb] of a.dirty) this.repaintRegion(pv, bb, 3);
    a.dirty.clear();
  }
  eraseAt(a, pv, x, y, R) {
    const T = settings.tools.eraser;
    const items = pv.page.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.t !== 's' || (T.hlOnly && it.k !== 'hl')) continue;
      if (!hitStrokeCircle(it, x, y, R)) continue;
      if (T.mode === 'stroke') {
        this.beginEdit(pv);
        items.splice(i, 1);
      } else {
        const frags = splitStroke(it, x, y, R);
        if (frags === null) continue;
        this.beginEdit(pv);
        items.splice(i, 1, ...frags.map((f) => ({ ...it, id: uid(), pts: f, bb: computeBB(f), f: undefined, fa: undefined })));
      }
      const d = a.dirty.get(pv);
      const b = it.bb;
      a.dirty.set(pv, d ? [Math.min(d[0], b[0]), Math.min(d[1], b[1]), Math.max(d[2], b[2]), Math.max(d[3], b[3])] : b.slice());
      a.changed = true;
      this.markDirty(pv.page);
    }
  }
  endErase(a) {
    this.commitEdits();
    this.hideCursor();
    if (a.changed && settings.autoRevert) this.hooks.onAutoRevert && this.hooks.onAutoRevert();
  }

  // ---------------------------------------------------------------- なげなわ
  beginLasso(base, pv, wp) {
    const a = (this.action = { ...base, kind: 'lasso', pv, pts: [wp.x - pv.x, wp.y - pv.y], rect: settings.tools.lasso.mode === 'rect', moved: false });
    a.longT = setTimeout(() => {
      if (this.action === a && !a.moved) {
        this.action = null;
        cancelAnimationFrame(a.antsRaf);
        this.clearFx();
        this.hooks.onLongPress && this.hooks.onLongPress(a.sp0, pv, a.pts[0], a.pts[1]);
      }
    }, 560);
    let off = 0;
    const loop = () => {
      if (this.action !== a) return;
      off = (off + 0.5) % 22;
      this.drawLasso(a, off);
      a.antsRaf = requestAnimationFrame(loop);
    };
    a.antsRaf = requestAnimationFrame(loop);
  }
  moveLasso(a, e) {
    const z = this.view.z;
    for (const ev of coalesced(e)) {
      const [x, y] = this.localPt(ev, a.pv);
      const n = a.pts.length;
      if (Math.hypot(x - a.pts[n - 2], y - a.pts[n - 1]) < 2 / z) continue;
      a.pts.push(x, y);
    }
    if (!a.moved) {
      const sp = this.sp(e);
      if (Math.hypot(sp.x - a.sp0.x, sp.y - a.sp0.y) > 6) {
        a.moved = true;
        clearTimeout(a.longT);
      }
    }
  }
  lassoPoly(a) {
    if (!a.rect) return a.pts;
    const n = a.pts.length;
    const x0 = a.pts[0], y0 = a.pts[1], x1 = a.pts[n - 2], y1 = a.pts[n - 1];
    return [x0, y0, x1, y0, x1, y1, x0, y1];
  }
  drawLasso(a, off) {
    const P = this.lassoPoly(a);
    this.clearFx();
    if (P.length < 4) return;
    const ctx = this.fxCtx, pv = a.pv, z = this.view.z;
    const [k, ox, oy] = this.inkTransform(pv);
    ctx.setTransform(k, 0, 0, k, ox, oy);
    const path = new Path2D();
    path.moveTo(P[0], P[1]);
    let x0 = P[0], y0 = P[1], x1 = P[0], y1 = P[1];
    for (let i = 2; i < P.length; i += 2) {
      path.lineTo(P[i], P[i + 1]);
      if (P[i] < x0) x0 = P[i];
      if (P[i] > x1) x1 = P[i];
      if (P[i + 1] < y0) y0 = P[i + 1];
      if (P[i + 1] > y1) y1 = P[i + 1];
    }
    path.closePath();
    ctx.globalAlpha = 0.09;
    ctx.fillStyle = this.accent;
    ctx.fill(path);
    ctx.globalAlpha = 1;
    ctx.setLineDash([6 / z, 5 / z]);
    ctx.lineDashOffset = -off / z;
    ctx.lineWidth = 1.6 / z;
    ctx.strokeStyle = this.accent;
    ctx.stroke(path);
    ctx.setLineDash([]);
    this.markFx(pv, [x0, y0, x1, y1], 4 / z);
  }
  endLasso(a, cancel) {
    clearTimeout(a.longT);
    cancelAnimationFrame(a.antsRaf);
    this.clearFx();
    if (cancel) return;
    const pv = a.pv, z = this.view.z;
    let items = [];
    if (!a.moved) {
      const x = a.pts[0], y = a.pts[1];
      const its = pv.page.items;
      for (let i = its.length - 1; i >= 0; i--) {
        const it = its[i];
        if (it.t === 's' ? hitStrokeCircle(it, x, y, 7 / z) || (it.f && pointInPoly(x, y, Array.from(it.pts).filter((_, k) => k % 3 !== 2))) : hitBox(it, x, y, 4 / z)) {
          items = [it];
          break;
        }
      }
    } else {
      const P = this.lassoPoly(a);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < P.length; i += 2) {
        if (P[i] < x0) x0 = P[i];
        if (P[i] > x1) x1 = P[i];
        if (P[i + 1] < y0) y0 = P[i + 1];
        if (P[i + 1] > y1) y1 = P[i + 1];
      }
      if (x1 - x0 < 3 / z && y1 - y0 < 3 / z) return;
      const pbb = [x0, y0, x1, y1];
      for (const it of pv.page.items) if (this.inLasso(it, P, pbb)) items.push(it);
    }
    if (items.length) this.select(pv, items);
  }
  inLasso(it, P, pbb) {
    const b = it.bb;
    if (b[2] < pbb[0] || b[0] > pbb[2] || b[3] < pbb[1] || b[1] > pbb[3]) return false;
    if (it.t !== 's') return pointInPoly(it.cx, it.cy, P);
    const p = it.pts, n = p.length / 3;
    let inside = 0, total = 0;
    for (let i = 0; i < n; i++) {
      total++;
      if (pointInPoly(p[i * 3], p[i * 3 + 1], P)) inside++;
      if (i < n - 1) {
        total++;
        if (pointInPoly((p[i * 3] + p[i * 3 + 3]) / 2, (p[i * 3 + 1] + p[i * 3 + 4]) / 2, P)) inside++;
      }
    }
    return inside * 2 >= total;
  }

  // ---------------------------------------------------------------- 選択
  select(pv, items) {
    this.clearSelection();
    const el = h('canvas', { class: 'sel-canvas' });
    this.world.append(el);
    this.sel = { pv, items, bb: unionBB(items), m: { tx: 0, ty: 0, s: 1, r: 0 }, el, k: 1 };
    pv.hidden = new Set(items);
    this.repaintRegion(pv, this.sel.bb, 3);
    this.renderSelCanvas();
    this.buildSelUi();
    this.updateSelUi();
    this.hooks.onSelection && this.hooks.onSelection(true);
  }
  renderSelCanvas() {
    const s = this.sel;
    if (!s) return;
    const pad = 6;
    const x = s.bb[0] - pad, y = s.bb[1] - pad;
    const w = s.bb[2] - s.bb[0] + pad * 2, hh = s.bb[3] - s.bb[1] + pad * 2;
    const k = Math.max(0.3, Math.min(this.view.z * this.dpr, Math.sqrt(SEL_PX / (w * hh))));
    const W = Math.max(1, Math.ceil(w * k)), H = Math.max(1, Math.ceil(hh * k));
    s.el.width = W;
    s.el.height = H;
    const st = s.el.style;
    st.left = s.pv.x + x + 'px';
    st.top = s.pv.y + y + 'px';
    st.width = w + 'px';
    st.height = hh + 'px';
    const ctx = s.el.getContext('2d');
    ctx.setTransform(W / w, 0, 0, H / hh, (-x * W) / w, (-y * H) / hh);
    const dark = isDarkColor(s.pv.page.paper);
    for (const it of s.items) drawItem(ctx, it, dark, this.assets);
    s.k = k;
    this.applySelTransform();
  }
  applySelTransform() {
    const m = this.sel.m;
    this.sel.el.style.transform = `translate(${m.tx}px, ${m.ty}px) rotate(${m.r}rad) scale(${m.s})`;
  }
  buildSelUi() {
    const ui = this.selUi;
    ui.innerHTML = '';
    const box = h('div', { class: 'sel-box' });
    for (const c of ['nw', 'ne', 'se', 'sw']) box.append(h('i', { class: 'sel-h ' + c }));
    box.append(h('i', { class: 'sel-rot-line' }), h('i', { class: 'sel-rot' }));
    const menu = h('div', { class: 'sel-menu', 'data-ui': '' });
    const btn = (ic, label, fn, cls) => {
      const b = h('button', { class: 'sel-btn ' + (cls || ''), title: label, html: icon(ic) + `<span>${label}</span>` });
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn(b);
      });
      return b;
    };
    const onlyImages = this.sel.items.every((it) => it.t === 'i');
    menu.append(
      ...[
        onlyImages ? null : btn('palette', '色', (b) => this.hooks.onSelColor && this.hooks.onSelColor(b)),
        btn('copy', 'コピー', () => this.copySel()),
        btn('cut', 'カット', () => this.cutSel()),
        btn('duplicate', '複製', () => this.duplicateSel()),
        btn('stamp', 'スタンプ', () => this.hooks.onSelStamp && this.hooks.onSelStamp()),
        btn('more', 'その他', (b) => this.hooks.onSelMore && this.hooks.onSelMore(b)),
        btn('trash', '削除', () => this.deleteSel(), 'danger'),
      ].filter(Boolean)
    );
    ui.append(box, menu);
    ui.classList.add('on');
    ui.classList.remove('dragging');
    this.selBox = box;
    this.selMenu = menu;
    this.selMenuSize = { w: menu.offsetWidth, h: menu.offsetHeight };
  }
  selGeom() {
    const s = this.sel, m = s.m;
    const { tx, ty, z } = this.view;
    const cx = s.pv.x + (s.bb[0] + s.bb[2]) / 2 + m.tx, cy = s.pv.y + (s.bb[1] + s.bb[3]) / 2 + m.ty;
    return {
      scx: cx * z + tx,
      scy: cy * z + ty,
      w: (s.bb[2] - s.bb[0]) * z * m.s + 20,
      h: (s.bb[3] - s.bb[1]) * z * m.s + 20,
      r: m.r,
    };
  }
  updateSelUi() {
    if (!this.sel || !this.selBox) return;
    const g = this.selGeom();
    const b = this.selBox.style;
    b.width = g.w + 'px';
    b.height = g.h + 'px';
    b.transform = `translate(${g.scx - g.w / 2}px, ${g.scy - g.h / 2}px) rotate(${g.r}rad)`;
    const c = Math.abs(Math.cos(g.r)), s = Math.abs(Math.sin(g.r));
    const ey = (s * g.w + c * g.h) / 2;
    const ms = this.selMenuSize;
    const mw = ms.w || 360, mh = ms.h || 50;
    let top = g.scy - ey - 46 - mh;
    if (top < this.insets.top + 8) top = g.scy + ey + 14;
    if (top + mh > this.sh - this.insets.bottom - 8) top = clamp(g.scy - mh / 2, this.insets.top + 8, this.sh - mh - 8);
    const left = clamp(g.scx - mw / 2, 8, Math.max(8, this.sw - mw - 8));
    this.selMenu.style.transform = `translate(${left}px, ${top}px)`;
  }
  hitSel(sp, type) {
    const g = this.selGeom();
    const dx = sp.x - g.scx, dy = sp.y - g.scy;
    const c = Math.cos(-g.r), s = Math.sin(-g.r);
    const lx = dx * c - dy * s, ly = dx * s + dy * c;
    const hw = g.w / 2, hh = g.h / 2;
    const tol = type === 'touch' ? 28 : 20;
    if (Math.hypot(lx, ly + hh + 30) < tol) return 'rot';
    const corners = { nw: [-hw, -hh], ne: [hw, -hh], se: [hw, hh], sw: [-hw, hh] };
    for (const key in corners) if (Math.hypot(lx - corners[key][0], ly - corners[key][1]) < tol) return key;
    if (Math.abs(lx) <= hw + 4 && Math.abs(ly) <= hh + 4) return 'move';
    return null;
  }
  beginSelDrag(base, hit) {
    const s = this.sel;
    const a = (this.action = { ...base, kind: 'sel', hit, m0: { ...s.m } });
    a.c0 = { x: s.pv.x + (s.bb[0] + s.bb[2]) / 2 + s.m.tx, y: s.pv.y + (s.bb[1] + s.bb[3]) / 2 + s.m.ty };
    if (hit !== 'move' && hit !== 'rot') {
      const sx = hit.includes('e') ? 1 : -1, sy = hit.includes('s') ? 1 : -1;
      const hvx = (sx * (s.bb[2] - s.bb[0])) / 2, hvy = (sy * (s.bb[3] - s.bb[1])) / 2;
      const cos = Math.cos(s.m.r), sin = Math.sin(s.m.r);
      const rx = (hvx * cos - hvy * sin) * s.m.s, ry = (hvx * sin + hvy * cos) * s.m.s;
      a.anchor = { x: a.c0.x - rx, y: a.c0.y - ry };
      a.diag = { x: 2 * rx, y: 2 * ry };
      a.hv = { x: hvx, y: hvy };
    }
    this.selUi.classList.add('dragging');
    s.el.classList.add('lifted');
  }
  moveSel(a, e) {
    const s = this.sel;
    if (!s) return;
    const sp = this.sp(e);
    const z = this.view.z;
    const m = s.m;
    if (a.hit === 'move') {
      m.tx = a.m0.tx + (sp.x - a.sp0.x) / z;
      m.ty = a.m0.ty + (sp.y - a.sp0.y) / z;
    } else if (a.hit === 'rot') {
      const cx = a.c0.x * z + this.view.tx, cy = a.c0.y * z + this.view.ty;
      let r = a.m0.r + Math.atan2(sp.y - cy, sp.x - cx) - Math.atan2(a.sp0.y - cy, a.sp0.x - cx);
      r = Math.atan2(Math.sin(r), Math.cos(r));
      const q = Math.round(r / (Math.PI / 2)) * (Math.PI / 2);
      if (Math.abs(r - q) < 0.07) r = q;
      m.r = r;
    } else {
      const w = this.toWorld(sp);
      const dl = a.diag.x * a.diag.x + a.diag.y * a.diag.y;
      const k = dl > 0 ? ((w.x - a.anchor.x) * a.diag.x + (w.y - a.anchor.y) * a.diag.y) / dl : 1;
      const ns = clamp(a.m0.s * k, 0.05, 40);
      m.s = ns;
      const cos = Math.cos(m.r), sin = Math.sin(m.r);
      const ncx = a.anchor.x + (a.hv.x * cos - a.hv.y * sin) * ns;
      const ncy = a.anchor.y + (a.hv.x * sin + a.hv.y * cos) * ns;
      m.tx = ncx - (s.pv.x + (s.bb[0] + s.bb[2]) / 2);
      m.ty = ncy - (s.pv.y + (s.bb[1] + s.bb[3]) / 2);
    }
    this.applySelTransform();
    this.updateSelUi();
  }
  endSel() {
    const s = this.sel;
    if (!s) return;
    this.selUi.classList.remove('dragging');
    s.el.classList.remove('lifted');
    const m = s.m;
    if (Math.abs(m.tx) < 1e-6 && Math.abs(m.ty) < 1e-6 && Math.abs(m.s - 1) < 1e-6 && Math.abs(m.r) < 1e-6) return;
    this.commitSel();
  }
  commitSel() {
    const s = this.sel, m = s.m, pv = s.pv;
    const cx = (s.bb[0] + s.bb[2]) / 2, cy = (s.bb[1] + s.bb[3]) / 2;
    let items = s.items.map((it) => transformItem(it, cx, cy, m));
    const dest = this.pageAt({ x: pv.x + cx + m.tx, y: pv.y + cy + m.ty }, 0) || pv;
    this.beginEdit(pv);
    if (dest === pv) {
      const idx = new Map(s.items.map((it, i) => [it, i]));
      pv.page.items = pv.page.items.map((it) => (idx.has(it) ? items[idx.get(it)] : it));
    } else {
      const set = new Set(s.items);
      pv.page.items = pv.page.items.filter((it) => !set.has(it));
      const dx = pv.x - dest.x, dy = pv.y - dest.y;
      items = items.map((it) => translateItem(it, dx, dy));
      this.beginEdit(dest);
      dest.page.items.push(...items);
      pv.hidden = null;
      this.repaintRegion(pv, s.bb, 3);
      this.markDirty(dest.page);
    }
    this.commitEdits();
    this.markDirty(pv.page);
    s.pv = dest;
    s.items = items;
    s.bb = unionBB(items);
    s.m = { tx: 0, ty: 0, s: 1, r: 0 };
    dest.hidden = new Set(items);
    this.renderSelCanvas();
    this.updateSelUi();
  }
  clearSelection() {
    const s = this.sel;
    if (!s) return;
    if (this.action && this.action.kind === 'sel') this.action = null;
    this.sel = null;
    s.el.remove();
    this.selUi.classList.remove('on', 'dragging');
    this.selUi.innerHTML = '';
    this.selBox = this.selMenu = null;
    s.pv.hidden = null;
    if (this.pvMap.has(s.pv.page)) this.repaintRegion(s.pv, s.bb, 3);
    this.hooks.onSelection && this.hooks.onSelection(false);
  }
  deleteSel() {
    const s = this.sel;
    if (!s) return;
    this.clearSelection();
    this.removeItems(s.pv, s.items);
  }
  copySel(silent) {
    const s = this.sel;
    if (!s) return;
    clipboard.items = s.items.map((it) => cloneItem(it));
    clipboard.bb = s.bb.slice();
    clipboard.assets = new Map();
    for (const it of s.items) if (it.t === 'i') clipboard.assets.set(it.asset, this.assets.get(it.asset));
    if (!silent) this.hooks.onToast && this.hooks.onToast('コピーしました');
  }
  cutSel() {
    this.copySel(true);
    this.deleteSel();
    this.hooks.onToast && this.hooks.onToast('カットしました');
  }
  duplicateSel() {
    const s = this.sel;
    if (!s) return;
    const pv = s.pv;
    const items = s.items.map((it) => translateItem(cloneItem(it), 24, 24));
    this.clearSelection();
    this.beginEdit(pv);
    pv.page.items.push(...items);
    this.commitEdits();
    for (const it of items) this.drawNew(pv, it);
    this.markDirty(pv.page);
    this.select(pv, items);
  }
  recolorSel(color) {
    const s = this.sel;
    if (!s) return;
    const map = new Map();
    const items = s.items.map((it) => {
      let n = it;
      if (it.t === 's' || it.t === 'x') {
        n = { ...it, c: color };
        if (it.f) n.f = color;
      }
      map.set(it, n);
      return n;
    });
    this.beginEdit(s.pv);
    s.pv.page.items = s.pv.page.items.map((it) => map.get(it) || it);
    this.commitEdits();
    this.markDirty(s.pv.page);
    s.items = items;
    s.pv.hidden = new Set(items);
    this.renderSelCanvas();
  }
  arrangeSel(dir) {
    const s = this.sel;
    if (!s) return;
    const set = new Set(s.items);
    const clones = s.items.map((it) => ({ ...it }));
    this.beginEdit(s.pv);
    const rest = s.pv.page.items.filter((it) => !set.has(it));
    s.pv.page.items = dir === 'front' ? rest.concat(clones) : clones.concat(rest);
    this.commitEdits();
    this.markDirty(s.pv.page);
    s.items = clones;
    s.pv.hidden = new Set(clones);
  }
  selectionCanvas(scale = 2, transparent = false) {
    const s = this.sel;
    if (!s) return null;
    const pad = 12;
    const x = s.bb[0] - pad, y = s.bb[1] - pad, w = s.bb[2] - s.bb[0] + pad * 2, hh = s.bb[3] - s.bb[1] + pad * 2;
    const sc = Math.min(scale, Math.sqrt(12e6 / (w * hh)));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.ceil(w * sc));
    cv.height = Math.max(1, Math.ceil(hh * sc));
    const ctx = cv.getContext('2d');
    if (!transparent) {
      ctx.fillStyle = s.pv.page.paper;
      ctx.fillRect(0, 0, cv.width, cv.height);
    }
    ctx.setTransform(sc, 0, 0, sc, -x * sc, -y * sc);
    const dark = isDarkColor(s.pv.page.paper);
    for (const it of s.items) drawItem(ctx, it, dark, this.assets);
    return cv;
  }
  selectAll() {
    const pv = this.pvs[this.currentIndex()];
    if (!pv || !pv.page.items.length) return;
    this.select(pv, pv.page.items.slice());
  }
  async paste(at) {
    if (!clipboard.items || !clipboard.items.length) return false;
    let pv, cx, cy;
    if (at) {
      pv = at.pv;
      cx = at.x;
      cy = at.y;
    } else {
      pv = this.centerPage();
      if (!pv) return false;
      const c = this.viewCenterLocal(pv);
      cx = c.x;
      cy = c.y;
    }
    const amap = new Map();
    for (const [id, entry] of clipboard.assets) {
      if (this.assets.has(id) || !entry || !this.hooks.importAsset) continue;
      const nid = await this.hooks.importAsset(entry);
      if (nid) amap.set(id, nid);
    }
    const bb = clipboard.bb;
    const dx = cx - (bb[0] + bb[2]) / 2, dy = cy - (bb[1] + bb[3]) / 2;
    const items = clipboard.items.map((it) => translateItem(cloneItem(it, amap), dx, dy));
    this.finishTransient();
    this.beginEdit(pv);
    pv.page.items.push(...items);
    this.commitEdits();
    for (const it of items) this.drawNew(pv, it);
    this.markDirty(pv.page);
    this.select(pv, items);
    return true;
  }
  centerPage() {
    return this.pvs[this.focusIndex()] || null;
  }
  viewCenterLocal(pv) {
    const A = this.area();
    const c = this.toWorld({ x: (A.l + A.r) / 2, y: (A.t + A.b) / 2 });
    return { x: clamp(c.x - pv.x, 60, pv.page.w - 60), y: clamp(c.y - pv.y, 60, pv.page.h - 60) };
  }
  insertImage(assetId, w, hgt) {
    const pv = this.centerPage();
    if (!pv) return;
    const c = this.viewCenterLocal(pv);
    const s = Math.min(1, (pv.page.w * 0.7) / w, (pv.page.h * 0.6) / hgt);
    const it = { id: uid(), t: 'i', asset: assetId, cx: c.x, cy: c.y, w: w * s, h: hgt * s, r: 0 };
    it.bb = itemBounds(it);
    this.finishTransient();
    this.beginEdit(pv);
    pv.page.items.push(it);
    this.commitEdits();
    this.drawNew(pv, it);
    this.markDirty(pv.page);
    this.select(pv, [it]);
  }

  // ---------------------------------------------------------------- テキスト
  tapText(wp) {
    const pv = this.pageAt(wp, 0);
    if (!pv) return;
    const x = wp.x - pv.x, y = wp.y - pv.y;
    const its = pv.page.items;
    for (let i = its.length - 1; i >= 0; i--) {
      const it = its[i];
      if (it.t === 'x' && hitBox(it, x, y, 6)) return this.editText(pv, it);
    }
    this.editText(pv, null, x, y);
  }
  editText(pv, item, x, y) {
    this.commitText();
    this.clearSelection();
    const T = settings.tools.text;
    const fs = item ? item.fs : T.sizes[T.si];
    const color = item ? item.c : T.colors[T.ci];
    let w, tlx, tly, r = 0;
    if (item) {
      w = item.w;
      r = item.r || 0;
      const c = Math.cos(r), s = Math.sin(r);
      tlx = item.cx - (item.w / 2) * c + (item.h / 2) * s;
      tly = item.cy - (item.w / 2) * s - (item.h / 2) * c;
      pv.hidden = new Set([item]);
      this.repaintRegion(pv, item.bb, 3);
    } else {
      w = clamp(pv.page.w - x - 24, 120, 440);
      tlx = x;
      tly = y - (fs * LINE_H) / 2;
    }
    const ta = h('textarea', { class: 'text-edit', 'data-ui': '', spellcheck: 'false', autocapitalize: 'off', rows: '1' });
    ta.value = item ? item.text : '';
    this.stage.append(ta);
    this.textEdit = { pv, item, ta, x: tlx, y: tly, w, fs, color, r };
    ta.addEventListener('input', () => this.positionText());
    ta.addEventListener('blur', () => {
      setTimeout(() => {
        if (this.textEdit && this.textEdit.ta === ta && document.activeElement !== ta) this.commitText();
      }, 150);
    });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.commitText();
      }
    });
    this.positionText();
    try { ta.focus({ preventScroll: true }); } catch (_) { ta.focus(); }
    this.hooks.onTextEdit && this.hooks.onTextEdit(true);
  }
  setTextStyle({ fs, color }) {
    const t = this.textEdit;
    if (!t) return;
    if (fs) t.fs = fs;
    if (color) t.color = color;
    this.positionText();
  }
  positionText() {
    const t = this.textEdit;
    if (!t) return;
    const { tx, ty, z } = this.view;
    const sx = (t.pv.x + t.x) * z + tx, sy = (t.pv.y + t.y) * z + ty;
    const st = t.ta.style;
    st.width = t.w * z + 'px';
    st.fontSize = t.fs * z + 'px';
    st.color = t.color;
    st.transform = `translate(${sx}px, ${sy}px) rotate(${t.r}rad)`;
    st.height = 'auto';
    st.height = Math.max(t.fs * z * LINE_H, t.ta.scrollHeight) + 'px';
  }
  commitText() {
    const t = this.textEdit;
    if (!t) return;
    this.textEdit = null;
    const text = t.ta.value.replace(/\s+$/, '');
    t.ta.remove();
    const pv = t.pv;
    if (t.item) pv.hidden = null;
    this.hooks.onTextEdit && this.hooks.onTextEdit(false);
    if (!this.pvMap.has(pv.page)) return;
    if (!text) {
      if (t.item) this.removeItems(pv, [t.item]);
      return;
    }
    if (t.item && text === t.item.text && t.fs === t.item.fs && t.color === t.item.c) {
      this.repaintRegion(pv, t.item.bb, 3);
      return;
    }
    const hh = textHeight(text, t.fs, t.w);
    const c = Math.cos(t.r), s = Math.sin(t.r);
    const it = {
      id: t.item ? t.item.id : uid(),
      t: 'x', text, fs: t.fs, c: t.color, w: t.w, h: hh, r: t.r,
      cx: t.x + (t.w / 2) * c - (hh / 2) * s,
      cy: t.y + (t.w / 2) * s + (hh / 2) * c,
    };
    it.bb = itemBounds(it);
    this.beginEdit(pv);
    const i = t.item ? pv.page.items.indexOf(t.item) : -1;
    if (i >= 0) pv.page.items[i] = it;
    else pv.page.items.push(it);
    this.commitEdits();
    this.repaintRegion(pv, unionBB(t.item ? [t.item, it] : [it]), 3);
    this.markDirty(pv.page);
  }

  // ---------------------------------------------------------------- 取り消し
  beginEdit(pv) {
    if (!this.edits) this.edits = new Map();
    if (!this.edits.has(pv.page)) this.edits.set(pv.page, pv.page.items.slice());
  }
  commitEdits() {
    const E = this.edits;
    this.edits = null;
    if (!E) return;
    const changes = [];
    for (const [page, before] of E) {
      const after = page.items;
      const aS = new Set(after), bS = new Set(before);
      const removed = [], added = [];
      before.forEach((it, i) => {
        if (!aS.has(it)) removed.push([i, it]);
      });
      after.forEach((it, i) => {
        if (!bS.has(it)) added.push([i, it]);
      });
      if (removed.length || added.length) changes.push({ page, removed, added });
    }
    if (changes.length) this.pushCmd({ type: 'items', changes });
  }
  pushCmd(c) {
    this.undoStack.push(c);
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack.length = 0;
    this.hooks.onHistory && this.hooks.onHistory();
  }
  canUndo() {
    return this.undoStack.length > 0;
  }
  canRedo() {
    return this.redoStack.length > 0;
  }
  finishTransient() {
    if (this.action) this.cancelAction();
    this.commitText();
    this.clearSelection();
  }
  undo() {
    this.finishTransient();
    const c = this.undoStack.pop();
    if (!c) return false;
    this.applyCmd(c, true);
    this.redoStack.push(c);
    this.hooks.onHistory && this.hooks.onHistory();
    return true;
  }
  redo() {
    this.finishTransient();
    const c = this.redoStack.pop();
    if (!c) return false;
    this.applyCmd(c, false);
    this.undoStack.push(c);
    this.hooks.onHistory && this.hooks.onHistory();
    return true;
  }
  applyCmd(c, undo) {
    if (c.type === 'items') {
      let focus = null;
      for (const ch of c.changes) {
        const page = ch.page;
        const rem = undo ? ch.added : ch.removed;
        const add = undo ? ch.removed : ch.added;
        const rs = new Set(rem.map((e) => e[1]));
        page.items = page.items.filter((it) => !rs.has(it));
        for (const [i, it] of add.slice().sort((x, y) => x[0] - y[0])) page.items.splice(Math.min(i, page.items.length), 0, it);
        const bb = unionBB(rem.map((e) => e[1]).concat(add.map((e) => e[1])));
        const pv = this.pvMap.get(page);
        if (pv) {
          this.repaintRegion(pv, bb, 3);
          if (!focus) focus = { pv, bb };
        }
        this.markDirty(page);
      }
      if (focus && isFinite(focus.bb[0])) this.ensureVisible(focus.pv, focus.bb);
    } else if (c.type === 'pages') {
      this.setPages(undo ? c.before : c.after);
      this.settleView();
    } else if (c.type === 'props') {
      for (const e of c.entries) {
        Object.assign(e.page, undo ? e.before : e.after);
        const pv = this.pvMap.get(e.page);
        if (pv) this.invalidatePage(pv);
        this.markDirty(e.page);
      }
      this.layout();
      this.settleView({ instant: true });
      this.requestRender();
    }
  }
  markDirty(page) {
    this.hooks.onDirty && this.hooks.onDirty(page);
  }
  removeItems(pv, items) {
    const set = new Set(items);
    this.beginEdit(pv);
    pv.page.items = pv.page.items.filter((it) => !set.has(it));
    this.commitEdits();
    this.repaintRegion(pv, unionBB(items), 3);
    this.markDirty(pv.page);
  }

  // ---------------------------------------------------------------- ページ操作
  setPages(pages) {
    const keep = new Set(pages);
    if (this.sel && !keep.has(this.sel.pv.page)) this.clearSelection();
    if (this.textEdit && !keep.has(this.textEdit.pv.page)) this.commitText();
    for (const pv of this.pvs) {
      if (keep.has(pv.page)) continue;
      this.dropTiles(pv);
      pv.cv.width = 0;
      pv.cv.height = 0;
      pv.el.remove();
      this.pvMap.delete(pv.page);
    }
    this.pvs = pages.map((p) => this.pvMap.get(p) || this.createPV(p));
    for (const pv of this.pvs) this.world.insertBefore(pv.el, this.ghost);
    this.layout();
    this.updateVisibility();
    this.requestRender();
    if (this.sel) this.updateSelUi();
    this.hooks.onPages && this.hooks.onPages(this.pages());
  }
  addPage(index, props = {}) {
    return this.addPages(index, [props])[0];
  }
  addPages(index, list) {
    this.finishTransient();
    const before = this.pages();
    const ref = before[clamp(index - 1, 0, before.length - 1)] || {};
    const pages = list.map((props) => {
      const p = newPageData(this.note.id, {
        template: props.template ?? ref.template,
        paper: props.paper ?? ref.paper,
        w: props.w ?? ref.w,
        h: props.h ?? ref.h,
        bg: props.bg || null,
      });
      return p;
    });
    const after = before.slice();
    after.splice(index, 0, ...pages);
    this.pushCmd({ type: 'pages', before, after });
    this.setPages(after);
    for (const p of pages) this.markDirty(p);
    return pages;
  }
  deletePage(index) {
    const before = this.pages();
    if (before.length <= 1) return false;
    this.finishTransient();
    const after = before.slice();
    after.splice(index, 1);
    this.pushCmd({ type: 'pages', before, after });
    this.setPages(after);
    this.settleView();
    return true;
  }
  duplicatePage(index) {
    const before = this.pages();
    const src = before[index];
    if (!src) return null;
    this.finishTransient();
    const page = { ...src, id: uid(), items: src.items.map((it) => cloneItem(it)) };
    const after = before.slice();
    after.splice(index + 1, 0, page);
    this.pushCmd({ type: 'pages', before, after });
    this.setPages(after);
    this.markDirty(page);
    return page;
  }
  movePage(from, to) {
    const before = this.pages();
    if (from === to || !before[from]) return;
    this.finishTransient();
    const after = before.slice();
    const [p] = after.splice(from, 1);
    after.splice(clamp(to, 0, after.length), 0, p);
    this.pushCmd({ type: 'pages', before, after });
    this.setPages(after);
  }
  setPageProps(pages, props) {
    this.finishTransient();
    const keys = Object.keys(props);
    const entries = pages.map((p) => {
      const b = {};
      for (const k of keys) b[k] = p[k];
      return { page: p, before: b, after: { ...props } };
    });
    const c = { type: 'props', entries };
    this.pushCmd(c);
    this.applyCmd(c, false);
  }
  clearPage(index) {
    const pv = this.pvs[index];
    if (!pv || !pv.page.items.length) return;
    this.finishTransient();
    this.beginEdit(pv);
    pv.page.items = [];
    this.commitEdits();
    this.invalidatePage(pv);
    this.markDirty(pv.page);
  }

  // ---------------------------------------------------------------- カーソル・エフェクト
  hover(e) {
    const tool = this.tool;
    if (e.pointerType === 'touch') return;
    if (e.pointerType === 'pen') this.lastPenHover = now();
    if (e.pointerType === 'mouse' && tool !== 'eraser') return this.hideCursor();
    const sp = this.sp(e);
    if (tool === 'eraser') this.showEraserCursor(sp);
    else if (tool === 'pen' || tool === 'hl') {
      const o = this.strokeOpts();
      this.cursor.style.setProperty('--c', o.color);
      this.showCursor(sp, Math.max(5, o.w * this.view.z), tool);
    } else return this.hideCursor();
    if (e.pointerType === 'pen') {
      clearTimeout(this._curT);
      this._curT = setTimeout(() => this.hideCursor(), 450);
    }
  }
  showCursor(sp, d, cls) {
    const c = this.cursor;
    c.className = 'pen-cursor on ' + cls;
    c.style.width = d + 'px';
    c.style.height = d + 'px';
    c.style.transform = `translate(${sp.x - d / 2}px, ${sp.y - d / 2}px)`;
  }
  showEraserCursor(sp) {
    const t = settings.tools.eraser;
    this.showCursor(sp, t.sizes[t.si], 'eraser');
  }
  hideCursor() {
    this.cursor.classList.remove('on');
  }
  pulseAt(sp) {
    if (!sp || reducedMotion()) return;
    const el = h('div', { class: 'snap-pulse' });
    el.style.left = sp.x + 'px';
    el.style.top = sp.y + 'px';
    this.stage.append(el);
    setTimeout(() => el.remove(), 700);
  }
  // スクリブルで消した線が「ふわっ」と崩れて消えるアニメーション
  dissolve(pv, items, raw, partial, hullPath) {
    this.clearFx();
    cancelAnimationFrame(this.fxAnim);
    if (reducedMotion()) return;
    const ctx = this.fxCtx;
    const [k, ox, oy] = this.inkTransform(pv);
    const z = this.view.z;
    const parts = [];
    const push = (x, y, c) => parts.push({
      x, y, c,
      vx: ((Math.random() - 0.5) * 0.34) / z,
      vy: (-Math.random() * 0.22 - 0.03) / z,
      r: (0.8 + Math.random() * 1.7) / z,
    });
    for (const it of items) {
      if (partial && partial.has(it)) continue;
      const p = it.pts, n = p.length / 3;
      const step = Math.max(1, Math.floor(n / 8));
      for (let i = 0; i < n; i += step) push(p[i * 3], p[i * 3 + 1], it.c);
    }
    const rn = raw.length >> 2;
    const rs = Math.max(1, Math.floor(rn / 26));
    for (let i = 0; i < rn; i += rs) push(raw[i * 4], raw[i * 4 + 1], 'rgba(150,150,160,0.9)');
    while (parts.length > 170) parts.splice((Math.random() * parts.length) | 0, 1);
    const dur = 480, t0 = now(), g = 0.0009 / z;
    const W = this.fxCv.width, H = this.fxCv.height;
    const frame = () => {
      const el = now() - t0, t = Math.min(1, el / dur);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (t >= 1) {
        this.fxAnim = 0;
        this.fxDirty = null;
        return;
      }
      const e = 1 - (1 - t) * (1 - t);
      ctx.setTransform(k, 0, 0, k, ox, oy);
      for (const it of items) {
        const b = it.bb, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, s = 1 + 0.1 * e;
        ctx.save();
        if (partial && partial.has(it) && hullPath) ctx.clip(hullPath);
        ctx.globalAlpha = (1 - e) * (it.k === 'hl' ? (it.a == null ? 0.4 : it.a) : 1);
        ctx.translate(cx, cy);
        ctx.scale(s, s);
        ctx.translate(-cx, -cy);
        if (it.k === 'hl') {
          ctx.strokeStyle = it.c;
          ctx.lineWidth = it.w;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.stroke(itemPath(it));
        } else {
          ctx.fillStyle = it.c;
          ctx.fill(itemPath(it));
        }
        ctx.restore();
      }
      ctx.globalAlpha = Math.max(0, 1 - t * 1.05);
      for (const p of parts) {
        ctx.fillStyle = p.c;
        ctx.beginPath();
        ctx.arc(p.x + p.vx * el, p.y + p.vy * el + 0.5 * g * el * el, p.r * (1 - t * 0.6), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      this.fxAnim = requestAnimationFrame(frame);
    };
    this.fxDirty = [0, 0, W, H];
    this.fxAnim = requestAnimationFrame(frame);
  }
}
