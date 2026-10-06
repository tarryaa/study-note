// アプリ本体：画面遷移・履歴・テーマ・Service Worker
import { h, $, sleep, reducedMotion, shareFile, safeName, dateStamp } from './util.js';
import { settings, onSettings, ACCENTS } from './settings.js';
import * as store from './store.js';
import * as ui from './ui.js';
import * as exporter from './exporter.js';
import { Library } from './library.js';
import { Editor, loadAssetEntry } from './editor.js';
import { openSettings, openHelp, maybeWelcome } from './panels.js';

const darkMQ = matchMedia('(prefers-color-scheme: dark)');
// アニメーション終了待ち（画面が非表示だと終わらないことがあるので必ずタイムアウト付き）
const animDone = (a, ms) => Promise.race([a.finished.catch(() => {}), sleep(ms)]);

function applyTheme() {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && darkMQ.matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  const acc = ACCENTS[settings.accent] || ACCENTS.indigo;
  root.style.setProperty('--accent', acc);
  const n = parseInt(acc.slice(1), 16);
  root.style.setProperty('--accent-rgb', `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#141416' : '#f4f3ef');
  if (app && app.editor) app.editor.engine.accent = acc;
}

class App {
  async start() {
    applyTheme();
    onSettings(applyTheme);
    darkMQ.addEventListener ? darkMQ.addEventListener('change', applyTheme) : darkMQ.addListener(applyTheme);
    this.guardGestures();
    this.library = new Library($('#library'), this);
    this.editor = new Editor($('#editor'), this);
    this.backupInput = h('input', { type: 'file', hidden: true });
    this.backupInput.addEventListener('change', () => {
      const f = this.backupInput.files && this.backupInput.files[0];
      this.backupInput.value = '';
      if (f) this.importBackup(f);
    });
    document.body.append(this.backupInput);
    try {
      await store.loadAll();
    } catch (e) {
      console.error(e);
      ui.toast('データを読み込めませんでした。プライベートブラウズでは保存できません', { duration: 8000 });
    }
    this.library.render(true);
    document.documentElement.classList.add('ready');
    window.addEventListener('popstate', (e) => this.onPop(e));
    document.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('paste', (e) => this.editor.note && this.editor.onPaste(e));
    const flush = () => {
      if (this.editor.note) this.editor.save();
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', flush);
    this.registerSW();
    // 前回開いていたノートを復元
    const m = /#note=([\w-]+)/.exec(location.hash);
    const resume = (m && m[1]) || settings.lastNote;
    history.replaceState({ root: true }, '', location.pathname + location.search);
    const n = resume && store.getNote(resume);
    if (n && !n.deletedAt) await this.openNote(n.id, null, { instant: true });
    else maybeWelcome();
  }

  guardGestures() {
    const pd = (e) => e.preventDefault();
    document.addEventListener('gesturestart', pd);
    document.addEventListener('gesturechange', pd);
    document.addEventListener('touchmove', (e) => {
      if (ui.dragState.active) e.preventDefault();
    }, { passive: false });
    document.addEventListener('focusout', () => {
      setTimeout(() => {
        const a = document.activeElement;
        if (!a || a === document.body) window.scrollTo(0, 0);
      }, 60);
    });
  }

  // ---------------------------------------------------------------- 画面遷移
  async openNote(id, fromEl, { instant = false } = {}) {
    if (this.busy || this.editor.note) return;
    const note = store.getNote(id);
    if (!note || note.deletedAt) return;
    this.busy = true;
    try {
      const fromRect = fromEl && fromEl.getBoundingClientRect ? fromEl.getBoundingClientRect() : null;
      const ed = this.editor.root;
      if (instant) this.library.root.hidden = true;
      ed.style.opacity = '0';
      const ok = await this.editor.open(id);
      if (!ok) {
        ed.style.opacity = '';
        this.library.root.hidden = false;
        return;
      }
      history.pushState({ note: id }, '', '#note=' + id);
      if (!instant) await this.animateOpen(fromRect, fromEl);
      this.library.root.hidden = true;
    } catch (e) {
      console.error(e);
      ui.toast('ノートを開けませんでした');
    } finally {
      this.editor.root.style.opacity = '';
      this.busy = false;
    }
  }
  async animateOpen(fromRect, fromEl) {
    const ed = this.editor.root;
    const lib = this.library.root;
    if (reducedMotion()) {
      ed.style.opacity = '';
      return;
    }
    const idx = this.editor.engine.currentIndex();
    const to = this.editor.engine.pageScreenRect(idx);
    let ghost = null;
    if (fromRect && to && fromRect.width > 0) {
      const img = fromEl.querySelector('img');
      ghost = h('div', { class: 'open-ghost' });
      const page = this.editor.engine.pages()[idx];
      ghost.style.background = page ? page.paper : '#fff';
      if (img && img.src && img.complete && idx === 0) ghost.append(h('img', { src: img.src, alt: '' }));
      document.body.append(ghost);
      const st = (r) => ({ left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
      const from = { x: fromRect.left, y: fromRect.top, w: fromRect.width, h: fromRect.height };
      ghost.animate([{ ...st(from), borderRadius: '10px', opacity: 1 }, { ...st(to), borderRadius: '2px', opacity: 1 }], { duration: 440, easing: 'cubic-bezier(.2,.85,.25,1)', fill: 'forwards' });
    }
    lib.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(.96)', opacity: 0.4 }], { duration: 440, easing: 'cubic-bezier(.2,.8,.2,1)' });
    ed.style.opacity = '';
    const a = ed.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ghost ? 260 : 300, delay: ghost ? 220 : 0, easing: 'ease-out', fill: 'backwards' });
    await animDone(a, 650);
    if (ghost) ghost.remove();
  }

  requestClose() {
    if (history.state && history.state.note) history.back();
    else this.closeNote();
  }
  onPop(e) {
    const st = e.state || {};
    if (this.editor.note && st.note !== this.editor.note.id) this.closeNote();
    else if (!this.editor.note && st.note) this.openNote(st.note, null);
  }
  async closeNote() {
    if (this.busy || !this.editor.note) return;
    this.busy = true;
    const id = this.editor.note.id;
    try {
      const snap = await this.editor.prepareClose();
      const lib = this.library.root;
      lib.hidden = false;
      this.library.render(false);
      await this.animateClose(snap, id);
      await this.editor.close();
    } catch (e) {
      console.error(e);
      try { await this.editor.close(); } catch (_) {}
    } finally {
      this.busy = false;
      this.library.root.style.transform = '';
      if (history.state && history.state.note) history.replaceState({ root: true }, '', location.pathname + location.search);
    }
  }
  async animateClose(snap, id) {
    const ed = this.editor.root;
    const lib = this.library.root;
    if (reducedMotion()) return;
    const card = this.library.cardCover(id);
    let ghost = null;
    if (snap && snap.canvas && snap.rect && card) {
      const cr = card.getBoundingClientRect();
      ghost = h('div', { class: 'open-ghost' });
      ghost.style.background = snap.paper;
      snap.canvas.className = 'og-cv';
      ghost.append(snap.canvas);
      document.body.append(ghost);
      const st = (r) => ({ left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
      ghost.animate([{ ...st(snap.rect), borderRadius: '2px' }, { ...st({ x: cr.left, y: cr.top, w: cr.width, h: cr.height }), borderRadius: '10px' }], { duration: 420, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'forwards' });
      card.style.visibility = 'hidden';
    }
    lib.animate([{ transform: 'scale(.96)', opacity: 0.4 }, { transform: 'scale(1)', opacity: 1 }], { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' });
    const a = ed.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: 'ease-in', fill: 'forwards' });
    await sleep(420);
    await animDone(a, 200);
    ed.hidden = true;
    a.cancel();
    if (card) {
      card.style.visibility = '';
      card.animate([{ transform: 'scale(1.04)' }, { transform: 'scale(1)' }], { duration: 300, easing: 'cubic-bezier(.2,.9,.3,1.2)' });
    }
    if (ghost) ghost.remove();
  }

  // ---------------------------------------------------------------- その他
  openSettings() {
    openSettings(this);
  }
  openHelp() {
    openHelp();
  }
  onKey(e) {
    if (this.editor.note) {
      if (this.editor.onKey(e)) return;
    } else if (e.key === 'Escape') {
      ui.closeTop();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n' && !ui.hasLayers()) {
      e.preventDefault();
      this.library.newNote(this.library.cur.type === 'folder' ? this.library.cur.id : null);
    }
  }
  pickBackup() {
    this.backupInput.click();
  }
  async importBackup(file) {
    const dismiss = ui.toast('読み込み中…', { duration: 60000, icon: 'upload' });
    try {
      const r = await exporter.importBackup(file);
      dismiss();
      ui.toast(`${r.notes} 冊のノートを読み込みました`, { icon: 'check' });
      this.library.render(true);
    } catch (e) {
      dismiss();
      ui.toast(e.message || '読み込めませんでした', { icon: 'info', duration: 5000 });
    }
  }
  async share(blob, name) {
    const r = await shareFile(blob, name);
    if (r === 'needs-gesture') ui.toast('準備ができました', { action: '共有する', duration: 10000, onAction: () => shareFile(blob, name) });
  }
  async exportAll() {
    const dismiss = ui.toast('バックアップを作成中…', { duration: 120000, icon: 'database' });
    try {
      if (this.editor.note) await this.editor.save();
      const blob = await exporter.exportBackup(null);
      dismiss();
      await this.share(blob, `benkyo-note-backup-${dateStamp()}.bnote`);
    } catch (e) {
      dismiss();
      console.error(e);
      ui.toast('バックアップを作成できませんでした');
    }
  }
  async shareNoteFile(id) {
    const n = store.getNote(id);
    if (!n) return;
    if (this.editor.note && this.editor.note.id === id) await this.editor.save();
    const blob = await exporter.exportBackup([id]);
    await this.share(blob, `${safeName(n.title)}.bnote`);
  }
  async exportNotePdf(id) {
    const n = store.getNote(id);
    if (!n) return;
    const dismiss = ui.toast('PDF を作成中…', { duration: 60000, icon: 'pdf' });
    try {
      const pages = await store.loadPages(id);
      const assets = new Map();
      for (const a of await store.loadAssets(id)) assets.set(a.id, await loadAssetEntry(a).ready);
      const blob = await exporter.buildPdf(pages, assets);
      for (const a of assets.values()) URL.revokeObjectURL(a.url);
      dismiss();
      await this.share(blob, `${safeName(n.title)}.pdf`);
    } catch (e) {
      dismiss();
      ui.toast('PDF を作成できませんでした');
    }
  }

  registerSW() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    // ローカル開発中はキャッシュしない（?sw を付けると有効）
    if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && !/[?&]sw\b/.test(location.search)) return;
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });
    const prompt = (w) => {
      ui.toast('新しいバージョンがあります', {
        icon: 'sparkle',
        action: '更新',
        duration: 20000,
        onAction: async () => {
          if (this.editor.note) await this.editor.save();
          w.postMessage('skipWaiting');
        },
      });
    };
    navigator.serviceWorker.register('sw.js').then((reg) => {
      if (reg.waiting && navigator.serviceWorker.controller) prompt(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) prompt(w);
        });
      });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => {});
  }
}

const app = new App();
window.__app = app;
app.start();
