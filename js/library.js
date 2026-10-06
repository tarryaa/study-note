// ライブラリ画面（フォルダツリー・ノート一覧・ドラッグで整理）
import { h, relTime, debounce, canvasToBlob, reducedMotion } from './util.js';
import { icon } from './icons.js';
import { settings, saveSettings } from './settings.js';
import * as store from './store.js';
import * as ui from './ui.js';
import { templateGrid, paperSwatches, sizeChips, coverSwatches, folderSwatches } from './pickers.js';
import { renderThumb } from './render.js';

const SORTS = [
  { id: 'updated', label: '更新日が新しい順' },
  { id: 'opened', label: '最近開いた順' },
  { id: 'created', label: '作成日が新しい順' },
  { id: 'name', label: '名前順' },
];

function sortNotes(list, mode) {
  const a = list.slice();
  if (mode === 'name') a.sort((x, y) => x.title.localeCompare(y.title, 'ja', { numeric: true }));
  else if (mode === 'created') a.sort((x, y) => y.createdAt - x.createdAt);
  else if (mode === 'opened') a.sort((x, y) => (y.openedAt || 0) - (x.openedAt || 0));
  else a.sort((x, y) => y.updatedAt - x.updatedAt);
  return a;
}

const EMPTY_ART = `<svg viewBox="0 0 220 160" class="empty-art" aria-hidden="true">
  <defs><linearGradient id="eg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".9"/><stop offset="1" stop-color="var(--accent)" stop-opacity=".55"/></linearGradient></defs>
  <ellipse cx="110" cy="146" rx="70" ry="8" fill="currentColor" opacity=".07"/>
  <g transform="rotate(-8 100 80)"><rect x="52" y="22" width="92" height="118" rx="10" fill="url(#eg)"/><rect x="62" y="28" width="78" height="106" rx="6" fill="var(--surface)"/>
  <g stroke="currentColor" stroke-opacity=".14" stroke-width="2"><line x1="72" y1="52" x2="130" y2="52"/><line x1="72" y1="66" x2="130" y2="66"/><line x1="72" y1="80" x2="130" y2="80"/><line x1="72" y1="94" x2="130" y2="94"/><line x1="72" y1="108" x2="130" y2="108"/></g>
  <path d="M74 70c8-12 14-12 16-2s8 10 14-2 12-6 16 2" fill="none" stroke="var(--accent)" stroke-width="3.2" stroke-linecap="round"/></g>
  <g transform="rotate(38 160 70)"><rect x="152" y="18" width="14" height="86" rx="4" fill="var(--text)" opacity=".85"/><path d="M152 104h14l-7 16z" fill="var(--accent)"/><rect x="152" y="18" width="14" height="12" rx="3" fill="var(--accent)" opacity=".7"/></g>
  <circle cx="40" cy="40" r="4" fill="var(--accent)" opacity=".35"/><circle cx="186" cy="124" r="3" fill="var(--accent)" opacity=".35"/><path d="M178 30l3 6 6 3-6 3-3 6-3-6-6-3 6-3z" fill="var(--accent)" opacity=".5"/>
</svg>`;

export const LOGO = `<svg viewBox="0 0 40 40" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7d8cff"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs><rect width="40" height="40" rx="11" fill="url(#lg)"/><g transform="rotate(-6 20 20)"><rect x="11" y="8" width="18" height="24" rx="3" fill="#fff"/><path d="M14 22c2-4 4-4 5-1s3 3 4 0 3-2 3 0" fill="none" stroke="#6d5cf0" stroke-width="1.8" stroke-linecap="round"/><path d="M14 14h12M14 17.5h8" stroke="#c9cdf6" stroke-width="1.4" stroke-linecap="round"/></g></svg>`;

export class Library {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.cur = { type: 'home' };
    this.query = '';
    this.selMode = false;
    this.selected = new Set();
    this.thumbs = new Map();
    this.genQ = [];
    this.sbNarrowOpen = false;
    this.mq = matchMedia('(max-width: 900px)');
    this.build();
    store.subscribe((kind) => {
      if (kind.startsWith('thumb:')) this.refreshThumb(kind.slice(6));
      else this.renderSoon();
    });
    this.mq.addEventListener ? this.mq.addEventListener('change', () => this.applySidebar()) : this.mq.addListener(() => this.applySidebar());
  }

  // ---------------------------------------------------------------- 構築
  build() {
    const r = this.root;
    r.innerHTML = '';
    // サイドバー
    this.searchIn = h('input', { class: 'search-in', type: 'search', placeholder: '検索', enterkeyhint: 'search', autocomplete: 'off' });
    this.searchIn.addEventListener('input', debounce(() => {
      this.query = this.searchIn.value.trim();
      this.renderMain(true);
    }, 150));
    const search = h('label', { class: 'search', html: icon('search') }, this.searchIn);
    this.nav = h('nav', { class: 'sb-nav' });
    const addFolder = h('button', { class: 'ib sm', title: 'フォルダを作成', html: icon('folder-plus') });
    addFolder.addEventListener('click', () => this.newFolder(null));
    this.tree = h('div', { class: 'sb-tree' });
    const trashBtn = h('button', { class: 'sb-item', dataset: { drop: 'trash', view: 'trash' }, html: `${icon('trash')}<span>ゴミ箱</span><em class="cnt"></em>` });
    trashBtn.addEventListener('click', () => this.go({ type: 'trash' }));
    this.trashBtn = trashBtn;
    const setBtn = h('button', { class: 'sb-item', html: `${icon('settings')}<span>設定</span>` });
    setBtn.addEventListener('click', () => this.app.openSettings());
    this.sb = h(
      'aside',
      { class: 'sidebar' },
      h('div', { class: 'sb-logo' }, h('span', { class: 'logo-mark', html: LOGO }), h('div', { class: 'logo-text' }, h('b', { text: '勉強ノート' }), h('small', { text: 'Study Notebook' }))),
      search,
      this.nav,
      h('div', { class: 'sb-sec', dataset: { drop: 'root' } }, h('span', { text: 'フォルダ' }), addFolder),
      h('div', { class: 'sb-tree-wrap' }, this.tree),
      h('div', { class: 'sb-foot' }, trashBtn, setBtn)
    );
    this.scrim = h('div', { class: 'sb-scrim' });
    this.scrim.addEventListener('click', () => this.toggleSidebar(false));

    // メイン
    this.sbToggle = h('button', { class: 'ib', title: 'サイドバー', html: icon('sidebar') });
    this.sbToggle.addEventListener('click', () => this.toggleSidebar());
    this.crumbs = h('div', { class: 'crumbs' });
    this.sortBtn = h('button', { class: 'ib', title: '並べ替え', html: icon('sort') });
    this.sortBtn.addEventListener('click', () => this.sortMenu());
    this.viewBtn = h('button', { class: 'ib', title: '表示切替' });
    this.viewBtn.addEventListener('click', () => {
      settings.libView = settings.libView === 'grid' ? 'list' : 'grid';
      saveSettings();
      this.renderMain(true);
    });
    this.selBtn = h('button', { class: 'pill-btn', text: '選択' });
    this.selBtn.addEventListener('click', () => this.setSelMode(!this.selMode));
    this.newBtn = h('button', { class: 'btn primary new-btn', html: `${icon('plus')}<span>新規</span>` });
    this.newBtn.addEventListener('click', () => this.newMenu(this.newBtn));
    this.title = h('h1', { class: 'lib-title' });
    this.sub = h('div', { class: 'lib-sub' });
    this.head = h(
      'header',
      { class: 'lib-head' },
      h('div', { class: 'lh-top' }, this.sbToggle, this.crumbs, h('div', { class: 'grow' }), this.sortBtn, this.viewBtn, this.selBtn, this.newBtn),
      h('div', { class: 'lh-title' }, this.title, this.sub)
    );
    this.scroll = h('div', { class: 'lib-scroll' });
    this.scroll.addEventListener('scroll', () => this.head.classList.toggle('scrolled', this.scroll.scrollTop > 4), { passive: true });
    this.selBar = h('div', { class: 'sel-bar glass' });
    this.main = h('main', { class: 'lib-main' }, this.head, this.scroll, this.selBar);
    r.append(this.sb, this.scrim, this.main);
    this.applySidebar();
  }

  applySidebar() {
    const narrow = this.mq.matches;
    this.root.classList.toggle('narrow', narrow);
    const hidden = narrow ? !this.sbNarrowOpen : !settings.sidebar;
    this.root.classList.toggle('sb-hidden', hidden);
  }
  toggleSidebar(force) {
    if (this.mq.matches) this.sbNarrowOpen = force == null ? !this.sbNarrowOpen : force;
    else {
      settings.sidebar = force == null ? !settings.sidebar : force;
      saveSettings();
    }
    this.applySidebar();
  }

  go(view) {
    this.cur = view;
    this.query = '';
    this.searchIn.value = '';
    this.setSelMode(false, true);
    if (this.mq.matches) this.toggleSidebar(false);
    this.render(true);
    this.scroll.scrollTop = 0;
  }

  // ---------------------------------------------------------------- 描画
  renderSoon() {
    if (this._rs) return;
    this._rs = requestAnimationFrame(() => {
      this._rs = 0;
      this.render(false);
    });
  }
  render(animate) {
    this.renderNav();
    this.renderTree();
    this.renderMain(animate);
  }
  renderNav() {
    const live = store.liveNotes();
    const items = [
      { type: 'home', icon: 'book', label: 'ホーム', count: null, drop: 'root' },
      { type: 'all', icon: 'notes', label: 'すべてのノート', count: live.length },
      { type: 'recent', icon: 'clock', label: '最近使った', count: null },
      { type: 'fav', icon: 'star', label: 'お気に入り', count: live.filter((n) => n.favorite).length || null, drop: 'fav' },
    ];
    this.nav.innerHTML = '';
    for (const it of items) {
      const b = h('button', { class: 'sb-item' + (!this.query && this.cur.type === it.type ? ' active' : ''), html: `${icon(it.icon)}<span>${it.label}</span>${it.count ? `<em class="cnt">${it.count}</em>` : ''}` });
      if (it.drop) b.dataset.drop = it.drop;
      b.addEventListener('click', () => this.go({ type: it.type }));
      this.nav.append(b);
    }
    const trashN = store.state.notes.filter((n) => n.deletedAt).length;
    this.trashBtn.classList.toggle('active', !this.query && this.cur.type === 'trash');
    this.trashBtn.querySelector('.cnt').textContent = trashN || '';
  }
  renderTree() {
    const tree = this.tree;
    tree.innerHTML = '';
    const build = (parentId, depth) => {
      for (const f of store.childFolders(parentId)) {
        const kids = store.childFolders(f.id);
        const open = settings.expanded[f.id] !== false;
        const count = store.notesIn(f.id, true).length;
        const chev = h('button', { class: 'tree-chev' + (kids.length ? '' : ' none') + (open ? ' open' : ''), html: icon('chev-right'), 'aria-label': '開閉' });
        chev.addEventListener('click', (e) => {
          e.stopPropagation();
          settings.expanded[f.id] = !open;
          saveSettings();
          this.renderTree();
        });
        const ic = h('span', { class: 'tree-ic', html: icon('folder-fill') });
        ic.style.color = f.color;
        const row = h(
          'div',
          { class: 'tree-row' + (!this.query && this.cur.type === 'folder' && this.cur.id === f.id ? ' active' : ''), dataset: { drop: 'folder:' + f.id } },
          chev,
          ic,
          h('span', { class: 'tree-name', text: f.name }),
          h('em', { class: 'cnt', text: count || '' })
        );
        row.style.setProperty('--depth', depth);
        ui.pressable(row, {
          ignore: (e) => !!e.target.closest('.tree-chev'),
          onTap: () => this.go({ type: 'folder', id: f.id }),
          onLong: () => this.folderMenu(f, row),
          onDragStart: (st, e) => this.startDrag({ kind: 'folder', id: f.id }, row, e),
          onDragMove: (e) => this.dragMove(e),
          onDragEnd: (e, s, c) => this.dragEnd(e, c),
        });
        tree.append(row);
        if (kids.length && open) build(f.id, depth + 1);
      }
    };
    build(null, 0);
    if (!store.state.folders.length) {
      const b = h('button', { class: 'tree-empty', html: `${icon('folder-plus')}<span>フォルダを作成</span>` });
      b.addEventListener('click', () => this.newFolder(null));
      tree.append(b);
    }
  }

  collect() {
    const q = this.query.toLowerCase();
    const live = store.liveNotes();
    const r = { notes: [], folders: [], recent: [], title: '', crumbs: null, empty: null };
    if (q) {
      r.notes = sortNotes(live.filter((n) => n.title.toLowerCase().includes(q)), settings.libSort);
      r.folders = store.state.folders.filter((f) => f.name.toLowerCase().includes(q));
      r.title = '検索';
      r.empty = { title: '見つかりませんでした', text: `「${this.query}」に一致するノートはありません` };
      return r;
    }
    switch (this.cur.type) {
      case 'home':
        r.title = 'ホーム';
        r.folders = store.childFolders(null);
        r.notes = sortNotes(live.filter((n) => !n.folderId), settings.libSort);
        r.recent = live.slice().sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0)).slice(0, 10);
        if (r.recent.length < 3) r.recent = [];
        r.empty = { title: 'ようこそ！', text: '最初のノートを作って、さっそく書いてみましょう', home: true };
        break;
      case 'all':
        r.title = 'すべてのノート';
        r.notes = sortNotes(live, settings.libSort);
        r.empty = { title: 'ノートがありません', text: '右上の「新規」から作成できます' };
        break;
      case 'recent':
        r.title = '最近使った';
        r.notes = live.slice().sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0)).slice(0, 30);
        r.empty = { title: 'まだありません', text: 'ノートを開くとここに表示されます' };
        break;
      case 'fav':
        r.title = 'お気に入り';
        r.notes = sortNotes(live.filter((n) => n.favorite), settings.libSort);
        r.empty = { title: 'お気に入りはまだありません', text: 'ノートのメニューから ★ を付けられます' };
        break;
      case 'trash':
        r.title = 'ゴミ箱';
        r.notes = store.state.notes.filter((n) => n.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
        r.empty = { title: 'ゴミ箱は空です', text: '削除したノートは 30 日間ここに残ります' };
        break;
      case 'folder': {
        const f = store.getFolder(this.cur.id);
        if (!f) {
          this.cur = { type: 'home' };
          return this.collect();
        }
        r.title = f.name;
        r.folder = f;
        r.crumbs = store.folderPath(f.id);
        r.folders = store.childFolders(f.id);
        r.notes = sortNotes(live.filter((n) => n.folderId === f.id), settings.libSort);
        r.empty = { title: 'このフォルダは空です', text: 'ノートを作るか、ほかのノートをドラッグして入れましょう', folder: f };
        break;
      }
    }
    return r;
  }

  renderMain(animate) {
    const d = this.collect();
    this.title.textContent = d.title;
    const nN = d.notes.length, nF = d.folders.length;
    this.sub.textContent = [nF ? `${nF} フォルダ` : '', nN ? `${nN} ノート` : ''].filter(Boolean).join('・');
    // パンくず
    this.crumbs.innerHTML = '';
    if (d.crumbs) {
      const home = h('button', { class: 'crumb', text: 'ホーム' });
      home.addEventListener('click', () => this.go({ type: 'home' }));
      this.crumbs.append(home);
      d.crumbs.slice(0, -1).forEach((f) => {
        const b = h('button', { class: 'crumb', text: f.name });
        b.addEventListener('click', () => this.go({ type: 'folder', id: f.id }));
        this.crumbs.append(h('span', { class: 'crumb-sep', html: icon('chev-right') }), b);
      });
    }
    this.viewBtn.innerHTML = icon(settings.libView === 'grid' ? 'list' : 'grid');
    this.selBtn.hidden = !nN;
    this.newBtn.hidden = this.cur.type === 'trash' && !this.query;
    const sc = this.scroll;
    const prev = sc.scrollTop;
    sc.innerHTML = '';
    sc.classList.toggle('anim', !!animate && !reducedMotion());
    let i = 0;
    const isTrash = this.cur.type === 'trash' && !this.query;

    if (isTrash && nN) {
      const bar = h('div', { class: 'trash-bar' }, h('span', { text: '削除したノートは 30 日後に自動で完全に削除されます' }));
      const b = h('button', { class: 'btn danger sm', text: 'ゴミ箱を空にする' });
      b.addEventListener('click', () => this.deleteForever(d.notes.map((n) => n.id)));
      bar.append(b);
      sc.append(bar);
    }
    if (d.recent.length) {
      const strip = h('div', { class: 'recent-strip' });
      for (const n of d.recent) strip.append(this.recentCard(n, i++));
      sc.append(h('section', { class: 'lib-sec' }, h('h2', { text: '最近使ったノート' }), strip));
    }
    if (nF) {
      const grid = h('div', { class: 'folder-grid' });
      for (const f of d.folders) grid.append(this.folderCard(f, i++));
      sc.append(h('section', { class: 'lib-sec' }, d.recent.length || nN ? h('h2', { text: 'フォルダ' }) : null, grid));
    }
    if (nN) {
      const grid = h('div', { class: settings.libView === 'list' ? 'note-list' : 'note-grid' });
      for (const n of d.notes) grid.append(settings.libView === 'list' ? this.noteRow(n, i++) : this.noteCard(n, i++));
      sc.append(h('section', { class: 'lib-sec' }, nF || d.recent.length ? h('h2', { text: 'ノート' }) : null, grid));
    }
    if (!nN && !nF) sc.append(this.emptyState(d.empty));
    if (!animate) sc.scrollTop = prev;
    this.renderSelBar();
    this.pumpGen();
  }

  emptyState(e) {
    const el = h('div', { class: 'empty' }, h('div', { html: EMPTY_ART }), h('h3', { text: e.title }), h('p', { text: e.text }));
    if (e.home || e.folder) {
      const row = h('div', { class: 'empty-actions' });
      const nb = h('button', { class: 'btn primary', html: `${icon('plus')}<span>ノートを作成</span>` });
      nb.addEventListener('click', () => this.newNote(e.folder ? e.folder.id : null));
      const fb = h('button', { class: 'btn', html: `${icon('folder-plus')}<span>${e.folder ? 'サブフォルダ' : 'フォルダを作成'}</span>` });
      fb.addEventListener('click', () => this.newFolder(e.folder ? e.folder.id : null));
      row.append(nb, fb);
      el.append(row);
    }
    return el;
  }

  coverEl(n) {
    const img = h('img', { alt: '', draggable: 'false', decoding: 'async' });
    img.addEventListener('load', () => img.classList.add('ok'));
    const paper = h('div', { class: 'nc-paper' }, img);
    paper.style.background = (n.defaults && n.defaults.paper) || '#fff';
    const el = h(
      'div',
      { class: 'nc-cover' },
      h('span', { class: 'nc-spine' }),
      paper,
      n.favorite ? h('span', { class: 'nc-fav', html: icon('star-fill') }) : null,
      h('span', { class: 'nc-check', html: icon('check') })
    );
    el.style.setProperty('--cover', store.coverColor(n.cover));
    this.loadThumb(n, img);
    return el;
  }
  bindNote(el, n, coverEl, moreBtn) {
    if (moreBtn) {
      moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.noteMenu(n, moreBtn);
      });
    }
    ui.pressable(el, {
      ignore: (e) => !!e.target.closest('.nc-more'),
      onTap: () => this.onNoteTap(n, coverEl),
      onLong: () => (this.selMode ? this.toggleSel(n.id) : this.noteMenu(n, coverEl)),
      onDragStart: (st, e) => {
        if (n.deletedAt) return;
        this.startDrag({ kind: 'note', id: n.id }, coverEl, e);
      },
      onDragMove: (e) => this.dragMove(e),
      onDragEnd: (e, s, c) => this.dragEnd(e, c),
    });
  }
  noteCard(n, i) {
    const cover = this.coverEl(n);
    const more = h('button', { class: 'nc-more', html: icon('more'), 'aria-label': 'メニュー' });
    const card = h(
      'div',
      { class: 'note-card' + (this.selected.has(n.id) ? ' selected' : ''), dataset: { id: n.id } },
      cover,
      h('div', { class: 'nc-row' }, h('div', { class: 'nc-meta' }, h('div', { class: 'nc-title', text: n.title }), h('div', { class: 'nc-sub', text: this.noteSub(n) })), more)
    );
    card.style.setProperty('--i', Math.min(i, 24));
    this.bindNote(card, n, cover, more);
    return card;
  }
  noteRow(n, i) {
    const cover = this.coverEl(n);
    const more = h('button', { class: 'nc-more', html: icon('more'), 'aria-label': 'メニュー' });
    const f = n.folderId && store.getFolder(n.folderId);
    const row = h(
      'div',
      { class: 'note-row' + (this.selected.has(n.id) ? ' selected' : ''), dataset: { id: n.id } },
      cover,
      h('div', { class: 'nr-meta' }, h('div', { class: 'nc-title', text: n.title }), h('div', { class: 'nc-sub', text: this.noteSub(n) })),
      f ? h('span', { class: 'nr-folder', html: `${icon('folder-fill')}<span></span>` }) : null,
      more
    );
    if (f) {
      const tag = row.querySelector('.nr-folder');
      tag.style.color = f.color;
      tag.querySelector('span').textContent = f.name;
    }
    row.style.setProperty('--i', Math.min(i, 24));
    this.bindNote(row, n, cover, more);
    return row;
  }
  recentCard(n, i) {
    const cover = this.coverEl(n);
    const card = h('div', { class: 'recent-card', dataset: { id: n.id } }, cover, h('div', { class: 'nc-title', text: n.title }));
    card.style.setProperty('--i', i);
    this.bindNote(card, n, cover, null);
    return card;
  }
  noteSub(n) {
    const p = (n.pageIds || []).length;
    if (n.deletedAt) return `削除: ${relTime(n.deletedAt)}`;
    return `${relTime(n.updatedAt)}・${p}ページ`;
  }
  folderCard(f, i) {
    const count = store.notesIn(f.id, true).length;
    const subs = store.childFolders(f.id).length;
    const ic = h('span', { class: 'fc-ic', html: icon('folder-fill') });
    const more = h('button', { class: 'nc-more', html: icon('more'), 'aria-label': 'メニュー' });
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      this.folderMenu(f, more);
    });
    const el = h(
      'div',
      { class: 'folder-card', dataset: { drop: 'folder:' + f.id } },
      ic,
      h('div', { class: 'fc-meta' }, h('div', { class: 'fc-name', text: f.name }), h('div', { class: 'fc-sub', text: [`${count} ノート`, subs ? `${subs} フォルダ` : ''].filter(Boolean).join('・') })),
      more
    );
    el.style.setProperty('--fc', f.color);
    el.style.setProperty('--i', Math.min(i, 24));
    ui.pressable(el, {
      ignore: (e) => !!e.target.closest('.nc-more'),
      onTap: () => this.go({ type: 'folder', id: f.id }),
      onLong: () => this.folderMenu(f, el),
      onDragStart: (st, e) => this.startDrag({ kind: 'folder', id: f.id }, el, e),
      onDragMove: (e) => this.dragMove(e),
      onDragEnd: (e, s, c) => this.dragEnd(e, c),
    });
    return el;
  }

  cardCover(id) {
    const el = this.scroll.querySelector(`.note-card[data-id="${CSS.escape(id)}"] .nc-cover, .note-row[data-id="${CSS.escape(id)}"] .nc-cover, .recent-card[data-id="${CSS.escape(id)}"] .nc-cover`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const sr = this.scroll.getBoundingClientRect();
    if (r.bottom < sr.top || r.top > sr.bottom) return null;
    return el;
  }

  // ---------------------------------------------------------------- サムネイル
  async loadThumb(n, img) {
    const c = this.thumbs.get(n.id);
    if (c) {
      img.src = c.url;
      return;
    }
    let rec = null;
    try {
      rec = await store.getThumb(n.id);
    } catch (_) {}
    if (rec && rec.blob) {
      const c2 = this.thumbs.get(n.id);
      if (c2) {
        img.src = c2.url;
        return;
      }
      const url = URL.createObjectURL(rec.blob);
      this.thumbs.set(n.id, { url });
      img.src = url;
    } else if (!this.genQ.includes(n.id)) this.genQ.push(n.id);
  }
  refreshThumb(id) {
    const c = this.thumbs.get(id);
    if (c) URL.revokeObjectURL(c.url);
    this.thumbs.delete(id);
    const n = store.getNote(id);
    if (!n) return;
    for (const img of this.scroll.querySelectorAll(`[data-id="${CSS.escape(id)}"] .nc-paper img`)) {
      img.classList.remove('ok');
      this.loadThumb(n, img);
    }
  }
  // サムネイルが無いノート（バックアップ復元直後など）はバックグラウンドで作る
  pumpGen() {
    if (this._gen || !this.genQ.length) return;
    this._gen = true;
    setTimeout(async () => {
      while (this.genQ.length) {
        const id = this.genQ.shift();
        try {
          const pages = await store.loadPages(id);
          const assets = await store.loadAssets(id);
          const map = new Map();
          const { loadAssetEntry } = await import('./editor.js');
          for (const a of assets) if (pages[0].items.some((it) => it.asset === a.id)) map.set(a.id, await loadAssetEntry(a).ready);
          const cv = renderThumb(pages[0], 360, map);
          await store.setThumb(id, await canvasToBlob(cv, 'image/jpeg', 0.85));
          for (const e of map.values()) URL.revokeObjectURL(e.url);
        } catch (_) {}
        await new Promise((r) => setTimeout(r, 30));
      }
      this._gen = false;
    }, 300);
  }

  // ---------------------------------------------------------------- 選択モード
  setSelMode(on, silent) {
    this.selMode = on;
    this.selected.clear();
    this.root.classList.toggle('selecting', on);
    this.selBtn.textContent = on ? '完了' : '選択';
    this.selBtn.classList.toggle('on', on);
    if (!silent) this.renderMain(false);
  }
  toggleSel(id) {
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    for (const el of this.scroll.querySelectorAll(`[data-id="${CSS.escape(id)}"]`)) el.classList.toggle('selected', this.selected.has(id));
    this.renderSelBar();
  }
  onNoteTap(n, coverEl) {
    if (this.selMode) return this.toggleSel(n.id);
    if (n.deletedAt) return this.noteMenu(n, coverEl);
    this.app.openNote(n.id, coverEl);
  }
  renderSelBar() {
    const b = this.selBar;
    b.classList.toggle('show', this.selMode);
    if (!this.selMode) return;
    b.innerHTML = '';
    const ids = [...this.selected];
    const n = ids.length;
    const btn = (ic, label, fn, cls = '') => {
      const x = h('button', { class: 'sb-act ' + cls, html: `${icon(ic)}<span>${label}</span>` });
      x.disabled = !n;
      x.addEventListener('click', () => fn(x));
      return x;
    };
    const all = h('button', { class: 'pill-btn', text: 'すべて選択' });
    all.addEventListener('click', () => {
      for (const el of this.scroll.querySelectorAll('[data-id]')) this.selected.add(el.dataset.id);
      this.renderMain(false);
    });
    b.append(h('span', { class: 'sel-count', text: n ? `${n} 件選択` : 'ノートを選択' }), all, h('div', { class: 'grow' }));
    if (this.cur.type === 'trash') {
      b.append(
        btn('restore', '元に戻す', async () => {
          await store.restoreNotes(ids);
          this.setSelMode(false);
        }),
        btn('trash', '完全に削除', () => this.deleteForever(ids), 'danger')
      );
    } else {
      b.append(
        btn('folder-move', '移動', () => this.moveDialog(ids)),
        btn('star', 'お気に入り', async () => {
          const allFav = ids.every((id) => store.getNote(id).favorite);
          await store.updateNotes(ids, { favorite: !allFav });
          this.setSelMode(false);
        }),
        btn('duplicate', '複製', async () => {
          for (const id of ids) await store.duplicateNote(id);
          ui.toast(`${ids.length} 件を複製しました`, { icon: 'duplicate' });
          this.setSelMode(false);
        }),
        btn('trash', '削除', () => {
          this.trash(ids);
          this.setSelMode(false);
        }, 'danger')
      );
    }
  }

  // ---------------------------------------------------------------- ドラッグ＆ドロップ
  startDrag(payload, srcEl, e) {
    if (this.selMode && payload.kind === 'note' && this.selected.has(payload.id)) payload.ids = [...this.selected];
    else if (payload.kind === 'note') payload.ids = [payload.id];
    const r = srcEl.getBoundingClientRect();
    const ghost = srcEl.cloneNode(true);
    ghost.classList.add('drag-ghost');
    Object.assign(ghost.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    if (payload.ids && payload.ids.length > 1) ghost.append(h('span', { class: 'drag-badge', text: String(payload.ids.length) }));
    document.body.append(ghost);
    srcEl.classList.add('drag-src');
    this.drag = { payload, ghost, src: srcEl, r, ox: e.clientX - r.left, oy: e.clientY - r.top, target: null };
    this.root.classList.add('dragging');
    if (this.mq.matches && !this.sbNarrowOpen) this.toggleSidebar(true);
    this.dragMove(e);
  }
  dragMove(e) {
    const d = this.drag;
    if (!d) return;
    d.ghost.style.transform = `translate(${e.clientX - d.ox - d.r.left}px, ${e.clientY - d.oy - d.r.top}px) rotate(-3deg) scale(1.05)`;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const t = el && el.closest('[data-drop]');
    const target = t && t !== d.src && this.canDrop(d.payload, t.dataset.drop) ? t : null;
    if (target !== d.target) {
      if (d.target) d.target.classList.remove('drop-over');
      if (target) target.classList.add('drop-over');
      d.target = target;
    }
  }
  async dragEnd(e, cancel) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.root.classList.remove('dragging');
    if (d.target) d.target.classList.remove('drop-over');
    if (!cancel && d.target) {
      const tr = d.target.getBoundingClientRect();
      const dx = tr.left + tr.width / 2 - (d.r.left + d.r.width / 2), dy = tr.top + tr.height / 2 - (d.r.top + d.r.height / 2);
      const anim = d.ghost.animate(
        [{ transform: d.ghost.style.transform, opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(.12)`, opacity: 0 }],
        { duration: 320, easing: 'cubic-bezier(.4,0,.2,1)' }
      );
      anim.onfinish = () => d.ghost.remove();
      d.target.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: 380, delay: 200, easing: 'ease-out' });
      d.src.classList.remove('drag-src');
      await this.performDrop(d.payload, d.target.dataset.drop);
      if (this.mq.matches) setTimeout(() => this.toggleSidebar(false), 450);
    } else {
      const anim = d.ghost.animate([{ transform: d.ghost.style.transform }, { transform: 'translate(0,0) scale(1)' }], { duration: 300, easing: 'cubic-bezier(.2,.9,.3,1.1)' });
      anim.onfinish = () => {
        d.ghost.remove();
        d.src.classList.remove('drag-src');
      };
    }
  }
  canDrop(p, drop) {
    if (drop === 'trash') return true;
    if (p.kind === 'note') {
      if (drop === 'fav' || drop === 'root') return true;
      if (drop.startsWith('folder:')) return !p.ids.every((id) => store.getNote(id).folderId === drop.slice(7));
      return false;
    }
    if (p.kind === 'folder') {
      if (drop === 'root') return !!store.getFolder(p.id).parentId;
      if (drop.startsWith('folder:')) {
        const id = drop.slice(7);
        return id !== p.id && !store.descendantIds(p.id).includes(id) && store.getFolder(p.id).parentId !== id;
      }
    }
    return false;
  }
  async performDrop(p, drop) {
    if (p.kind === 'note') {
      const ids = p.ids;
      if (drop === 'trash') return this.trash(ids);
      if (drop === 'fav') {
        await store.updateNotes(ids, { favorite: true });
        ui.toast('お気に入りに追加しました', { icon: 'star-fill' });
        return;
      }
      const fid = drop === 'root' ? null : drop.slice(7);
      const prev = ids.map((id) => [id, store.getNote(id).folderId]);
      await store.updateNotes(ids, { folderId: fid });
      if (this.selMode) this.setSelMode(false);
      const name = fid ? store.getFolder(fid).name : 'ホーム';
      ui.toast(`「${name}」へ移動しました`, {
        icon: 'folder-move',
        action: '元に戻す',
        onAction: async () => {
          for (const [id, f] of prev) await store.updateNote(id, { folderId: f }, true);
          store.notifyNotes();
        },
      });
    } else if (p.kind === 'folder') {
      if (drop === 'trash') return this.deleteFolder(store.getFolder(p.id));
      const parent = drop === 'root' ? null : drop.slice(7);
      const ok = await store.moveFolder(p.id, parent);
      if (ok && parent) {
        settings.expanded[parent] = true;
        saveSettings();
        this.renderTree();
      }
      if (ok) ui.toast('フォルダを移動しました', { icon: 'folder-move' });
    }
  }

  // ---------------------------------------------------------------- メニュー・ダイアログ
  sortMenu() {
    ui.menu(this.sortBtn, [
      { header: '並べ替え' },
      ...SORTS.map((s) => ({
        label: s.label,
        checked: settings.libSort === s.id,
        action: () => {
          settings.libSort = s.id;
          saveSettings();
          this.renderMain(true);
        },
      })),
    ]);
  }
  newMenu(anchor) {
    const fid = this.cur.type === 'folder' ? this.cur.id : null;
    ui.menu(anchor, [
      { icon: 'notes', label: '新しいノート', action: () => this.newNote(fid) },
      { icon: 'folder-plus', label: fid ? '新しいサブフォルダ' : '新しいフォルダ', action: () => this.newFolder(fid) },
      '-',
      { icon: 'upload', label: 'ファイルから読み込む…', action: () => this.app.pickBackup() },
    ]);
  }
  noteMenu(n, anchor) {
    if (n.deletedAt) {
      return ui.menu(anchor, [
        { icon: 'restore', label: '元に戻す', action: () => store.restoreNotes([n.id]).then(() => ui.toast('ノートを元に戻しました', { icon: 'restore' })) },
        { icon: 'trash', label: '完全に削除', danger: true, action: () => this.deleteForever([n.id]) },
      ]);
    }
    ui.menu(anchor, [
      { icon: 'book', label: '開く', action: () => this.app.openNote(n.id, anchor.classList.contains('nc-cover') ? anchor : null) },
      { icon: 'edit', label: '名前を変更', action: () => this.renameNote(n) },
      { icon: 'folder-move', label: 'フォルダへ移動…', action: () => this.moveDialog([n.id]) },
      { icon: 'duplicate', label: '複製', action: () => store.duplicateNote(n.id).then(() => ui.toast('複製しました', { icon: 'duplicate' })) },
      { icon: n.favorite ? 'star-fill' : 'star', label: n.favorite ? 'お気に入りから外す' : 'お気に入りに追加', action: () => store.updateNote(n.id, { favorite: !n.favorite }) },
      { icon: 'palette', label: '表紙の色…', action: () => this.coverMenu(n.id, anchor) },
      '-',
      { icon: 'pdf', label: 'PDF で書き出し', action: () => this.app.exportNotePdf(n.id) },
      { icon: 'share', label: 'ノートファイルを共有', action: () => this.app.shareNoteFile(n.id) },
      '-',
      { icon: 'trash', label: 'ゴミ箱へ移動', danger: true, action: () => this.trash([n.id]) },
    ]);
  }
  coverMenu(id, anchor) {
    const n = store.getNote(id);
    if (!n) return;
    const st = { cover: n.cover };
    let pop = null;
    const sw = coverSwatches(st, async () => {
      await store.updateNote(id, { cover: st.cover });
      if (pop) pop.close();
    });
    pop = ui.popover(anchor, h('div', { class: 'color-pop' }, h('div', { class: 'tp-label', text: '表紙の色' }), sw));
  }
  async renameNote(n) {
    const v = await ui.promptDialog({ title: 'ノートの名前', value: n.title, placeholder: '無題のノート' });
    if (v == null) return;
    await store.updateNote(n.id, { title: v || '無題のノート' });
  }
  async trash(ids) {
    await store.trashNotes(ids);
    ui.toast(ids.length > 1 ? `${ids.length} 件をゴミ箱に移動しました` : 'ゴミ箱に移動しました', {
      icon: 'trash',
      action: '元に戻す',
      onAction: () => store.restoreNotes(ids),
    });
  }
  async deleteForever(ids) {
    if (!ids.length) return;
    const ok = await ui.confirmDialog({
      title: '完全に削除しますか？',
      message: `${ids.length} 件のノートを完全に削除します。この操作は取り消せません。`,
      ok: '完全に削除',
      danger: true,
    });
    if (!ok) return;
    await store.deleteNotesForever(ids);
    for (const id of ids) {
      const c = this.thumbs.get(id);
      if (c) URL.revokeObjectURL(c.url);
      this.thumbs.delete(id);
    }
    if (this.selMode) this.setSelMode(false);
    ui.toast('削除しました', { icon: 'trash' });
  }

  folderPicker(onPick, { exclude = null, allowRoot = true, current = null } = {}) {
    const list = h('div', { class: 'folder-pick' });
    const add = (label, id, depth, color, disabled) => {
      const b = h('button', { class: 'fp-row' + (id === current ? ' cur' : ''), html: `${icon(id ? 'folder-fill' : 'book')}<span></span>` });
      b.querySelector('span').textContent = label;
      b.style.setProperty('--depth', depth);
      if (color) b.querySelector('svg').style.color = color;
      if (disabled) b.disabled = true;
      b.addEventListener('click', () => onPick(id));
      list.append(b);
    };
    if (allowRoot) add('ホーム（フォルダなし）', null, 0, null, current === null);
    const walk = (pid, depth) => {
      for (const f of store.childFolders(pid)) {
        const bad = exclude && store.descendantIds(exclude).includes(f.id);
        add(f.name, f.id, depth + (allowRoot ? 1 : 0), f.color, bad || f.id === current);
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return list;
  }
  moveDialog(ids) {
    const cur = ids.length === 1 ? store.getNote(ids[0]).folderId || null : undefined;
    let s = null;
    const pick = async (fid) => {
      s.close();
      await store.updateNotes(ids, { folderId: fid });
      if (this.selMode) this.setSelMode(false);
      ui.toast(`「${fid ? store.getFolder(fid).name : 'ホーム'}」へ移動しました`, { icon: 'folder-move' });
    };
    const nf = h('button', { class: 'btn', html: `${icon('folder-plus')}<span>新しいフォルダ</span>` });
    nf.addEventListener('click', async () => {
      const f = await this.newFolder(null, true);
      if (f) pick(f.id);
    });
    s = ui.sheet({ title: ids.length > 1 ? `${ids.length} 件を移動` : 'フォルダへ移動', body: this.folderPicker(pick, { current: cur }), foot: [nf] });
  }
  moveFolderDialog(f) {
    let s = null;
    s = ui.sheet({
      title: `「${f.name}」を移動`,
      body: this.folderPicker(
        async (pid) => {
          s.close();
          const ok = await store.moveFolder(f.id, pid);
          if (ok) ui.toast('フォルダを移動しました', { icon: 'folder-move' });
        },
        { exclude: f.id, current: f.parentId || null }
      ),
    });
  }
  folderMenu(f, anchor) {
    ui.menu(anchor, [
      { icon: 'edit', label: '名前を変更', action: () => this.renameFolder(f) },
      { icon: 'palette', label: '色を変更…', action: () => this.folderColor(f, anchor) },
      { icon: 'folder-plus', label: 'サブフォルダを作成', action: () => this.newFolder(f.id) },
      { icon: 'notes', label: 'ここにノートを作成', action: () => this.newNote(f.id) },
      { icon: 'folder-move', label: '移動…', action: () => this.moveFolderDialog(f) },
      '-',
      { icon: 'trash', label: 'フォルダを削除', danger: true, action: () => this.deleteFolder(f) },
    ]);
  }
  folderColor(f, anchor) {
    const st = { color: f.color };
    let pop = null;
    const sw = folderSwatches(st, async () => {
      await store.updateFolder(f.id, { color: st.color });
      if (pop) pop.close();
    });
    pop = ui.popover(anchor, h('div', { class: 'color-pop' }, h('div', { class: 'tp-label', text: 'フォルダの色' }), sw));
  }
  async renameFolder(f) {
    const v = await ui.promptDialog({ title: 'フォルダの名前', value: f.name });
    if (v) await store.updateFolder(f.id, { name: v });
  }
  async deleteFolder(f) {
    if (!f) return;
    const n = store.notesIn(f.id, true).length;
    const ok = await ui.confirmDialog({
      title: `「${f.name}」を削除しますか？`,
      message: n ? `中のノート ${n} 件はゴミ箱に移動します（30 日以内なら復元できます）。` : 'サブフォルダも削除されます。',
      ok: '削除',
      danger: true,
    });
    if (!ok) return;
    await store.deleteFolder(f.id);
    if (this.cur.type === 'folder' && !store.getFolder(this.cur.id)) this.go({ type: f.parentId ? 'folder' : 'home', id: f.parentId });
    ui.toast('フォルダを削除しました', { icon: 'trash' });
  }
  async newFolder(parentId, returnOnly) {
    const st = { color: store.FOLDER_COLORS[store.state.folders.length % store.FOLDER_COLORS.length] };
    const name = h('input', { class: 'input big', placeholder: 'フォルダ名（例: 数学）', enterkeyhint: 'done', autocomplete: 'off' });
    const sw = folderSwatches(st, () => preview.style.setProperty('--fc', st.color));
    const preview = h('span', { class: 'nf-preview', html: icon('folder-fill') });
    preview.style.setProperty('--fc', st.color);
    const okBtn = h('button', { class: 'btn primary', text: '作成' });
    const cancel = h('button', { class: 'btn', text: 'キャンセル' });
    const parent = parentId && store.getFolder(parentId);
    return new Promise((resolve) => {
      let done = false;
      const s = ui.sheet({
        title: parent ? `「${parent.name}」にフォルダを作成` : '新しいフォルダ',
        body: h('div', { class: 'nf-body' }, h('div', { class: 'nf-row' }, preview, name), h('h4', { text: '色' }), sw),
        foot: [cancel, okBtn],
        className: 'dialog',
        onClose: () => {
          if (!done) resolve(null);
        },
      });
      const submit = async () => {
        if (done) return;
        done = true;
        s.close();
        const f = await store.createFolder({ name: name.value.trim() || '新しいフォルダ', parentId, color: st.color });
        if (parentId) {
          settings.expanded[parentId] = true;
          saveSettings();
        }
        resolve(f);
        if (!returnOnly) ui.toast(`フォルダ「${f.name}」を作成しました`, { icon: 'folder' });
      };
      okBtn.addEventListener('click', submit);
      name.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          submit();
        }
      });
      cancel.addEventListener('click', () => s.close());
      name.focus();
    });
  }
  newNote(folderId) {
    const st = { ...settings.newNote };
    const title = h('input', { class: 'input big', placeholder: '無題のノート', enterkeyhint: 'done', autocomplete: 'off' });
    const coverPrev = h('div', { class: 'nn-cover' }, h('span', { class: 'nc-spine' }), h('div', { class: 'nn-paper' }));
    const upd = () => {
      coverPrev.style.setProperty('--cover', store.coverColor(st.cover));
      coverPrev.querySelector('.nn-paper').style.background = st.paper;
    };
    const tg = templateGrid(st);
    const body = h(
      'div',
      { class: 'nn-body' },
      h('div', { class: 'nn-top' }, coverPrev, h('div', { class: 'nn-fields' }, title, h('h4', { text: '表紙の色' }), coverSwatches(st, upd))),
      h('h4', { text: 'テンプレート' }),
      tg,
      h('div', { class: 'nn-2col' }, h('div', {}, h('h4', { text: '紙の色' }), paperSwatches(st, () => { tg.redraw(); upd(); })), h('div', {}, h('h4', { text: 'サイズ' }), sizeChips(st)))
    );
    upd();
    const f = folderId && store.getFolder(folderId);
    const okBtn = h('button', { class: 'btn primary', html: `${icon('sparkle')}<span>作成して開く</span>` });
    const cancel = h('button', { class: 'btn', text: 'キャンセル' });
    const s = ui.sheet({ title: f ? `新しいノート（${f.name}）` : '新しいノート', body, foot: [cancel, okBtn], className: 'wide' });
    cancel.addEventListener('click', () => s.close());
    const submit = async () => {
      okBtn.disabled = true;
      settings.newNote = { template: st.template, paper: st.paper, size: st.size, cover: st.cover };
      saveSettings();
      const note = await store.createNote({ title: title.value, folderId, cover: st.cover, template: st.template, paper: st.paper, size: st.size });
      s.close();
      setTimeout(() => this.app.openNote(note.id, null), 120);
    };
    okBtn.addEventListener('click', submit);
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        submit();
      }
    });
  }
}
