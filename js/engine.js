// キャンバスエンジン：表示・入力・ツール・取り消し
//
// 低遅延のための設計:
//  - 書いている線は画面サイズの専用キャンバス(ink)に、pointermove の中で即座に描く
//  - getCoalescedEvents で 240Hz の Apple Pencil 入力を全部拾う
//  - 予測描画（getPredictedEvents / 自前の速度外挿）で体感遅延を減らす
//  - ページは CSS transform でパン・ズーム（再描画なし）
//
// 画質のための設計:
//  - 画面に見えている部分を、いつでも表示倍率ちょうどの解像度で描く（詳しくは「描画」の章）
//  - ズームアウトしても解像度を落として見せることはしない。拡大しても線は滑らかに補間して描き直す
import { h, clamp, uid, isDarkColor, reducedMotion } from './util.js';
import { icon } from './icons.js';
import { settings, saveSettings } from './settings.js';
import {
  LiveStroke, strokePath, computeBB, hitStrokeCircle, hitStrokeSegment,
  splitStroke, itemPath, setItemPath, PEN_TYPES, pointInPoly, convexHull, insideFraction, cutStrokeByPoly,
} from './ink.js';
import { detectScribble } from './scribble.js';
import { recognizeShape, snapLineEnd, shapeGeometry } from './shapes.js';
import { renderPageTo, renderRegion, drawItem, itemBounds, hitBox, textHeight, LINE_H } from './render.js';
import { newPageData, cloneItem } from './store.js';

const GAP = 72; // ページ同士の間隔（横並び）
export const MAX_Z = 10;
const LIVE_COST = 12000; // ズーム中にフレームごとに描き直してよい重さの目安（見えている点の数）
const PREVIEW_PX = 1.1e6; // 予備の縮小版 1 枚のピクセル数
const SEL_PX = 10e6;
const EDGE = 18; // 拡大時にページの端を寄せる位置（px）
const HOLD_MS = 420; // 図形補正までの長押し時間
const LIVE_CHUNK = 160; // 書いている線の、毎回描き直す部分の最大の点数
const PULL = 120; // 最後のページで横に引っ張ってページを追加するまでの距離
const now = () => performance.now();
// 図形補正のうち角のあるもの（線を滑らかに補間しない）
const SHARP_KINDS = new Set(['line', 'polyline', 'rect', 'triangle', 'polygon']);

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
    this.tileRoot = h('div', { class: 'tile-root' });
    this.overWorld = h('div', { class: 'world over' }); // 選択中のもの（タイルより上）
    this.frozenCv = h('canvas', { class: 'ink-layer' });
    this.inkCv = h('canvas', { class: 'ink-layer' });
    this.inkWrap = h('div', { class: 'ink-wrap' }, this.frozenCv, this.inkCv);
    this.fxCv = h('canvas', { class: 'fx-layer' });
    this.selUi = h('div', { class: 'sel-ui' });
    this.cursor = h('div', { class: 'pen-cursor' });
    stage.append(this.world, this.tileRoot, this.overWorld, this.inkWrap, this.fxCv, this.selUi, this.cursor);
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
    this.layer = null;
    this.pool = [];
    this.T = 0;
    this.tcss = 0;
    this.maxTiles = 60;
    this.wheelZoomT = 0;
    this.animZoom = false;
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
    this.setTileGeom();
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
    const pv = { page, el, cv, pctx: null, ps: 0, pdirty: true, prow: 0, hidden: null, x: 0, y: 0, num };
    this.pvMap.set(page, pv);
    this.world.insertBefore(el, this.ghost);
    return pv;
  }
  unload() {
    if (this.action) this.cancelAction();
    this.commitText();
    this.clearSelection();
    this.dropLayer(this.layer);
    this.layer = null;
    clearTimeout(this._prevT);
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
    this.invalidateAll();
  }

  // ---------------------------------------------------------------- 表示（パン・ズーム）
  setView(tx, ty, z) {
    // 平行移動はデバイスピクセル単位に揃える（タイルを 1:1 で表示してにじませないため）
    const d = this.dpr;
    tx = Math.round(tx * d) / d;
    ty = Math.round(ty * d) / d;
    const v = this.view;
    v.tx = tx;
    v.ty = ty;
    v.z = z;
    const tf = `translate3d(${tx}px, ${ty}px, 0) scale(${z})`;
    this.world.style.transform = tf;
    this.overWorld.style.transform = tf;
    this.positionLayer();
    this.lastViewChange = now();
    this.onViewChanged();
  }
  onViewChanged() {
    this.requestRender();
    if (this.sel) this.updateSelUi();
    if (this.textEdit) this.positionText();
    if (this.hooks.onView) this.hooks.onView(this.view);
    clearTimeout(this._settleT);
    this._settleT = setTimeout(() => this.settle(), 140);
  }
  settle() {
    if (!this.loaded) return;
    if (this.tg || this.anim) {
      clearTimeout(this._settleT);
      this._settleT = setTimeout(() => this.settle(), 140);
      return;
    }
    this.requestRender();
    if (this.sel && this.selStale()) this.renderSelCanvas();
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
    this.animZoom = Math.abs(to.z - from.z) > 1e-6;
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
    this.animZoom = false;
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
  // 画質のための設計:
  //  - 画面に見えている部分を「表示倍率ちょうど（k = z × dpr）」の解像度で、デバイスピクセルの格子に
  //    ぴったり揃えたタイルに描く。小さく描いた画像を引き伸ばして見せることはしないので、
  //    最大までズームしてもぼやけ・モザイクが出ない
  //  - パンはタイルを整数ピクセル単位で動かすだけ（拡大縮小のにじみなし）。新しく見えた所はその場で描く
  //  - ズーム中も、描き直しが間に合うならフレームごとに描き直す。間に合わない重いページだけ、
  //    ズーム操作中は一時的に拡大表示して、指を離した瞬間に一度で描き直す（段階的な画質切り替えはしない）
  //  - 書き終えた線は「書いている時と同じ変換・同じパス」でタイルに描くので、ペンを離しても 1px も変わらない
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
  setTileGeom() {
    // タイル 1 枚 = 約 512 デバイスピクセル（CSS ピクセルで整数になる大きさにして、継ぎ目を出さない）
    const css = Math.max(64, Math.round(512 / this.dpr));
    const T = Math.round(css * this.dpr);
    if (T !== this.T) {
      this.dropLayer(this.layer);
      this.layer = null;
      for (const cv of this.pool) cv.width = cv.height = 0;
      this.pool = [];
    }
    this.tcss = css;
    this.T = T;
    const cols = Math.ceil((this.sw * this.dpr) / T) + 1, rows = Math.ceil((this.sh * this.dpr) / T) + 1;
    this.maxTiles = Math.max(24, Math.ceil(cols * rows * 3.2));
  }
  requestRender() {
    if (!this._rq) this._rq = requestAnimationFrame(() => this.renderTick());
  }
  renderAllNow() {
    if (this._rq) cancelAnimationFrame(this._rq);
    this._rq = 0;
    this.renderTick();
  }
  isZooming() {
    return !!((this.tg && this.tg.mode === 'pinch') || (this.anim && this.animZoom) || now() - this.wheelZoomT < 220);
  }
  // 見えている部分の描画の重さ（点の数など）→ ズーム中に毎フレーム描き直せるかの見積もりに使う
  visibleCost() {
    const vr = this.visibleRect();
    let c = 0;
    for (const pv of this.pvs) {
      if (!overlap(this.pvRect(pv), vr)) continue;
      c += 150;
      const x0 = vr.x - pv.x, y0 = vr.y - pv.y, x1 = x0 + vr.w, y1 = y0 + vr.h;
      for (const it of pv.page.items) {
        const b = it.bb;
        if (b[0] > x1 || b[2] < x0 || b[1] > y1 || b[3] < y0) continue;
        c += it.t === 's' ? it.pts.length / 3 + 4 : 60;
      }
    }
    return c;
  }
  renderTick() {
    this._rq = 0;
    if (!this.loaded || !this.sw || !this.T) return;
    const k = this.view.z * this.dpr;
    let L = this.layer;
    if (!L || L.k !== k) {
      const zooming = L && this.isZooming();
      // 重さ = 見えている点の数 ＋ タイル 1 枚あたりの手間
      // （描画は GPU 側で後から実行されるので JS の計測時間はあてにならない。固定の目安で判断する）
      if (!zooming || this.visibleCost() + this.visibleTileCount() * 250 <= LIVE_COST) {
        this.rebuildLayer(k);
      } else {
        // 重いページのズーム中：今のタイルを拡大縮小して見せ、操作が終わったら描き直す
        clearTimeout(this._zoomT);
        this._zoomT = setTimeout(() => this.requestRender(), 120);
        return;
      }
      L = this.layer;
    }
    this.fillVisible(L);
    if (!this.action && !this.isZooming()) {
      const busy = this.tg || this.anim;
      if (this.prefetch(L, now() + (busy ? 3 : 6))) this.requestRender();
      else if (!busy) this.schedulePreviews();
    }
    this.evictTiles(L);
    if (this.pool.length > 8) for (const cv of this.pool.splice(8)) cv.width = cv.height = 0;
  }
  positionLayer() {
    const L = this.layer;
    if (!L) return;
    const { tx, ty, z } = this.view;
    const s = (z * this.dpr) / L.k;
    L.el.style.transform = `translate3d(${tx}px, ${ty}px, 0)` + (Math.abs(s - 1) > 1e-9 ? ` scale(${s})` : '');
  }
  // 画面（＋余白 pad デバイスピクセル）に掛かるタイル番号の範囲。タイルはワールド座標 × k の空間に並ぶ
  tileSpan(padX = 0, padY = 0) {
    const T = this.T, d = this.dpr;
    const ox = Math.round(this.view.tx * d), oy = Math.round(this.view.ty * d);
    const W = Math.round(this.sw * d), H = Math.round(this.sh * d);
    return {
      i0: Math.floor((-ox - padX) / T),
      i1: Math.floor((W - ox + padX - 1) / T),
      j0: Math.floor((-oy - padY) / T),
      j1: Math.floor((H - oy + padY - 1) / T),
    };
  }
  visibleTileCount() {
    const s = this.tileSpan();
    return (s.i1 - s.i0 + 1) * (s.j1 - s.j0 + 1);
  }
  tileHasPage(k, i, j) {
    const T = this.T;
    const x0 = (i * T) / k, y0 = (j * T) / k, w = T / k;
    for (const pv of this.pvs) if (pv.x < x0 + w && pv.x + pv.page.w > x0 && pv.y < y0 + w && pv.y + pv.page.h > y0) return true;
    return false;
  }
  makeLayer(k) {
    const el = h('div', { class: 'tile-layer' });
    this.tileRoot.append(el);
    return { k, el, tiles: new Map() };
  }
  dropLayer(L) {
    if (!L) return;
    for (const t of L.tiles.values()) this.freeTile(t);
    L.tiles.clear();
    L.el.remove();
  }
  freeTile(t) {
    t.cv.remove();
    this.pool.push(t.cv);
  }
  getTile(L, i, j) {
    const key = i + ',' + j;
    let t = L.tiles.get(key);
    if (t) return t;
    const cv = this.pool.pop() || h('canvas', { class: 'tile' });
    if (cv.width !== this.T || cv.height !== this.T) {
      cv.width = this.T;
      cv.height = this.T;
    }
    const st = cv.style;
    st.left = i * this.tcss + 'px';
    st.top = j * this.tcss + 'px';
    st.width = this.tcss + 'px';
    st.height = this.tcss + 'px';
    L.el.append(cv);
    t = { key, i, j, cv, ctx: cv.getContext('2d'), dirty: true };
    L.tiles.set(key, t);
    return t;
  }
  renderTile(L, t) {
    const ctx = t.ctx, k = L.k, T = this.T;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, T, T);
    const x0 = (t.i * T) / k, y0 = (t.j * T) / k, w = T / k;
    for (const pv of this.pvs) {
      const px0 = Math.max(0, x0 - pv.x), py0 = Math.max(0, y0 - pv.y);
      const px1 = Math.min(pv.page.w, x0 + w - pv.x), py1 = Math.min(pv.page.h, y0 + w - pv.y);
      if (px1 <= px0 || py1 <= py0) continue;
      ctx.setTransform(k, 0, 0, k, pv.x * k - t.i * T, pv.y * k - t.j * T);
      renderRegion(ctx, pv.page, { x: px0, y: py0, w: px1 - px0, h: py1 - py0 }, k, { hidden: pv.hidden, assets: this.assets });
    }
    t.dirty = false;
  }
  rebuildLayer(k) {
    // 同じ処理の中で古いタイルを片付けて新しいタイルを描くので、途中の状態が画面に出ることはない
    this.dropLayer(this.layer);
    this.layer = this.makeLayer(k);
    this.positionLayer();
    this.fillVisible(this.layer);
  }
  // 見えているタイルは必ずその場で描く（描きかけ・低画質の状態を見せない）
  fillVisible(L) {
    const s = this.tileSpan();
    for (let j = s.j0; j <= s.j1; j++) {
      for (let i = s.i0; i <= s.i1; i++) {
        const t = L.tiles.get(i + ',' + j);
        if (t ? !t.dirty : !this.tileHasPage(L.k, i, j)) continue;
        this.renderTile(L, t || this.getTile(L, i, j));
      }
    }
  }
  // 空き時間に、画面のまわり → 左右のページ（スワイプ先）の順で先に描いておく
  prefetch(L, deadline) {
    const T = this.T;
    const vis = this.tileSpan();
    const ci = (vis.i0 + vis.i1) / 2, cj = (vis.j0 + vis.j1) / 2;
    for (const s of [this.tileSpan(T, T), this.tileSpan(Math.round(this.sw * this.dpr), T)]) {
      const list = [];
      for (let j = s.j0; j <= s.j1; j++) {
        for (let i = s.i0; i <= s.i1; i++) {
          const t = L.tiles.get(i + ',' + j);
          if (t ? !t.dirty : !this.tileHasPage(L.k, i, j)) continue;
          list.push({ i, j, t, d: (i - ci) * (i - ci) + (j - cj) * (j - cj) });
        }
      }
      list.sort((a, b) => a.d - b.d);
      for (const c of list) {
        if (now() > deadline) return true;
        if (!c.t && L.tiles.size >= this.maxTiles) return false;
        this.renderTile(L, c.t || this.getTile(L, c.i, c.j));
      }
    }
    return false;
  }
  evictTiles(L) {
    if (L.tiles.size <= this.maxTiles) return;
    const vis = this.tileSpan();
    const ci = (vis.i0 + vis.i1) / 2, cj = (vis.j0 + vis.j1) / 2;
    const d = (t) => (t.i - ci) * (t.i - ci) + (t.j - cj) * (t.j - cj);
    const arr = [...L.tiles.values()].sort((a, b) => d(b) - d(a));
    for (const t of arr) {
      if (L.tiles.size <= this.maxTiles * 0.85) break;
      if (t.i >= vis.i0 && t.i <= vis.i1 && t.j >= vis.j0 && t.j <= vis.j1) continue;
      L.tiles.delete(t.key);
      this.freeTile(t);
    }
  }
  // bb（ページ座標）に掛かっているタイル
  tilesFor(L, pv, bb, pad) {
    const k = L.k, T = this.T;
    const i0 = Math.floor(((pv.x + bb[0] - pad) * k) / T), i1 = Math.floor(((pv.x + bb[2] + pad) * k) / T);
    const j0 = Math.floor(((pv.y + bb[1] - pad) * k) / T), j1 = Math.floor(((pv.y + bb[3] + pad) * k) / T);
    const out = [];
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > L.tiles.size) {
      for (const t of L.tiles.values()) if (t.i >= i0 && t.i <= i1 && t.j >= j0 && t.j <= j1) out.push(t);
    } else {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const t = L.tiles.get(i + ',' + j);
          if (t) out.push(t);
        }
      }
    }
    return out;
  }
  invalidatePage(pv) {
    const L = this.layer;
    if (L) for (const t of this.tilesFor(L, pv, [0, 0, pv.page.w, pv.page.h], 1)) t.dirty = true;
    pv.pdirty = true;
    this.requestRender();
  }
  invalidateAll() {
    if (this.layer) for (const t of this.layer.tiles.values()) t.dirty = true;
    for (const pv of this.pvs) pv.pdirty = true;
    this.requestRender();
  }
  // ページの一部だけ描き直す（デバイスピクセルの境目に揃えるので継ぎ目が出ない）
  repaintRegion(pv, bb, pad = 2) {
    if (!bb || !isFinite(bb[0])) return;
    const opts = { hidden: pv.hidden, assets: this.assets };
    const bx0 = Math.max(0, bb[0] - pad), by0 = Math.max(0, bb[1] - pad);
    const bx1 = Math.min(pv.page.w, bb[2] + pad), by1 = Math.min(pv.page.h, bb[3] + pad);
    if (bx1 <= bx0 || by1 <= by0) return;
    const L = this.layer;
    if (L) {
      const k = L.k, T = this.T;
      const X0 = Math.floor((pv.x + bx0) * k), Y0 = Math.floor((pv.y + by0) * k);
      const X1 = Math.ceil((pv.x + bx1) * k), Y1 = Math.ceil((pv.y + by1) * k);
      for (const t of this.tilesFor(L, pv, bb, pad)) {
        if (t.dirty) continue;
        const ax = Math.max(X0, t.i * T), ay = Math.max(Y0, t.j * T);
        const ex = Math.min(X1, (t.i + 1) * T), ey = Math.min(Y1, (t.j + 1) * T);
        if (ex <= ax || ey <= ay) continue;
        const ctx = t.ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(ax - t.i * T, ay - t.j * T, ex - ax, ey - ay);
        ctx.setTransform(k, 0, 0, k, pv.x * k - t.i * T, pv.y * k - t.j * T);
        const rx0 = Math.max(0, ax / k - pv.x), ry0 = Math.max(0, ay / k - pv.y);
        const rx1 = Math.min(pv.page.w, ex / k - pv.x), ry1 = Math.min(pv.page.h, ey / k - pv.y);
        if (rx1 > rx0 && ry1 > ry0) renderRegion(ctx, pv.page, { x: rx0, y: ry0, w: rx1 - rx0, h: ry1 - ry0 }, k, opts);
      }
    }
    if (pv.ps && !pv.pdirty) {
      const sx = pv.cv.width / pv.page.w, sy = pv.cv.height / pv.page.h;
      const x0 = Math.floor(bx0 * sx) / sx, y0 = Math.floor(by0 * sy) / sy;
      const x1 = Math.min(pv.page.w, Math.ceil(bx1 * sx) / sx), y1 = Math.min(pv.page.h, Math.ceil(by1 * sy) / sy);
      const done = pv.prow / sy;
      if (y0 < done) {
        pv.pctx.setTransform(sx, 0, 0, sy, 0, 0);
        renderRegion(pv.pctx, pv.page, { x: x0, y: y0, w: x1 - x0, h: Math.min(y1, done) - y0 }, sx, opts);
      }
    }
  }
  // 新しく増えたもの（書いた線・貼ったもの）を上から描き足す
  drawNew(pv, it) {
    const dark = isDarkColor(pv.page.paper);
    const L = this.layer;
    if (L) {
      const k = L.k, T = this.T;
      for (const t of this.tilesFor(L, pv, it.bb, 2)) {
        if (t.dirty) continue;
        const ctx = t.ctx;
        ctx.setTransform(k, 0, 0, k, pv.x * k - t.i * T, pv.y * k - t.j * T);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, pv.page.w, pv.page.h);
        ctx.clip();
        drawItem(ctx, it, dark, this.assets, k);
        ctx.restore();
      }
    }
    if (pv.ps && !pv.pdirty) {
      const sx = pv.cv.width / pv.page.w, sy = pv.cv.height / pv.page.h;
      const c = pv.pctx;
      c.setTransform(sx, 0, 0, sy, 0, 0);
      c.save();
      c.beginPath();
      c.rect(0, 0, pv.page.w, Math.min(pv.page.h, pv.prow / sy));
      c.clip();
      drawItem(c, it, dark, this.assets, sx);
      c.restore();
    }
  }
  assetLoaded(id) {
    for (const pv of this.pvs) {
      if (pv.page.bg === id || pv.page.items.some((it) => it.t === 'i' && it.asset === id)) this.invalidatePage(pv);
    }
    if (this.sel && this.sel.items.some((it) => it.asset === id)) this.renderSelCanvas();
  }

  // ---- 予備の縮小版（重いページを素早くズームアウトしたとき、描き直すまでの間だけ見える）
  schedulePreviews(delay = 400) {
    clearTimeout(this._prevT);
    this._prevT = setTimeout(() => this.previewTick(), delay);
  }
  previewTick() {
    if (!this.loaded) return;
    if (this.tg || this.anim || this.action || now() - this.lastViewChange < 300) return this.schedulePreviews();
    const fi = this.focusIndex();
    const deadline = now() + 4;
    for (const i of [fi, fi + 1, fi - 1, fi + 2, fi - 2]) {
      const pv = this.pvs[i];
      if (pv && this.previewStep(pv, deadline)) return this.schedulePreviews(30);
    }
    this.pvs.forEach((pv, i) => {
      if (Math.abs(i - fi) > 2 && pv.ps) {
        pv.cv.width = pv.cv.height = 0;
        pv.ps = 0;
        pv.pdirty = true;
      }
    });
  }
  // 少しずつ（帯ごとに）描く。まだ残っていれば true
  previewStep(pv, deadline) {
    const page = pv.page;
    if (!pv.ps || pv.pdirty) {
      const ps = Math.min(1.25, Math.sqrt(PREVIEW_PX / (page.w * page.h)));
      const W = Math.max(1, Math.round(page.w * ps)), H = Math.max(1, Math.round(page.h * ps));
      if (pv.cv.width !== W || pv.cv.height !== H) {
        pv.cv.width = W;
        pv.cv.height = H;
      }
      if (!pv.pctx) pv.pctx = pv.cv.getContext('2d');
      pv.ps = ps;
      pv.pdirty = false;
      pv.prow = 0;
    }
    const W = pv.cv.width, H = pv.cv.height;
    if (pv.prow >= H) return false;
    const sx = W / page.w, sy = H / page.h;
    const opts = { hidden: pv.hidden, assets: this.assets };
    while (pv.prow < H) {
      if (now() > deadline) return true;
      const y0 = pv.prow, y1 = Math.min(H, y0 + 48);
      pv.pctx.setTransform(sx, 0, 0, sy, 0, 0);
      renderRegion(pv.pctx, page, { x: 0, y: y0 / sy, w: page.w, h: (y1 - y0) / sy }, sx, opts);
      pv.prow = y1;
    }
    return false;
  }
  // 閉じるアニメーション用のページ画像
  pageImage(i, w) {
    const pv = this.pvs[i];
    if (!pv) return null;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = Math.round((w * pv.page.h) / pv.page.w);
    const ctx = c.getContext('2d');
    if (pv.ps && !pv.pdirty && pv.prow >= pv.cv.height) ctx.drawImage(pv.cv, 0, 0, c.width, c.height);
    else renderPageTo(ctx, pv.page, c.width / pv.page.w, c.height / pv.page.h, { assets: this.assets });
    return c;
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
  pressureOf(ev, type) {
    if ((ev.pointerType || type) !== 'pen') return 0.3;
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
    // ペンが新しく画面に触れた＝前の線は確実に終わっている（ペンを離した通知を取りこぼしても、
    // 2 本の線が 1 本につながって判定されることがないように、ここで前の線を確定させる）
    const prev = this.action;
    if (prev && type === 'pen' && prev.pointerType === 'pen') this.endAction(prev, null, false);
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
    if (a && a.pointerId === e.pointerId) {
      // ペンが浮いている（押していない）移動が続いたら、離した通知を取りこぼしたとみなして線を終える
      if (e.pointerType === 'pen' && e.buttons === 0 && !(e.pressure > 0)) {
        if (++a.upMoves >= 3) return this.onUp(e, false);
        return;
      }
      a.upMoves = 0;
      return this.moveAction(a, e);
    }
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
      this.wheelZoomT = now();
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
      if (tn - (this.lastPenUp || 0) < 350 || tn - (this.lastPenHover || 0) < 200) return;
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
          this.requestRender(); // 指を離した瞬間に、今の倍率ちょうどで描き直す
          this.hooks.onZoomEnd && this.hooks.onZoomEnd();
        }
      } else this.rebaseGesture();
    }
    if (this.touches.size === 0 && this.tapSess) {
      const s = this.tapSess;
      this.tapSess = null;
      // 書いた直後に手のひらが触れて離れたのを「2 本指タップ（元に戻す）」と誤認しない
      const palmy = s.t0 - (this.lastPenUp || 0) < 500;
      if (!cancel && !s.moved && !s.drew && now() - s.t0 < 330) {
        if (s.max === 2 && settings.twoFingerUndo) {
          if (!palmy && this.undo()) this.hooks.onGesture && this.hooks.onGesture('undo');
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
    const base = { pointerId: e.pointerId, pointerType: e.pointerType, t0: now(), sp0: sp, kind: 'none', upMoves: 0 };
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
    const a = (this.action = {
      ...base, kind: 'stroke', pv, live, o, scribble: false, targets: null, scrN: 0, scrTested: 1, shape: null, holdT: 0, anchor: null,
      lastT: -Infinity, seen: new Set(), seenQ: [], dropped: 0, track: [], log: [],
    });
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
    this.feed(a, [e], e);
    this.drawLive(a, null);
    if (settings.holdShape) this.armHold(a, this.sp(e));
  }
  // 入力点を線に加える
  //  - iPad Safari の高精度入力（coalesced events）は新しい機能で、時刻や属性が欠けることがある。
  //    時刻は本体のイベントの時刻を基準に付け直し、同じ点が二重に届いたもの・古い点が後から届いたものは捨てる
  //    （線を往復でなぞり直したようなデータになって、ぐしゃぐしゃ消しの誤判定の原因になるため）
  //  - 判定用に、本体のイベント（1 回の通知につき 1 点）だけの記録 track も別に取っておく
  feed(a, evs, e) {
    const pv = a.pv;
    const { tx, ty, z } = this.view;
    const L = this.rect.left, T = this.rect.top;
    const T0 = e.timeStamp, last = evs[evs.length - 1].timeStamp;
    const rec = [Math.round(T0), evs.length];
    for (const ev of evs) {
      const d = last - ev.timeStamp;
      const t = d >= 0 && d < 250 ? T0 - d : T0;
      const x = (ev.clientX - L - tx) / z - pv.x, y = (ev.clientY - T - ty) / z - pv.y;
      rec.push(Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(ev.timeStamp * 10) / 10);
      if (!isFinite(x) || !isFinite(y) || t < a.lastT - 0.5) {
        a.dropped++;
        continue;
      }
      const key = Math.round(x * 256) + ',' + Math.round(y * 256);
      if (a.seen.has(key)) {
        a.dropped++;
        continue;
      }
      a.seen.add(key);
      a.seenQ.push(key);
      if (a.seenQ.length > 256) a.seen.delete(a.seenQ.shift());
      if (t > a.lastT) a.lastT = t;
      a.live.add(x, y, this.pressureOf(ev, e.pointerType), t);
    }
    if (a.log.length < 300) a.log.push(rec);
    const mx = (e.clientX - L - tx) / z - pv.x, my = (e.clientY - T - ty) / z - pv.y;
    const tr = a.track, n = tr.length;
    if (isFinite(mx) && isFinite(my) && (!n || (T0 > tr[n - 1] && (mx !== tr[n - 4] || my !== tr[n - 3])))) tr.push(mx, my, 0, T0);
  }
  moveStroke(a, e) {
    const evs = coalesced(e);
    // ペンを離した通知が届かずに次の線を書き始めた場合（間が空いて、離れた場所から急に続く）は、
    // 前の線をそこで確定して新しい線として書き始める（2 本の線が 1 本につながらないように）
    // （判定には信頼できる本体のイベントの時刻と位置だけを使う）
    const tr = a.track, TL = tr.length;
    if (TL && e.pointerType === 'pen' && !a.shape) {
      const [x, y] = this.localPt(e, a.pv);
      if (e.timeStamp - tr[TL - 1] > 110 && Math.hypot(x - tr[TL - 4], y - tr[TL - 3]) * this.view.z > 10) {
        this.endAction(a, null, false);
        this.begin(e);
        return;
      }
    }
    if (a.shape) {
      const [x, y] = this.localPt(evs[evs.length - 1], a.pv);
      this.adjustShape(a, x, y);
      this.drawLive(a, null);
      return;
    }
    this.feed(a, evs, e);
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
    const paint = (c, path) => {
      if (hl) {
        c.strokeStyle = a.o.color;
        c.lineWidth = a.o.w;
        c.lineCap = 'round';
        c.lineJoin = 'round';
        c.stroke(path);
      } else {
        c.fillStyle = a.o.color;
        c.fill(path);
      }
    };
    if (a.shape) this.clearInk();
    else {
      this.clearTip();
      // 長い線は前半を別キャンバスへ。前半全体を 1 本の輪郭として描き直すので継ぎ目が残らない
      const n = live.count;
      if (n - live.frozenN > LIVE_CHUNK) {
        const F = n - 1;
        const f = this.frozenCtx;
        const d = this.frozenDirty;
        if (d) {
          f.setTransform(1, 0, 0, 1, 0, 0);
          f.clearRect(d[0], d[1], d[2] - d[0], d[3] - d[1]);
        }
        f.setTransform(k, 0, 0, k, ox, oy);
        f.save();
        f.beginPath();
        f.rect(0, 0, pv.page.w, pv.page.h);
        f.clip();
        paint(f, live.prefixPath(F));
        f.restore();
        this.frozenDirty = this.devRect(pv, live.bb, a.o.w + 3);
        live.frozenN = F;
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
      // 確定後と同じパス（同じ補間）で描く
      const path = strokePath(pts, hl, k, SHARP_KINDS.has(a.shape.kind));
      a.shape.path = path;
      paint(ctx, path);
      bb = computeBB(pts);
    } else {
      // まだ凍結していない部分とペン先を 1 本の輪郭にして 1 回で塗る（確定後と同じ形・同じ見た目）
      paint(ctx, live.chunkPath(pred));
      bb = live.chunkBB(pred);
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
  // ぐしゃぐしゃ判定：高精度入力の線と、本体のイベントだけの線の「両方」がぐしゃぐしゃに見えるときだけ
  // （片方の入力データがおかしくても、普通の字を消してしまわないように）
  isScribble(a, info) {
    const z = this.view.z, sens = settings.scribbleSens;
    const r1 = detectScribble(a.live.raw, z, sens, info);
    return r1 && a.track.length >= 32 && detectScribble(a.track, z, sens);
  }
  checkScribble(a, force) {
    const raw = a.live.raw;
    const n = raw.length >> 2;
    if (!a.scribble) {
      if (!force && (n < 8 || n - a.scrN < Math.max(3, n >> 5))) return;
      a.scrN = n;
      if (!this.isScribble(a)) return;
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
        ctx.stroke(itemPath(it, k));
      } else {
        ctx.fillStyle = 'rgba(255,72,60,0.92)';
        ctx.fill(itemPath(it, k));
      }
      ctx.restore();
      this.markFx(pv, it.bb, 4);
    }
  }
  // 不具合調査用：最近の数本の線の入力データ（設定 → 入力データをコピー）
  logStroke(a, info) {
    if (!this.inputLog) this.inputLog = [];
    const tr = [];
    for (let i = 0; i < a.track.length; i += 4) tr.push(Math.round(a.track[i] * 100) / 100, Math.round(a.track[i + 1] * 100) / 100, Math.round(a.track[i + 3]));
    this.inputLog.push({ at: new Date().toISOString(), z: +this.view.z.toFixed(3), sens: settings.scribbleSens, scribble: !!a.scribble, info, dropped: a.dropped, rawN: a.live.raw.length >> 2, track: tr, events: a.log });
    if (this.inputLog.length > 3) this.inputLog.shift();
  }
  inputLogText() {
    return JSON.stringify({ ua: navigator.userAgent, dpr: this.dpr, strokes: this.inputLog || [] });
  }
  endStroke(a) {
    clearTimeout(a.holdT);
    clearTimeout(a.predT);
    const pv = a.pv;
    // 書き終わった時点でもう一度ぐしゃぐしゃ判定（途中で判定しきれなかった場合）
    if (!a.scribble && !a.shape && settings.scribble && a.o.kind === 'pen') this.checkScribble(a, true);
    // 書き終わった線全体でもう一度確認。ぐしゃぐしゃに見えなくなっていたら、普通の線として残す
    const info = {};
    if (a.scribble && !this.isScribble(a, info)) {
      a.scribble = false;
      a.targets = null;
      this.clearFx();
      this.resetInkStyle();
    }
    this.logStroke(a, info);
    if (a.scribble && a.targets && a.targets.size) {
      const targets = [...a.targets];
      this.clearInk();
      this.resetInkStyle();
      this.scribbleErase(pv, targets, a.live.raw);
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
    if (a.shape && SHARP_KINDS.has(a.shape.kind)) it.sh = 1; // 角のある図形は補間しない
    it.bb = computeBB(it.pts);
    // 書いている時に表示していたパスをそのまま使う → ペンを離しても見た目が変わらない
    const k = this.view.z * this.dpr;
    if (a.shape) setItemPath(it, a.shape.path, k);
    else if (a.live.count > 1) setItemPath(it, a.live.fullPath(), k);
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
    a.path = strokePath(pts, false, k, a.o.kind !== 'ellipse');
    ctx.fill(a.path);
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
    if (a.o.kind !== 'ellipse') it.sh = 1;
    if (a.path) setItemPath(it, a.path, z * this.dpr);
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
    for (const it of st.items) drawItem(ctx, it, dark, st.assets, k * sc);
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
    this.overWorld.append(el);
    this.sel = { pv, items, bb: unionBB(items), m: { tx: 0, ty: 0, s: 1, r: 0 }, el, k: 0, rect: null };
    pv.hidden = new Set(items);
    this.repaintRegion(pv, this.sel.bb, 3);
    this.renderSelCanvas();
    this.buildSelUi();
    this.updateSelUi();
    this.hooks.onSelection && this.hooks.onSelection(true);
  }
  // 選択したものも、表示倍率ちょうどの解像度・デバイスピクセルに揃えて描く（見えている付近だけ）
  selRegion() {
    const s = this.sel, pad = 6;
    const vr = this.nearRect(0.15);
    const x0 = Math.max(s.pv.x + s.bb[0] - pad, vr.x), y0 = Math.max(s.pv.y + s.bb[1] - pad, vr.y);
    const x1 = Math.min(s.pv.x + s.bb[2] + pad, vr.x + vr.w), y1 = Math.min(s.pv.y + s.bb[3] + pad, vr.y + vr.h);
    return { x0, y0, x1: Math.max(x0 + 1 / this.view.z, x1), y1: Math.max(y0 + 1 / this.view.z, y1) };
  }
  selStale() {
    const s = this.sel;
    if (!s.rect || Math.abs(s.k - this.view.z * this.dpr) > 1e-9) return true;
    const r = this.selRegion(), c = s.rect;
    return r.x0 < c.x0 - 0.5 || r.y0 < c.y0 - 0.5 || r.x1 > c.x1 + 0.5 || r.y1 > c.y1 + 0.5;
  }
  renderSelCanvas() {
    const s = this.sel;
    if (!s) return;
    const r = this.selRegion();
    let k = this.view.z * this.dpr;
    if ((r.x1 - r.x0) * (r.y1 - r.y0) * k * k > SEL_PX) k = Math.sqrt(SEL_PX / ((r.x1 - r.x0) * (r.y1 - r.y0)));
    const X0 = Math.floor(r.x0 * k), Y0 = Math.floor(r.y0 * k);
    const W = Math.max(1, Math.ceil(r.x1 * k) - X0), H = Math.max(1, Math.ceil(r.y1 * k) - Y0);
    s.el.width = W;
    s.el.height = H;
    const st = s.el.style;
    st.left = X0 / k + 'px';
    st.top = Y0 / k + 'px';
    st.width = W / k + 'px';
    st.height = H / k + 'px';
    // 回転・拡大の中心は選択範囲の中心
    const cx = s.pv.x + (s.bb[0] + s.bb[2]) / 2, cy = s.pv.y + (s.bb[1] + s.bb[3]) / 2;
    st.transformOrigin = `${cx - X0 / k}px ${cy - Y0 / k}px`;
    const ctx = s.el.getContext('2d');
    ctx.setTransform(k, 0, 0, k, s.pv.x * k - X0, s.pv.y * k - Y0);
    const dark = isDarkColor(s.pv.page.paper);
    for (const it of s.items) drawItem(ctx, it, dark, this.assets, k);
    s.k = k;
    s.rect = { x0: X0 / k, y0: Y0 / k, x1: (X0 + W) / k, y1: (Y0 + H) / k };
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
    for (const it of s.items) drawItem(ctx, it, dark, this.assets, sc);
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
      pv.cv.width = 0;
      pv.cv.height = 0;
      pv.el.remove();
      this.pvMap.delete(pv.page);
    }
    this.pvs = pages.map((p) => this.pvMap.get(p) || this.createPV(p));
    for (const pv of this.pvs) this.world.insertBefore(pv.el, this.ghost);
    this.layout();
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
      const template = props.template ?? ref.template;
      const p = newPageData(this.note.id, {
        template,
        paper: props.paper ?? ref.paper,
        w: props.w ?? ref.w,
        h: props.h ?? ref.h,
        bg: props.bg || null,
        sp: props.sp !== undefined ? props.sp : template === ref.template ? ref.sp : null,
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
          ctx.stroke(itemPath(it, k));
        } else {
          ctx.fillStyle = it.c;
          ctx.fill(itemPath(it, k));
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
