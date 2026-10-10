// エディタ画面（ヘッダー・ツールドック・ページナビ・スタンプ・書き出し・保存）
import { h, clamp, debounce, uid, canvasToBlob, shareFile, safeName, luminance, reducedMotion } from './util.js';
import { icon } from './icons.js';
import { settings, saveSettings } from './settings.js';
import * as store from './store.js';
import * as db from './db.js';
import { Engine, clipboard, translateItem } from './engine.js';
import * as ui from './ui.js';
import { renderThumb } from './render.js';
import { PEN_TYPES, LiveStroke } from './ink.js';
import { SHAPE_KINDS, shapeSvg } from './shapes.js';
import * as exporter from './exporter.js';
import { templateGrid, paperSwatches, sizeChips, sizeKeyOf } from './pickers.js';

const TOOLS = [
  { id: 'pen', icon: 'pen', label: 'ペン (P)' },
  { id: 'hl', icon: 'highlighter', label: '蛍光ペン (H)' },
  { id: 'eraser', icon: 'eraser', label: '消しゴム (E)' },
  { id: 'lasso', icon: 'lasso', label: 'なげなわ (L)' },
  { id: 'shape', icon: 'shapes', label: '図形 (S)' },
  { id: 'text', icon: 'text', label: 'テキスト (T)' },
  { id: 'stamp', icon: 'stamp', label: 'スタンプ (M)' },
];
const SHAPE_LABEL = {
  line: '直線', rect: '四角形', triangle: '三角形', ellipse: '円', polygon: '多角形', polyline: '折れ線', arc: '弧', curve: '曲線',
};
const FILL_LABEL = { none: '塗りなし', tint: 'うすく塗る', solid: '塗りつぶし' };

function ib(name, label, fn, cls = '') {
  const b = h('button', { class: 'ib ' + cls, title: label, 'aria-label': label, html: icon(name) });
  if (fn) b.addEventListener('click', (e) => fn(b, e));
  return b;
}

function loadImg(img, src, ms = 10000) {
  return new Promise((res) => {
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      res(img.naturalWidth > 0);
    };
    img.onload = fin;
    img.onerror = fin;
    setTimeout(fin, ms);
    img.src = src;
  });
}

// 画像を読み込んで、扱いやすい大きさに縮小した Blob にする
export async function prepareImage(file, { max = 2200, q = 0.9 } = {}) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await loadImg(img, url);
    const w0 = img.naturalWidth, h0 = img.naturalHeight;
    if (!w0 || !h0) throw new Error('bad image');
    const s = Math.min(1, max / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * s)), hh = Math.max(1, Math.round(h0 * s));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = hh;
    const ctx = cv.getContext('2d');
    let alpha = false;
    if (/png|gif|webp/.test(file.type)) {
      const t = document.createElement('canvas');
      t.width = t.height = 48;
      const tc = t.getContext('2d');
      tc.drawImage(img, 0, 0, 48, 48);
      const d = tc.getImageData(0, 0, 48, 48).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { alpha = true; break; }
    }
    if (!alpha) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, hh);
    }
    ctx.drawImage(img, 0, 0, w, hh);
    const blob = await canvasToBlob(cv, alpha ? 'image/png' : 'image/jpeg', q);
    cv.width = cv.height = 0;
    return { blob, w, h: hh };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// 画像の読み込み（待たずにすぐ返す。読み込み完了は entry.ready / onReady で通知）
export function loadAssetEntry(a, onReady) {
  const url = URL.createObjectURL(a.blob);
  const img = new Image();
  const entry = { img, url, w: a.w, h: a.h, blob: a.blob, ok: false };
  entry.ready = loadImg(img, url).then((ok) => {
    entry.ok = ok;
    if (onReady) onReady(entry);
    return entry;
  });
  return entry;
}

// 画像の縦横比に合わせたページの大きさ（長い辺を A4 の長辺に）
export function imagePageSize(w, hh) {
  const L = 1123;
  return w >= hh ? { w: L, h: Math.round((L * hh) / w) } : { w: Math.round((L * w) / hh), h: L };
}

// 画像ファイル → ページの元データ（背景画像アセット付き）
export async function imagesToPageSpecs(files, noteId) {
  const specs = [], assets = [];
  for (const f of files) {
    try {
      const { blob, w, h: hh } = await prepareImage(f, { max: 3200, q: 0.92 });
      const id = uid();
      assets.push({ id, noteId, blob, w, h: hh, type: blob.type });
      const sz = imagePageSize(w, hh);
      specs.push({ template: 'blank', paper: '#ffffff', w: sz.w, h: sz.h, bg: id });
    } catch (e) {
      console.warn(e);
    }
  }
  return { specs, assets };
}

export class Editor {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.note = null;
    this.dirty = new Set();
    this.knownIds = [];
    this.saving = null;
    this.saveAgain = false;
    this.pageVer = new WeakMap();
    this.thumbCache = new WeakMap();
    this.prevTool = 'pen';
    this.stamps = [];
    this.stampsLoaded = false;
    this.stampCache = new Map();
    this.stampAssetMap = new Map();
    this.navOpen = false;
    this.saveSoon = debounce(() => this.save(), 900);
    this.saveViewSoon = debounce(() => this.saveView(), 1500);
    this.build();
  }

  // ---------------------------------------------------------------- 構築
  build() {
    const r = this.root;
    this.stage = h('div', { class: 'stage' });

    this.backBtn = ib('back', 'ノート一覧へ', () => this.app.requestClose(), 'back');
    this.titleText = h('span', { class: 'ed-title-t' });
    this.titleBtn = h('button', { class: 'ed-title' }, this.titleText, h('span', { class: 'ed-title-c', html: icon('chev-down') }));
    this.titleBtn.addEventListener('click', () => this.noteMenu(this.titleBtn));
    this.undoBtn = ib('undo', '元に戻す', () => this.engine.undo());
    this.redoBtn = ib('redo', 'やり直す', () => this.engine.redo());
    this.fingerBtn = ib('hand', '指で描く', () => this.toggleFinger());
    this.addPageBtn = ib('page-add', 'ページを追加', null);
    ui.pressable(this.addPageBtn, {
      onTap: () => this.quickAddPage(),
      onLong: () => this.pageSetup('add', this.engine.currentIndex() + 1),
    });
    this.moreBtn = ib('more', 'その他', () => this.moreMenu(this.moreBtn));
    this.head = h(
      'header',
      { class: 'ed-head glass' },
      this.backBtn,
      this.titleBtn,
      h('div', { class: 'grow' }),
      this.undoBtn,
      this.redoBtn,
      h('span', { class: 'hsep' }),
      this.fingerBtn,
      this.addPageBtn,
      this.moreBtn
    );

    // ツールドック
    this.dock = h('div', { class: 'dock glass' });
    this.dockWrap = h('div', { class: 'dock-wrap' }, this.dock);
    this.grip = h('div', { class: 'dock-grip', title: 'ドラッグで移動', html: icon('grip') });
    this.toolsEl = h('div', { class: 'dock-tools' });
    this.toolPill = h('span', { class: 'tool-pill' });
    this.toolsEl.append(this.toolPill);
    this.toolBtns = {};
    for (const t of TOOLS) {
      const b = h('button', { class: 'tool', title: t.label, 'aria-label': t.label, html: icon(t.icon) });
      b.addEventListener('click', () => this.onToolTap(t.id, b));
      this.toolsEl.append(b);
      this.toolBtns[t.id] = b;
    }
    const imgBtn = h('button', { class: 'tool', title: '画像を挿入', 'aria-label': '画像を挿入', html: icon('image') });
    imgBtn.addEventListener('click', () => this.pickImage());
    this.toolsEl.append(imgBtn);
    this.optsEl = h('div', { class: 'dock-opts' });
    this.dock.append(this.grip, this.toolsEl, h('span', { class: 'dock-sep' }), this.optsEl);

    // 右上のページナビ（押すと左へ展開）
    this.pnNum = h('span', { class: 'pn-num' });
    this.pnToggle = h('button', { class: 'pn-toggle', title: 'ページ一覧', 'aria-label': 'ページ一覧' }, h('span', { class: 'pn-ic', html: icon('pages') }), this.pnNum);
    this.pnToggle.addEventListener('click', () => this.togglePageNav());
    this.pnList = h('div', { class: 'pn-list' });
    this.pnAdd = h('button', { class: 'pn-add', title: 'ページを追加', html: icon('plus') });
    ui.pressable(this.pnAdd, {
      onTap: () => this.quickAddPage(this.engine.pages().length),
      onLong: () => this.pageSetup('add', this.engine.pages().length),
    });
    this.pnStrip = h('div', { class: 'pn-strip' }, this.pnList, this.pnAdd);
    this.pageNav = h('div', { class: 'page-nav glass' }, this.pnStrip, this.pnToggle);

    this.zoomInd = h('div', { class: 'zoom-ind' });
    this.fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true });
    this.fileInput.addEventListener('change', () => {
      const f = this.fileInput.files && this.fileInput.files[0];
      this.fileInput.value = '';
      if (f) this.insertImageFile(f);
    });
    r.append(this.stage, this.head, this.dockWrap, this.pageNav, this.zoomInd, this.fileInput);

    this.engine = new Engine(this.stage, {
      onHistory: () => this.updateUndo(),
      onView: () => this.onView(),
      onZoom: (z) => this.showZoom(z),
      onZoomEnd: () => this.hideZoomSoon(),
      onSettle: () => this.saveViewSoon(),
      onDirty: (p) => {
        this.dirty.add(p);
        this.pageVer.set(p, (this.pageVer.get(p) || 0) + 1);
        this.saveSoon();
        this.refreshThumbsSoon();
      },
      onPages: () => {
        this.saveSoon();
        this.renderPageNav();
        this.onView();
      },
      onGesture: (k) => ui.hud(k === 'undo' ? '元に戻す' : 'やり直す', k),
      // ぐしゃぐしゃで消したときは、すぐ戻せるように「元に戻す」を出す
      onScribbleErase: (n) => ui.toast(`${n} 本の線を消しました`, { icon: 'sparkle', action: '元に戻す', onAction: () => this.engine.undo(), duration: 3500 }),
      onPenDetected: () => {
        this.updateFinger();
        ui.toast('Apple Pencil を検出しました。指はスクロールとズーム用になります', { icon: 'pen', duration: 4200 });
      },
      onShape: (k) => ui.hud(SHAPE_LABEL[k] || '図形', 'shapes'),
      onAutoRevert: () => this.setTool(this.prevTool || 'pen'),
      onLongPress: (sp, pv, x, y) => this.canvasMenu(sp, pv, x, y),
      onSelColor: (b) => this.selColor(b),
      onSelMore: (b) => this.selMore(b),
      onSelStamp: () => this.saveSelectionAsStamp(),
      onToast: (m) => ui.toast(m, { duration: 1600 }),
      importAsset: (entry) => this.importAsset(entry),
      importStampAsset: (id, entry) => this.importStampAsset(id, entry),
      getStamp: () => this.currentStamp(),
      onNoStamp: () => ui.toast('スタンプがありません。なげなわで選んで「スタンプ」で保存できます', { icon: 'stamp', duration: 3600 }),
      onAddPageEnd: () => this.quickAddPage(this.engine.pages().length),
      onPullAdd: () => this.quickAddPage(this.engine.pages().length),
      onTextEdit: () => {},
      onSelection: () => {},
    });

    this.setupDockDrag();
    this.applyDockPos(false);
    new ResizeObserver(() => this.updateInsets()).observe(this.head);
    new ResizeObserver(() => {
      this.updateInsets();
      this.movePill();
    }).observe(this.dock);
  }

  // ---------------------------------------------------------------- 開く・閉じる
  async open(id) {
    const note = store.getNote(id);
    if (!note) return false;
    this.note = note;
    this.dirty.clear();
    this.stampAssetMap = new Map();
    const [pages, assets] = await Promise.all([store.loadPages(id), store.loadAssets(id), this.loadStamps()]);
    this.knownIds = (note.pageIds || []).slice();
    this.root.hidden = false;
    document.body.classList.add('editing');
    this.engine.assets = new Map();
    this.engine.accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#5b6cf0';
    for (const a of assets) {
      this.engine.assets.set(a.id, loadAssetEntry(a, (e) => {
        if (this.note === note && e.ok) this.engine.assetLoaded(a.id);
      }));
    }
    this.engine.load(note, pages);
    this.engine.setTool(settings.tool);
    if (!note.pageIds || note.pageIds.length !== pages.length) for (const p of pages) this.dirty.add(p);
    this.titleText.textContent = note.title;
    this.renderDock();
    this.movePill(true);
    this.updateUndo();
    this.updateFinger();
    this.updateInsets();
    this.engine.onResize();
    this.engine.renderAllNow();
    this.renderPageNav();
    this.onView();
    settings.lastNote = id;
    saveSettings();
    store.updateNote(id, { openedAt: Date.now() }, true);
    return true;
  }

  // 閉じる前の後片付け：保存・サムネイル作成。戻り値は閉じるアニメーション用のスナップショット
  async prepareClose() {
    if (!this.note) return null;
    this.setPageNav(false);
    ui.closeAllPops();
    this.engine.finishTransient();
    this.saveSoon.cancel();
    this.saveViewSoon.cancel();
    this.note.view = this.engine.getViewState();
    await this.save(true);
    let snap = null;
    try {
      const i = this.engine.currentIndex();
      const pv = this.engine.pvs[i];
      if (pv) {
        snap = { rect: this.engine.pageScreenRect(i), canvas: null, paper: pv.page.paper };
        snap.canvas = this.engine.pageImage(i, Math.min(600, Math.round(pv.page.w)));
      }
      const first = this.engine.pages()[0];
      const tcv = renderThumb(first, 360, this.engine.assets);
      const blob = await canvasToBlob(tcv, 'image/jpeg', 0.85);
      await store.setThumb(this.note.id, blob);
    } catch (e) {
      console.warn(e);
    }
    return snap;
  }

  async close() {
    const note = this.note;
    if (!note) return;
    // 参照されなくなった画像を削除
    try {
      const used = new Set();
      for (const p of this.engine.pages()) {
        if (p.bg) used.add(p.bg);
        for (const it of p.items) if (it.t === 'i') used.add(it.asset);
      }
      const unused = [...this.engine.assets.keys()].filter((k) => !used.has(k));
      if (unused.length) await store.deleteAssets(unused);
    } catch (_) {}
    for (const a of this.engine.assets.values()) if (a && a.url) URL.revokeObjectURL(a.url);
    this.engine.unload();
    this.engine.assets = new Map();
    this.note = null;
    this.root.hidden = true;
    document.body.classList.remove('editing');
    settings.lastNote = null;
    saveSettings();
    store.notifyNotes();
  }

  async save(force) {
    const note = this.note;
    if (!note) return;
    if (this.saving) {
      this.saveAgain = true;
      return this.saving;
    }
    const pages = this.engine.pages();
    const ids = pages.map((p) => p.id);
    const known = new Set(this.knownIds);
    const put = pages.filter((p) => this.dirty.has(p) || !known.has(p.id));
    const idSet = new Set(ids);
    const removed = this.knownIds.filter((id) => !idSet.has(id));
    this.dirty.clear();
    if (!put.length && !removed.length && !force) return;
    if (put.length || removed.length) note.updatedAt = Date.now();
    note.pageIds = ids;
    const ops = [...put.map((p) => ({ store: 'pages', put: p })), ...removed.map((id) => ({ store: 'pages', del: id })), { store: 'notes', put: note }];
    this.saving = db
      .batch(ops)
      .then(() => {
        this.knownIds = ids;
      })
      .catch((e) => {
        console.error(e);
        for (const p of put) this.dirty.add(p);
        ui.toast('保存に失敗しました。容量を確認してください', { icon: 'info' });
      })
      .finally(() => {
        this.saving = null;
        if (this.saveAgain) {
          this.saveAgain = false;
          this.save();
        }
      });
    return this.saving;
  }
  saveView() {
    if (!this.note) return;
    this.note.view = this.engine.getViewState();
    store.updateNote(this.note.id, { view: this.note.view }, true).catch(() => {});
  }

  // ---------------------------------------------------------------- ヘッダー
  updateUndo() {
    this.undoBtn.disabled = !this.engine.canUndo();
    this.redoBtn.disabled = !this.engine.canRedo();
  }
  updateFinger() {
    const on = this.engine.fingerDraws();
    this.fingerBtn.classList.toggle('on', on);
    this.fingerBtn.title = on ? '指で描く: オン' : '指で描く: オフ（スクロール）';
  }
  toggleFinger() {
    const on = this.engine.fingerDraws();
    settings.fingerDraw = on ? 'off' : 'on';
    saveSettings();
    this.updateFinger();
    ui.hud(on ? '指: スクロール・ズーム' : '指: 描く', 'hand');
  }
  onView() {
    if (this._vq) return;
    this._vq = requestAnimationFrame(() => {
      this._vq = 0;
      if (!this.note) return;
      const n = this.engine.pvs.length;
      const i = this.engine.currentIndex();
      this.pnNum.textContent = `${i + 1}/${n}`;
      if (this.navCur !== i) {
        this.navCur = i;
        for (const el of this.pnList.children) el.classList.toggle('cur', +el.dataset.i === i);
        if (this.navOpen) {
          const cur = this.pnList.children[i];
          if (cur) cur.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
        }
      }
    });
  }
  showZoom(z) {
    const fit = this.engine.fitZoom();
    this.zoomInd.textContent = Math.round((z / fit) * 100) + '%';
    this.zoomInd.classList.add('show');
    this.hideZoomSoon();
  }
  hideZoomSoon() {
    clearTimeout(this._zT);
    this._zT = setTimeout(() => this.zoomInd.classList.remove('show'), 900);
  }

  async rename() {
    const v = await ui.promptDialog({ title: 'ノートの名前', value: this.note.title, placeholder: '無題のノート' });
    if (v == null || !this.note) return;
    const t = v || '無題のノート';
    await store.updateNote(this.note.id, { title: t });
    this.titleText.textContent = t;
  }
  noteMenu(anchor) {
    const n = this.note;
    if (!n) return;
    ui.menu(anchor, [
      { icon: 'edit', label: '名前を変更', action: () => this.rename() },
      {
        icon: n.favorite ? 'star-fill' : 'star',
        label: n.favorite ? 'お気に入りから外す' : 'お気に入りに追加',
        action: async () => {
          await store.updateNote(n.id, { favorite: !n.favorite });
          ui.hud(n.favorite ? 'お気に入りに追加' : 'お気に入りから外しました', n.favorite ? 'star-fill' : 'star');
        },
      },
      { icon: 'folder-move', label: 'フォルダへ移動…', action: () => this.app.library.moveDialog([n.id]) },
      { icon: 'palette', label: '表紙の色…', action: () => this.app.library.coverMenu(n.id, anchor) },
    ]);
  }
  moreMenu(anchor) {
    const pages = this.engine.pages();
    const ci = this.engine.currentIndex();
    const n = pages.length;
    ui.menu(anchor, [
      { header: `ページ ${ci + 1} / ${n}` },
      { icon: 'template', label: 'ページのテンプレート…', action: () => this.pageSetup('edit', ci) },
      { icon: 'page-add', label: 'ページを追加…', action: () => this.pageSetup('add', ci + 1) },
      { icon: 'duplicate', label: 'このページを複製', action: () => this.duplicatePage(ci) },
      { icon: 'trash', label: 'このページを削除', danger: true, disabled: n <= 1, action: () => this.deletePage(ci) },
      '-',
      { icon: 'paste', label: 'ペースト', disabled: !clipboard.items, action: () => this.engine.paste() },
      navigator.clipboard && navigator.clipboard.read ? { icon: 'image', label: 'クリップボードの画像を貼り付け', action: () => this.pasteSystemImage() } : null,
      { icon: 'fit', label: '幅に合わせる', action: () => this.engine.fitWidth() },
      { icon: 'zoom-out', label: 'ページ全体を表示', action: () => this.engine.zoomOutFull() },
      '-',
      { icon: 'photo', label: 'このページを画像で書き出し', action: () => this.exportPng(ci) },
      { icon: 'pdf', label: 'PDF で書き出し', action: () => this.exportPdf() },
      { icon: 'share', label: 'ノートファイルを共有', action: () => this.app.shareNoteFile(this.note.id) },
      '-',
      { icon: 'settings', label: '設定', action: () => this.app.openSettings() },
      { icon: 'help', label: '使い方', action: () => this.app.openHelp() },
    ]);
  }

  // ---------------------------------------------------------------- ツールドック
  onToolTap(id, btn) {
    if (settings.tool === id) this.toolPanel(id, btn);
    else this.setTool(id);
  }
  setTool(id) {
    if (id !== 'eraser') this.prevTool = id;
    settings.tool = id;
    saveSettings();
    this.engine.setTool(id);
    this.renderDock();
  }
  dockVertical() {
    return settings.dockPos === 'left' || settings.dockPos === 'right';
  }
  movePill(instant) {
    const b = this.toolBtns[settings.tool];
    if (!b || !b.offsetWidth) return;
    const p = this.toolPill.style;
    if (instant) p.transition = 'none';
    p.width = b.offsetWidth + 'px';
    p.height = b.offsetHeight + 'px';
    p.transform = `translate(${b.offsetLeft}px, ${b.offsetTop}px)`;
    if (instant) {
      void this.toolPill.offsetWidth;
      p.transition = '';
    }
  }
  applyTextStyle() {
    const t = settings.tools.text;
    this.engine.setTextStyle({ fs: t.sizes[t.si], color: t.colors[t.ci] });
  }
  renderDock() {
    const tool = settings.tool;
    for (const id in this.toolBtns) this.toolBtns[id].classList.toggle('on', id === tool);
    requestAnimationFrame(() => this.movePill());
    const o = this.optsEl;
    o.innerHTML = '';
    o.dataset.tool = tool;
    const T = settings.tools;
    const sep = () => h('span', { class: 'dock-sep' });
    if (tool === 'pen' || tool === 'hl' || tool === 'text' || tool === 'shape') {
      const t = T[tool];
      if (tool === 'shape') {
        const kb = h('button', { class: 'slot kind', title: '図形の種類', html: shapeSvg(t.kind) });
        kb.addEventListener('click', () => this.shapeKindMenu(kb));
        o.append(kb, sep());
      }
      const colors = h('div', { class: 'slots' });
      t.colors.forEach((c, i) => {
        const b = h('button', { class: 'slot color' + (i === t.ci ? ' on' : ''), 'aria-label': '色 ' + (i + 1) });
        b.style.setProperty('--c', c);
        b.addEventListener('click', () => {
          if (t.ci === i) return this.editColorSlot(tool, i, b);
          t.ci = i;
          saveSettings();
          this.renderDock();
          if (tool === 'text') this.applyTextStyle();
        });
        colors.append(b);
      });
      const sizes = h('div', { class: 'slots' });
      const arr = tool === 'text' ? t.sizes : t.widths;
      const cur = tool === 'text' ? t.si : t.wi;
      arr.forEach((w, i) => {
        let inner;
        if (tool === 'text') inner = h('b', { text: 'A', style: { fontSize: [12, 15, 19][i] + 'px' } });
        else if (tool === 'hl') inner = h('i', { class: 'hl-bar', style: { height: clamp(w * 0.42, 4, 16) + 'px', background: t.colors[t.ci] } });
        else inner = h('i', { class: 'dot', style: { width: clamp(w * 2.4, 4, 17) + 'px', height: clamp(w * 2.4, 4, 17) + 'px' } });
        const b = h('button', { class: 'slot width' + (i === cur ? ' on' : ''), 'aria-label': 'サイズ ' + (i + 1) }, inner);
        b.addEventListener('click', () => {
          if (cur === i) return this.editWidthSlot(tool, i, b);
          if (tool === 'text') t.si = i;
          else t.wi = i;
          saveSettings();
          this.renderDock();
          if (tool === 'text') this.applyTextStyle();
        });
        sizes.append(b);
      });
      o.append(colors, sep(), sizes);
      if (tool === 'shape') {
        const fb = h('button', { class: 'slot fill ' + t.fill, title: FILL_LABEL[t.fill] }, h('i'));
        fb.style.setProperty('--c', t.colors[t.ci]);
        fb.addEventListener('click', () => {
          const order = ['none', 'tint', 'solid'];
          t.fill = order[(order.indexOf(t.fill) + 1) % order.length];
          saveSettings();
          this.renderDock();
          ui.hud(FILL_LABEL[t.fill], 'shapes');
        });
        o.append(sep(), fb);
      }
    } else if (tool === 'eraser') {
      const t = T.eraser;
      const mode = ui.segmented(
        [
          { value: 'partial', label: '部分' },
          { value: 'stroke', label: '線ごと' },
        ],
        t.mode,
        (v) => {
          t.mode = v;
          saveSettings();
        }
      );
      mode.classList.add('mini');
      const sizes = h('div', { class: 'slots' });
      t.sizes.forEach((s, i) => {
        const d = clamp(s * 0.36, 6, 18);
        const b = h('button', { class: 'slot width' + (i === t.si ? ' on' : '') }, h('i', { class: 'ring', style: { width: d + 'px', height: d + 'px' } }));
        b.addEventListener('click', () => {
          if (t.si === i) return this.editWidthSlot('eraser', i, b);
          t.si = i;
          saveSettings();
          this.renderDock();
        });
        sizes.append(b);
      });
      o.append(mode, sep(), sizes);
    } else if (tool === 'lasso') {
      const t = T.lasso;
      const mode = ui.segmented(
        [
          { value: 'free', label: 'フリー' },
          { value: 'rect', label: '四角' },
        ],
        t.mode,
        (v) => {
          t.mode = v;
          saveSettings();
        }
      );
      mode.classList.add('mini');
      o.append(mode);
    } else if (tool === 'stamp') {
      const t = T.stamp;
      const list = h('div', { class: 'slots stamps' });
      const recent = this.stamps.slice(0, 5);
      if (t.id && !this.stamps.some((s) => s.id === t.id)) t.id = null;
      if (!t.id && recent[0]) t.id = recent[0].id;
      for (const s of recent) {
        const b = h('button', { class: 'slot stamp' + (s.id === t.id ? ' on' : ''), title: 'スタンプ' }, h('img', { src: this.stampThumb(s), alt: '' }));
        b.addEventListener('click', () => {
          if (t.id === s.id) return this.stampPanel(b);
          t.id = s.id;
          saveSettings();
          this.renderDock();
        });
        list.append(b);
      }
      if (!recent.length) list.append(h('span', { class: 'dock-hint', text: 'なげなわで選んで保存' }));
      const all = h('button', { class: 'slot', title: 'スタンプ一覧', html: icon('grid') });
      all.addEventListener('click', () => this.stampPanel(all));
      o.append(list, sep(), all);
    }
  }
  previewOpts(tool) {
    const T = settings.tools;
    if (tool === 'hl') {
      const t = T.hl;
      return { kind: 'hl', color: t.colors[t.ci], w: t.widths[t.wi], alpha: t.alpha, sens: 0 };
    }
    const t = T.pen;
    return { kind: 'pen', color: t.colors[t.ci], w: t.widths[t.wi], sens: (PEN_TYPES[t.type] || PEN_TYPES.fountain).sens * t.sens };
  }
  drawPreview(cv, tool) {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const W = 264, H = 64;
    cv.width = W * dpr;
    cv.height = H * dpr;
    cv.style.width = W + 'px';
    cv.style.height = H + 'px';
    const o = this.previewOpts(tool);
    cv.classList.toggle('dark-bg', luminance(o.color) > 0.82);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const live = new LiveStroke({ kind: o.kind, w: o.w, sens: o.sens, z: 1 });
    for (let i = 0; i <= 80; i++) {
      const t = i / 80;
      const x = 22 + t * (W - 44), y = H / 2 + Math.sin(t * Math.PI * 2) * H * 0.22;
      live.add(x, y, 0.06 + 0.5 * Math.sin(t * Math.PI), i * 6);
    }
    live.finish();
    if (o.kind === 'hl') {
      ctx.globalAlpha = o.alpha;
      ctx.strokeStyle = o.color;
      ctx.lineWidth = o.w;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(live.fullPath());
    } else {
      ctx.fillStyle = o.color;
      ctx.fill(live.fullPath());
    }
  }
  popPlacement() {
    return this.dockVertical() ? 'side' : settings.dockPos === 'bottom' ? 'above' : 'auto';
  }
  editColorSlot(tool, i, anchor) {
    const t = settings.tools[tool];
    const palette = tool === 'hl' ? ui.HL_PALETTE : ui.PEN_PALETTE;
    let pop = null;
    const grid = ui.colorGrid(palette, t.colors[i], (c, custom) => {
      t.colors[i] = c;
      saveSettings();
      this.renderDock();
      if (tool === 'text') this.applyTextStyle();
      if (!custom && pop) pop.close();
    });
    pop = ui.popover(anchor, h('div', { class: 'color-pop' }, h('div', { class: 'tp-label', text: '色を選択' }), grid), { placement: this.popPlacement() });
  }
  editWidthSlot(tool, i, anchor) {
    const t = settings.tools[tool];
    const body = h('div', { class: 'tool-panel narrow' });
    let cv = null;
    if (tool === 'pen' || tool === 'hl') {
      cv = h('canvas', { class: 'tp-preview' });
      body.append(cv);
    }
    const conf = {
      pen: { min: 0.4, max: 16, step: 0.1, arr: 'widths', fmt: (v) => v.toFixed(1) },
      hl: { min: 4, max: 48, step: 1, arr: 'widths', fmt: (v) => String(v) },
      shape: { min: 0.5, max: 16, step: 0.1, arr: 'widths', fmt: (v) => v.toFixed(1) },
      eraser: { min: 4, max: 90, step: 1, arr: 'sizes', fmt: (v) => String(v) },
      text: { min: 8, max: 72, step: 1, arr: 'sizes', fmt: (v) => v + 'pt' },
    }[tool];
    body.append(
      ui.row(
        tool === 'text' ? '文字サイズ' : '太さ',
        ui.slider({
          min: conf.min,
          max: conf.max,
          step: conf.step,
          value: t[conf.arr][i],
          format: conf.fmt,
          onInput: (v) => {
            t[conf.arr][i] = v;
            saveSettings();
            if (cv) this.drawPreview(cv, tool);
            this.renderDock();
            if (tool === 'text') this.applyTextStyle();
          },
        })
      )
    );
    if (cv) this.drawPreview(cv, tool);
    ui.popover(anchor, body, { placement: this.popPlacement(), className: 'tool-pop' });
  }
  shapeKindMenu(anchor) {
    const t = settings.tools.shape;
    let pop = null;
    const grid = h('div', { class: 'shape-grid' });
    for (const k of SHAPE_KINDS) {
      const b = h('button', { class: 'shape-cell' + (t.kind === k.id ? ' on' : ''), html: shapeSvg(k.id) + `<span>${k.label}</span>` });
      b.addEventListener('click', () => {
        t.kind = k.id;
        saveSettings();
        this.renderDock();
        if (pop) pop.close();
      });
      grid.append(b);
    }
    pop = ui.popover(anchor, h('div', { class: 'color-pop' }, h('div', { class: 'tp-label', text: '図形' }), grid), { placement: this.popPlacement() });
  }
  toolPanel(tool, anchor) {
    const T = settings.tools;
    const body = h('div', { class: 'tool-panel' });
    let drawPreview = () => {};
    const refresh = () => {
      saveSettings();
      this.renderDock();
      drawPreview();
    };
    if (tool === 'pen' || tool === 'hl') {
      const t = T[tool];
      const cv = h('canvas', { class: 'tp-preview' });
      drawPreview = () => this.drawPreview(cv, tool);
      body.append(cv);
      if (tool === 'pen') {
        body.append(
          ui.row('ペンの種類', ui.segmented(Object.entries(PEN_TYPES).map(([k, v]) => ({ value: k, label: v.label })), t.type, (v) => { t.type = v; refresh(); })),
          ui.row('筆圧の強さ', ui.slider({ min: 0, max: 1.5, step: 0.05, value: t.sens, format: (v) => Math.round(v * 100) + '%', onInput: (v) => { t.sens = v; refresh(); } }))
        );
      }
      body.append(
        ui.row('太さ', ui.slider({
          min: tool === 'pen' ? 0.4 : 4, max: tool === 'pen' ? 16 : 48, step: tool === 'pen' ? 0.1 : 1,
          value: t.widths[t.wi], format: (v) => (tool === 'pen' ? v.toFixed(1) : String(v)),
          onInput: (v) => { t.widths[t.wi] = v; refresh(); },
        }))
      );
      if (tool === 'hl') {
        body.append(
          ui.row('不透明度', ui.slider({ min: 0.15, max: 0.8, step: 0.01, value: t.alpha, format: (v) => Math.round(v * 100) + '%', onInput: (v) => { t.alpha = v; refresh(); } })),
          ui.row('まっすぐ引く', ui.toggle(t.straight, (v) => { t.straight = v; refresh(); }), '置いた位置から直線で引きます')
        );
      }
      body.append(
        h('div', { class: 'tp-label', text: '色' }),
        ui.colorGrid(tool === 'hl' ? ui.HL_PALETTE : ui.PEN_PALETTE, t.colors[t.ci], (c) => { t.colors[t.ci] = c; refresh(); }),
        h('p', { class: 'tp-hint', html: `${icon('shapes')}<span>書いた後にペンを止めると、直線・弧・曲線・折れ線・円・四角などに整います。そのまま動かすと形を調整できます</span>` })
      );
      drawPreview();
    } else if (tool === 'shape') {
      const t = T.shape;
      const grid = h('div', { class: 'shape-grid' });
      for (const k of SHAPE_KINDS) {
        const b = h('button', { class: 'shape-cell' + (t.kind === k.id ? ' on' : ''), html: shapeSvg(k.id) + `<span>${k.label}</span>` });
        b.addEventListener('click', () => {
          t.kind = k.id;
          for (const x of grid.children) x.classList.toggle('on', x === b);
          refresh();
        });
        grid.append(b);
      }
      body.append(
        h('div', { class: 'tp-label', text: '図形' }),
        grid,
        ui.row('塗り', ui.segmented([{ value: 'none', label: 'なし' }, { value: 'tint', label: 'うすく' }, { value: 'solid', label: '塗る' }], t.fill, (v) => { t.fill = v; refresh(); })),
        ui.row('縦横比を固定', ui.toggle(t.square, (v) => { t.square = v; refresh(); }), '正方形・正円・45° ごとの直線'),
        ui.row('線の太さ', ui.slider({ min: 0.5, max: 16, step: 0.1, value: t.widths[t.wi], format: (v) => v.toFixed(1), onInput: (v) => { t.widths[t.wi] = v; refresh(); } })),
        h('div', { class: 'tp-label', text: '色' }),
        ui.colorGrid(ui.PEN_PALETTE, t.colors[t.ci], (c) => { t.colors[t.ci] = c; refresh(); }),
        h('p', { class: 'tp-hint', html: `${icon('info')}<span>ページ上をドラッグして描きます</span>` })
      );
    } else if (tool === 'stamp') {
      return this.stampPanel(anchor);
    } else if (tool === 'eraser') {
      const t = T.eraser;
      body.append(
        ui.row('モード', ui.segmented([{ value: 'partial', label: '部分消し' }, { value: 'stroke', label: '線ごと消す' }], t.mode, (v) => { t.mode = v; refresh(); })),
        ui.row('大きさ', ui.slider({ min: 4, max: 90, step: 1, value: t.sizes[t.si], onInput: (v) => { t.sizes[t.si] = v; refresh(); } })),
        ui.row('蛍光ペンだけ消す', ui.toggle(t.hlOnly, (v) => { t.hlOnly = v; refresh(); })),
        ui.row('使ったらペンに戻る', ui.toggle(settings.autoRevert, (v) => { settings.autoRevert = v; refresh(); })),
        h('p', { class: 'tp-hint', html: `${icon('sparkle')}<span>ペンのまま、消したい所を<b>ぐしゃぐしゃっと塗りつぶす</b>だけでも消せます</span>` }),
        h('button', {
          class: 'btn danger block', text: 'このページをすべて消去',
          onclick: async () => {
            ui.closeAllPops();
            const ok = await ui.confirmDialog({ title: 'このページを消去', message: 'ページ内の手書き・画像・テキストをすべて消します（元に戻すで復元できます）', ok: '消去', danger: true });
            if (ok) this.engine.clearPage(this.engine.currentIndex());
          },
        })
      );
    } else if (tool === 'lasso') {
      const t = T.lasso;
      body.append(
        ui.row('選択の形', ui.segmented([{ value: 'free', label: 'フリーハンド' }, { value: 'rect', label: '四角形' }], t.mode, (v) => { t.mode = v; refresh(); })),
        h('ul', { class: 'tp-tips' },
          h('li', { text: '囲んだ後：中をドラッグで移動、四隅で拡大・縮小、上の丸で回転' }),
          h('li', { text: '「スタンプ」でよく使う形を保存して、すぐに貼れます' }),
          h('li', { text: '他のページへドラッグすると移動できます' }),
          h('li', { text: 'タップで 1 つだけ選択／何もない所を長押しでペースト' }))
      );
    } else if (tool === 'text') {
      const t = T.text;
      body.append(
        ui.row('文字サイズ', ui.slider({ min: 8, max: 72, step: 1, value: t.sizes[t.si], format: (v) => v + 'pt', onInput: (v) => { t.sizes[t.si] = v; refresh(); this.applyTextStyle(); } })),
        h('div', { class: 'tp-label', text: '色' }),
        ui.colorGrid(ui.PEN_PALETTE, t.colors[t.ci], (c) => { t.colors[t.ci] = c; refresh(); this.applyTextStyle(); }),
        h('p', { class: 'tp-hint', html: `${icon('info')}<span>ページをタップすると入力できます。既存のテキストをタップで編集。</span>` })
      );
    }
    ui.popover(anchor, body, { placement: this.popPlacement(), className: 'tool-pop' });
  }

  // ドックの位置（上下左右）をドラッグで変更
  setupDockDrag() {
    let st = null;
    const g = this.grip;
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      st = { id: e.pointerId, x: e.clientX, y: e.clientY };
      try { g.setPointerCapture(e.pointerId); } catch (_) {}
      this.dock.classList.add('dragging');
    });
    g.addEventListener('pointermove', (e) => {
      if (!st || e.pointerId !== st.id) return;
      this.dock.style.transform = `translate(${e.clientX - st.x}px, ${e.clientY - st.y}px) scale(1.03)`;
    });
    const end = (e) => {
      if (!st || e.pointerId !== st.id) return;
      const moved = Math.hypot(e.clientX - st.x, e.clientY - st.y);
      st = null;
      this.dock.classList.remove('dragging');
      if (moved < 8) {
        this.dock.style.transform = '';
        this.dockMenu();
        return;
      }
      const W = innerWidth, H = innerHeight, x = e.clientX, y = e.clientY;
      const d = { top: y / H, bottom: (H - y) / H, left: (x / W) * 1.4, right: ((W - x) / W) * 1.4 };
      const pos = Object.keys(d).reduce((a, b) => (d[a] <= d[b] ? a : b));
      this.setDockPos(pos, true);
    };
    g.addEventListener('pointerup', end);
    g.addEventListener('pointercancel', end);
  }
  dockMenu() {
    const p = settings.dockPos;
    ui.menu(this.grip, [
      { header: 'ツールバーの位置' },
      { label: '上', checked: p === 'top', action: () => this.setDockPos('top', true) },
      { label: '下', checked: p === 'bottom', action: () => this.setDockPos('bottom', true) },
      { label: '左', checked: p === 'left', action: () => this.setDockPos('left', true) },
      { label: '右', checked: p === 'right', action: () => this.setDockPos('right', true) },
    ], { placement: this.popPlacement() });
  }
  setDockPos(pos, animate) {
    const first = this.dock.getBoundingClientRect();
    this.dock.style.transform = '';
    settings.dockPos = pos;
    saveSettings();
    this.applyDockPos(false);
    if (animate && !reducedMotion()) {
      const last = this.dock.getBoundingClientRect();
      this.dock.animate(
        [{ transform: `translate(${first.left - last.left}px, ${first.top - last.top}px)`, opacity: 0.85 }, { transform: 'translate(0,0)', opacity: 1 }],
        { duration: 460, easing: 'cubic-bezier(.2,.9,.25,1.12)' }
      );
    }
  }
  applyDockPos() {
    const pos = settings.dockPos;
    this.dockWrap.dataset.pos = pos;
    this.root.dataset.dock = pos;
    document.body.classList.toggle('dock-bottom', pos === 'bottom');
    requestAnimationFrame(() => {
      this.movePill(true);
      this.updateInsets();
    });
  }
  updateInsets() {
    const hh = this.head.offsetHeight;
    if (!hh) return;
    this.root.style.setProperty('--head-h', hh + 'px');
    const d = this.dock.getBoundingClientRect();
    const pos = settings.dockPos;
    const vertical = pos === 'left' || pos === 'right';
    const ins = { top: hh + 6, bottom: 12, left: 0, right: 0, tool: vertical ? d.width : d.height };
    if (pos === 'top') ins.top = hh + d.height + 18;
    if (pos === 'bottom') ins.bottom = d.height + 24;
    if (pos === 'left') ins.left = d.width + 18;
    if (pos === 'right') ins.right = d.width + 18;
    this.engine.setInsets(ins);
    this.positionPageNav();
  }

  // ---------------------------------------------------------------- ページナビ（右上）
  positionPageNav() {
    const nav = this.pageNav;
    const hh = this.head.offsetHeight;
    const d = this.dock.getBoundingClientRect();
    const pos = settings.dockPos;
    let top = hh + 10, right = 12;
    if (pos === 'right') right = d.width + 26;
    // ツールバーが上にあるときは、その下の右端に浮かせる（左へ広げても重ならない）
    if (pos === 'top') top = d.bottom + 10;
    nav.style.top = top + 'px';
    nav.style.right = `calc(${right}px + var(--sar))`;
  }
  togglePageNav() {
    this.setPageNav(!this.navOpen);
  }
  setPageNav(open) {
    if (this.navOpen === open) return;
    this.navOpen = open;
    this.pageNav.classList.toggle('open', open);
    this.pnToggle.classList.toggle('on', open);
    this.positionPageNav();
    if (open) {
      this.renderPageNav();
      requestAnimationFrame(() => {
        const cur = this.pnList.children[this.engine.currentIndex()];
        if (cur) cur.scrollIntoView({ inline: 'center', block: 'nearest' });
      });
    }
  }
  renderPageNav() {
    if (!this.note) return;
    const pages = this.engine.pages();
    const cur = this.engine.currentIndex();
    this.navCur = cur;
    this.pnNum.textContent = `${cur + 1}/${pages.length}`;
    if (!this.navOpen) return;
    const list = this.pnList;
    list.innerHTML = '';
    pages.forEach((pg, i) => {
      const thumb = h('div', { class: 'pn-thumb' });
      const H = 92;
      thumb.style.width = clamp((H * pg.w) / pg.h, 48, 150) + 'px';
      thumb.style.height = H + 'px';
      thumb.style.background = pg.paper;
      const item = h('div', { class: 'pn-item' + (i === cur ? ' cur' : ''), dataset: { i: String(i) } }, thumb, h('span', { class: 'pn-n', text: String(i + 1) }));
      item.style.setProperty('--i', i);
      ui.pressable(item, {
        onTap: () => this.engine.goToPage(i),
        onLong: () => this.pageItemMenu(i, item),
        onDragStart: (st, e) => this.navDragStart(item, i, e),
        onDragMove: (e) => this.navDragMove(e),
        onDragEnd: (e, s, c) => this.navDragEnd(c),
      });
      list.append(item);
      this.fillThumb(pg, thumb);
    });
  }
  fillThumb(pg, el) {
    const ver = this.pageVer.get(pg) || 0;
    const c = this.thumbCache.get(pg);
    if (c && c.ver === ver) {
      el.append(c.img.cloneNode());
      return;
    }
    (this.thumbQ || (this.thumbQ = [])).push({ pg, el, ver });
    this.pumpThumbs();
  }
  pumpThumbs() {
    if (this._tq || !this.thumbQ || !this.thumbQ.length) return;
    this._tq = requestAnimationFrame(() => {
      this._tq = 0;
      const t0 = performance.now();
      while (this.thumbQ.length && performance.now() - t0 < 10) {
        const { pg, el, ver } = this.thumbQ.shift();
        if (!el.isConnected) continue;
        const cv = renderThumb(pg, 130 * Math.min(2, window.devicePixelRatio || 1), this.engine.assets);
        const img = h('img', { src: cv.toDataURL('image/jpeg', 0.82), alt: '' });
        this.thumbCache.set(pg, { ver, img });
        el.innerHTML = '';
        el.append(img.cloneNode());
      }
      this.pumpThumbs();
    });
  }
  refreshThumbsSoon() {
    if (!this.navOpen) return;
    clearTimeout(this._rtT);
    this._rtT = setTimeout(() => {
      if (!this.navOpen) return;
      const pages = this.engine.pages();
      for (const el of this.pnList.children) {
        const pg = pages[+el.dataset.i];
        const c = pg && this.thumbCache.get(pg);
        if (pg && (!c || c.ver !== (this.pageVer.get(pg) || 0))) this.fillThumb(pg, el.querySelector('.pn-thumb'));
      }
    }, 600);
  }
  pageItemMenu(i, anchor) {
    const n = this.engine.pages().length;
    ui.menu(anchor, [
      { header: `ページ ${i + 1}` },
      { icon: 'plus', label: '前にページを追加', action: () => this.quickAddPage(i) },
      { icon: 'plus', label: '後にページを追加', action: () => this.quickAddPage(i + 1) },
      { icon: 'duplicate', label: '複製', action: () => this.duplicatePage(i) },
      { icon: 'template', label: 'テンプレートを変更…', action: () => this.pageSetup('edit', i) },
      { icon: 'photo', label: '画像で書き出し', action: () => this.exportPng(i) },
      '-',
      { icon: 'trash', label: '削除', danger: true, disabled: n <= 1, action: () => this.deletePage(i) },
    ]);
  }
  navDragStart(item, i, e) {
    const items = [...this.pnList.children];
    const rects = items.map((el) => el.getBoundingClientRect());
    this.navDrag = { item, from: i, to: i, x0: e.clientX, items, rects };
    item.classList.add('dragging');
    this.pnList.classList.add('reordering');
  }
  navDragMove(e) {
    const d = this.navDrag;
    if (!d) return;
    const dx = e.clientX - d.x0;
    d.item.style.transform = `translateX(${dx}px) scale(1.06)`;
    const r = d.rects[d.from];
    const cx = r.left + r.width / 2 + dx;
    let to = 0;
    d.rects.forEach((rr, j) => {
      if (cx > rr.left + rr.width / 2) to = j;
    });
    if (cx < d.rects[0].left + d.rects[0].width / 2) to = 0;
    d.to = to;
    const w0 = r.width + 10;
    d.items.forEach((el, j) => {
      if (j === d.from) return;
      let s = 0;
      if (d.from < to && j > d.from && j <= to) s = -w0;
      if (d.from > to && j < d.from && j >= to) s = w0;
      el.style.transform = s ? `translateX(${s}px)` : '';
    });
  }
  navDragEnd(cancel) {
    const d = this.navDrag;
    this.navDrag = null;
    if (!d) return;
    for (const el of d.items) el.style.transform = '';
    d.item.classList.remove('dragging');
    this.pnList.classList.remove('reordering');
    if (!cancel && d.to !== d.from) {
      this.engine.movePage(d.from, d.to);
      ui.hud(`ページ ${d.from + 1} → ${d.to + 1}`, 'pages');
    }
  }

  // ---------------------------------------------------------------- ページ
  quickAddPage(index) {
    const pages = this.engine.pages();
    const i = index == null ? this.engine.currentIndex() + 1 : index;
    const ref = pages[clamp(i - 1, 0, pages.length - 1)];
    // 開いているページと同じ形式（画像ページの次は同じ大きさの白紙）
    this.engine.addPage(i, ref && ref.bg ? { template: 'blank', paper: '#ffffff' } : {});
    requestAnimationFrame(() => this.engine.goToPage(i));
    ui.hud(`ページ ${i + 1} を追加`, 'page-add');
  }
  duplicatePage(i) {
    this.engine.duplicatePage(i);
    requestAnimationFrame(() => this.engine.goToPage(i + 1));
    ui.hud('ページを複製', 'duplicate');
  }
  async deletePage(i) {
    if (this.engine.pages().length <= 1) return;
    this.engine.deletePage(i);
    ui.toast(`ページ ${i + 1} を削除しました`, { action: '元に戻す', onAction: () => this.engine.undo(), icon: 'trash' });
  }
  async addImagePages(index, files) {
    if (!this.note || !files || !files.length) return;
    const dismiss = ui.toast('画像を読み込み中…', { duration: 60000, icon: 'img-page' });
    const note = this.note;
    const { specs, assets } = await imagesToPageSpecs(files, note.id);
    dismiss();
    if (this.note !== note || !specs.length) {
      if (!specs.length) ui.toast('画像を読み込めませんでした', { icon: 'info' });
      return;
    }
    for (const a of assets) {
      await store.saveAsset(a);
      this.engine.assets.set(a.id, loadAssetEntry(a, (e) => {
        if (this.note === note && e.ok) this.engine.assetLoaded(a.id);
      }));
    }
    this.engine.addPages(index, specs);
    requestAnimationFrame(() => this.engine.goToPage(index, { fit: true }));
    ui.hud(`${specs.length} ページを追加`, 'img-page');
  }
  async setPageImage(index, file) {
    const note = this.note;
    const page = this.engine.pages()[index];
    if (!note || !page) return;
    const { specs, assets } = await imagesToPageSpecs([file], note.id);
    if (!specs.length || this.note !== note) return;
    const a = assets[0];
    await store.saveAsset(a);
    this.engine.assets.set(a.id, loadAssetEntry(a, (e) => {
      if (this.note === note && e.ok) this.engine.assetLoaded(a.id);
    }));
    const s = specs[0];
    this.engine.setPageProps([page], { template: 'blank', paper: '#ffffff', w: s.w, h: s.h, bg: a.id });
  }
  pageSetup(mode, index) {
    const pages = this.engine.pages();
    const ref = pages[clamp(mode === 'edit' ? index : index - 1, 0, pages.length - 1)];
    const tpl = ref.bg ? 'blank' : store.tplCanon(ref.template);
    const sp = { ...settings.tplSp };
    if (store.TPL_SP[ref.template]) sp[tpl] = store.tplSpacing(ref);
    const st = { template: tpl, sp, paper: ref.paper, size: sizeKeyOf(ref.w, ref.h) || 'a4p', scope: 'this', images: null };
    const fileIn = h('input', { type: 'file', accept: 'image/*', hidden: true });
    if (mode === 'add') fileIn.multiple = true;
    const sizeBox = h('div', {}, h('h4', { text: 'サイズ' }), sizeChips(st));
    const imgHint = h('p', { class: 'tp-hint', html: `${icon('img-page')}<span>画像の縦横比に合わせたページになります${mode === 'add' ? '（複数選ぶと 1 枚ずつページに）' : ''}</span>` });
    const sync = () => {
      const img = st.template === 'image';
      sizeBox.hidden = img;
      imgHint.hidden = !img;
      okBtn.disabled = img && !(st.images && st.images.length);
    };
    const tg = templateGrid(
      st,
      () => {
        st.images = null;
        tg.sync();
        sync();
      },
      { onImage: () => fileIn.click() }
    );
    fileIn.addEventListener('change', () => {
      const files = [...(fileIn.files || [])];
      fileIn.value = '';
      if (!files.length) return;
      st.images = files;
      st.template = 'image';
      tg.sync();
      sync();
    });
    const body = h(
      'div',
      { class: 'page-setup' },
      h('h4', { text: 'テンプレート' }),
      tg,
      imgHint,
      h('h4', { text: '紙の色' }),
      paperSwatches(st, () => tg.redraw()),
      sizeBox,
      mode === 'edit'
        ? h('div', { class: 'scope' }, h('h4', { text: '適用範囲' }), ui.segmented([{ value: 'this', label: 'このページ' }, { value: 'all', label: 'すべてのページ' }], 'this', (v) => (st.scope = v)))
        : null,
      fileIn
    );
    const okBtn = h('button', { class: 'btn primary', text: mode === 'edit' ? '適用' : '追加' });
    const cancel = h('button', { class: 'btn', text: 'キャンセル' });
    const s = ui.sheet({ title: mode === 'edit' ? 'ページの設定' : 'ページを追加', body, foot: [cancel, okBtn] });
    sync();
    cancel.addEventListener('click', () => s.close());
    okBtn.addEventListener('click', () => {
      s.close();
      if (st.template === 'image' && st.images && st.images.length) {
        if (mode === 'edit') this.setPageImage(index, st.images[0]);
        else this.addImagePages(index, st.images);
        return;
      }
      const size = store.PAGE_SIZES[st.size] || { w: ref.w, h: ref.h };
      const spv = store.TPL_SP[st.template] ? st.sp[st.template] || store.TPL_SP[st.template] : null;
      if (spv) {
        settings.tplSp = { ...settings.tplSp, [st.template]: spv };
        saveSettings();
      }
      const props = { template: st.template, sp: spv, paper: st.paper, w: size.w, h: size.h, bg: null };
      if (mode === 'edit') {
        this.engine.setPageProps(st.scope === 'all' ? this.engine.pages() : [this.engine.pages()[index]], props);
        ui.hud('ページを更新', 'template');
      } else {
        this.engine.addPage(index, props);
        requestAnimationFrame(() => this.engine.goToPage(index));
      }
    });
  }

  // ---------------------------------------------------------------- スタンプ
  async loadStamps() {
    if (this.stampsLoaded) return;
    try {
      this.stamps = await store.loadStamps();
    } catch (_) {
      this.stamps = [];
    }
    this.stampsLoaded = true;
  }
  stampEntry(s) {
    let c = this.stampCache.get(s.id);
    if (!c) {
      c = { thumb: s.thumb ? URL.createObjectURL(s.thumb) : '', assets: new Map() };
      for (const a of s.assets || []) c.assets.set(a.id, loadAssetEntry(a));
      this.stampCache.set(s.id, c);
    }
    return c;
  }
  stampThumb(s) {
    return this.stampEntry(s).thumb;
  }
  currentStamp() {
    const t = settings.tools.stamp;
    const s = this.stamps.find((x) => x.id === t.id) || this.stamps[0];
    if (!s) return null;
    const c = this.stampEntry(s);
    return { items: s.items, bb: s.bb, assets: c.assets, scale: t.scale || 1 };
  }
  async importStampAsset(id, entry) {
    if (!this.note) return null;
    if (this.stampAssetMap.has(id)) return this.stampAssetMap.get(id);
    if (!entry || !entry.blob) return null;
    const asset = { id: uid(), noteId: this.note.id, blob: entry.blob, w: entry.w, h: entry.h, type: entry.blob.type };
    await store.saveAsset(asset);
    const e = loadAssetEntry(asset);
    this.engine.assets.set(asset.id, e);
    await e.ready;
    this.stampAssetMap.set(id, asset.id);
    return asset.id;
  }
  async saveSelectionAsStamp() {
    const E = this.engine, s = E.sel;
    if (!s) return;
    const bb = s.bb;
    const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
    const items = s.items.map((it) => translateItem(store.cloneItem(it), -cx, -cy));
    const assets = [];
    for (const it of s.items) {
      if (it.t !== 'i' || assets.some((a) => a.id === it.asset)) continue;
      const e = E.assets.get(it.asset);
      if (e && e.blob) assets.push({ id: it.asset, blob: e.blob, w: e.w, h: e.h, type: e.blob.type });
    }
    const src = E.selectionCanvas(2, true);
    const sc = Math.min(1, 200 / Math.max(src.width, src.height));
    const tcv = document.createElement('canvas');
    tcv.width = Math.max(1, Math.round(src.width * sc));
    tcv.height = Math.max(1, Math.round(src.height * sc));
    tcv.getContext('2d').drawImage(src, 0, 0, tcv.width, tcv.height);
    const thumb = await canvasToBlob(tcv, 'image/png');
    const stamp = { id: uid(), items, bb: [bb[0] - cx, bb[1] - cy, bb[2] - cx, bb[3] - cy], assets, thumb, createdAt: Date.now() };
    try {
      await store.saveStamp(stamp);
    } catch (e) {
      ui.toast('スタンプを保存できませんでした', { icon: 'info' });
      return;
    }
    this.stamps.unshift(stamp);
    settings.tools.stamp.id = stamp.id;
    saveSettings();
    if (settings.tool === 'stamp') this.renderDock();
    ui.toast('スタンプに保存しました', { icon: 'stamp', action: '使う', onAction: () => this.setTool('stamp') });
  }
  stampPanel(anchor) {
    const t = settings.tools.stamp;
    let editing = false;
    const grid = h('div', { class: 'stamp-grid' });
    const render = () => {
      grid.innerHTML = '';
      grid.classList.toggle('editing', editing);
      if (!this.stamps.length) {
        grid.append(h('p', { class: 'tp-hint', html: `${icon('lasso')}<span>なげなわで囲んで、メニューの「スタンプ」を押すと保存できます</span>` }));
        return;
      }
      for (const s of this.stamps) {
        const b = h('button', { class: 'stamp-cell' + (s.id === t.id ? ' on' : '') }, h('img', { src: this.stampThumb(s), alt: '' }), h('span', { class: 'stamp-x', html: icon('x') }));
        b.addEventListener('click', async () => {
          if (editing) {
            await store.deleteStamp(s.id);
            this.stamps = this.stamps.filter((x) => x !== s);
            const c = this.stampCache.get(s.id);
            if (c && c.thumb) URL.revokeObjectURL(c.thumb);
            this.stampCache.delete(s.id);
            if (t.id === s.id) t.id = this.stamps[0] ? this.stamps[0].id : null;
            saveSettings();
            render();
            this.renderDock();
            return;
          }
          t.id = s.id;
          saveSettings();
          if (settings.tool !== 'stamp') this.setTool('stamp');
          else this.renderDock();
          pop.close();
        });
        grid.append(b);
      }
    };
    render();
    const editBtn = h('button', { class: 'pill-btn', text: '編集' });
    editBtn.addEventListener('click', () => {
      editing = !editing;
      editBtn.textContent = editing ? '完了' : '編集';
      editBtn.classList.toggle('on', editing);
      render();
    });
    const body = h(
      'div',
      { class: 'tool-panel' },
      h('div', { class: 'tp-head' }, h('div', { class: 'tp-label', text: 'スタンプ' }), this.stamps.length ? editBtn : null),
      grid,
      ui.row('大きさ', ui.slider({ min: 0.25, max: 3, step: 0.05, value: t.scale || 1, format: (v) => Math.round(v * 100) + '%', onInput: (v) => { t.scale = v; saveSettings(); } })),
      h('p', { class: 'tp-hint', html: `${icon('stamp')}<span>ページをタップすると貼れます。ペンを置いたまま動かすと位置を調整できます</span>` })
    );
    const pop = ui.popover(anchor, body, { placement: this.popPlacement(), className: 'tool-pop' });
  }

  // ---------------------------------------------------------------- 選択・キャンバスメニュー
  selColor(anchor) {
    let pop = null;
    const grid = ui.colorGrid(ui.PEN_PALETTE, null, (c, custom) => {
      this.engine.recolorSel(c);
      if (!custom && pop) pop.close();
    });
    pop = ui.popover(anchor, h('div', { class: 'color-pop' }, h('div', { class: 'tp-label', text: '選択した線の色' }), grid));
  }
  selMore(anchor) {
    ui.menu(anchor, [
      { icon: 'stamp', label: 'スタンプとして保存', action: () => this.saveSelectionAsStamp() },
      { icon: 'front', label: '最前面へ', action: () => this.engine.arrangeSel('front') },
      { icon: 'backward', label: '最背面へ', action: () => this.engine.arrangeSel('back') },
      {
        icon: 'share', label: '画像として共有',
        action: async () => {
          const cv = this.engine.selectionCanvas(3);
          if (cv) this.share(await canvasToBlob(cv), 'selection.png');
        },
      },
    ]);
  }
  canvasMenu(sp, pv, x, y) {
    const r = this.stage.getBoundingClientRect();
    ui.menu({ x: r.left + sp.x, y: r.top + sp.y, w: 0, h: 0 }, [
      { icon: 'paste', label: 'ペースト', disabled: !clipboard.items, action: () => this.engine.paste({ pv, x, y }) },
      { icon: 'image', label: '画像を挿入', action: () => this.pickImage() },
      { icon: 'lasso', label: 'このページをすべて選択', disabled: !pv.page.items.length, action: () => this.engine.select(pv, pv.page.items.slice()) },
    ]);
  }

  // ---------------------------------------------------------------- 画像
  pickImage() {
    this.fileInput.click();
  }
  async insertImageFile(file) {
    if (!this.note) return;
    try {
      const { blob, w, h: hh } = await prepareImage(file);
      const asset = { id: uid(), noteId: this.note.id, blob, w, h: hh, type: blob.type };
      await store.saveAsset(asset);
      const entry = loadAssetEntry(asset);
      this.engine.assets.set(asset.id, entry);
      await entry.ready;
      if (settings.tool !== 'lasso') this.setTool('lasso');
      this.engine.insertImage(asset.id, w, hh);
    } catch (e) {
      console.warn(e);
      ui.toast('画像を読み込めませんでした', { icon: 'info' });
    }
  }
  async importAsset(entry) {
    if (!entry || !entry.blob || !this.note) return null;
    const asset = { id: uid(), noteId: this.note.id, blob: entry.blob, w: entry.w, h: entry.h, type: entry.blob.type };
    await store.saveAsset(asset);
    const e = loadAssetEntry(asset);
    this.engine.assets.set(asset.id, e);
    await e.ready;
    return asset.id;
  }
  async pasteSystemImage() {
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith('image/'));
        if (type) {
          const blob = await it.getType(type);
          await this.insertImageFile(new File([blob], 'paste', { type }));
          return true;
        }
      }
      ui.toast('クリップボードに画像がありません');
    } catch (_) {
      ui.toast('クリップボードを読み込めませんでした');
    }
    return false;
  }
  async onPaste(e) {
    if (!this.note) return;
    const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      for (const f of files) await this.insertImageFile(f);
      return;
    }
    if (clipboard.items) {
      e.preventDefault();
      this.engine.paste();
    }
  }

  // ---------------------------------------------------------------- 書き出し
  async share(blob, name) {
    const r = await shareFile(blob, name);
    if (r === 'needs-gesture') ui.toast('準備ができました', { action: '共有する', duration: 10000, onAction: () => shareFile(blob, name) });
  }
  async exportPng(i) {
    const page = this.engine.pages()[i];
    if (!page) return;
    const blob = await exporter.pageBlob(page, this.engine.assets, 2.5);
    this.share(blob, `${safeName(this.note.title)}_p${i + 1}.png`);
  }
  async exportPdf() {
    const note = this.note;
    const pages = this.engine.pages();
    const dismiss = ui.toast('PDF を作成中…', { duration: 60000, icon: 'pdf' });
    try {
      const blob = await exporter.buildPdf(pages, this.engine.assets);
      dismiss();
      this.share(blob, `${safeName(note.title)}.pdf`);
    } catch (e) {
      dismiss();
      ui.toast('PDF を作成できませんでした');
    }
  }

  // ---------------------------------------------------------------- キーボード
  onKey(e) {
    if (!this.note) return false;
    const t = e.target;
    if (t && t.matches && t.matches('input, textarea, [contenteditable]')) return false;
    const mod = e.metaKey || e.ctrlKey;
    const k = (e.key || '').toLowerCase();
    const E = this.engine;
    if (mod && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) E.redo();
      else E.undo();
    } else if (mod && k === 'y') {
      e.preventDefault();
      E.redo();
    } else if (mod && k === 'c' && E.sel) {
      e.preventDefault();
      E.copySel();
    } else if (mod && k === 'x' && E.sel) {
      e.preventDefault();
      E.cutSel();
    } else if (mod && k === 'd' && E.sel) {
      e.preventDefault();
      E.duplicateSel();
    } else if (mod && k === 'a') {
      e.preventDefault();
      if (settings.tool !== 'lasso') this.setTool('lasso');
      E.selectAll();
    } else if (mod && (k === '=' || k === '+' || k === ';')) {
      e.preventDefault();
      E.zoomBy(1.25);
    } else if (mod && k === '-') {
      e.preventDefault();
      E.zoomBy(0.8);
    } else if (mod && k === '0') {
      e.preventDefault();
      E.fitWidth();
    } else if ((k === 'backspace' || k === 'delete') && E.sel) {
      e.preventDefault();
      E.deleteSel();
    } else if (k === 'escape') {
      if (ui.closeTop()) return true;
      if (E.sel) E.clearSelection();
      else if (this.navOpen) this.setPageNav(false);
    } else if (!mod && !e.altKey) {
      const map = { p: 'pen', h: 'hl', e: 'eraser', l: 'lasso', s: 'shape', t: 'text', m: 'stamp' };
      if (map[k]) this.setTool(map[k]);
      else if (k === 'arrowright' || k === 'pagedown') E.goToPage(Math.min(E.pvs.length - 1, E.currentIndex() + 1));
      else if (k === 'arrowleft' || k === 'pageup') E.goToPage(Math.max(0, E.currentIndex() - 1));
      else return false;
    } else return false;
    return true;
  }
}
