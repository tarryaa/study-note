// データモデル（フォルダ / ノート / ページ / 画像）と永続化
import * as db from './db.js';
import { uid } from './util.js';

export const PAGE_SIZES = {
  a4p: { w: 794, h: 1123, label: 'A4 縦' },
  a4l: { w: 1123, h: 794, label: 'A4 横' },
  b5p: { w: 688, h: 971, label: 'B5 縦' },
  sq: { w: 900, h: 900, label: '正方形' },
  wide: { w: 1280, h: 720, label: '16:9' },
  long: { w: 794, h: 2246, label: '縦長' },
};

export const TEMPLATES = [
  { id: 'blank', label: '無地' },
  { id: 'ruled7', label: '横罫 7mm' },
  { id: 'ruled6', label: '横罫 6mm' },
  { id: 'dotruled', label: 'ドット罫' },
  { id: 'grid5', label: '方眼 5mm' },
  { id: 'dot5', label: 'ドット' },
  { id: 'cornell', label: 'コーネル' },
  { id: 'music', label: '五線譜' },
];

export const PAPERS = [
  { c: '#ffffff', label: 'ホワイト' },
  { c: '#fbf6e8', label: 'クリーム' },
  { c: '#f1f3f6', label: 'グレー' },
  { c: '#eaf4ee', label: 'ミント' },
  { c: '#26282c', label: 'ダーク' },
  { c: '#1e3a31', label: '黒板' },
];

export const COVERS = {
  indigo: '#5b6cf0',
  sky: '#3b9ff0',
  teal: '#14a39a',
  green: '#3faa5c',
  amber: '#f0b23a',
  coral: '#f2735f',
  rose: '#ea5a8c',
  violet: '#9466f2',
  sand: '#c49a6c',
  graphite: '#5d6470',
};
export const coverColor = (k) => COVERS[k] || (k && k[0] === '#' ? k : COVERS.indigo);

export const FOLDER_COLORS = ['#5b6cf0', '#3b9ff0', '#14a39a', '#3faa5c', '#f0b23a', '#f2735f', '#ea5a8c', '#9466f2', '#8d6e63', '#6b7280'];

export const state = { folders: [], notes: [] };
const subs = new Set();
export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
function emit(kind) {
  for (const f of subs) f(kind);
}

export async function loadAll() {
  const [folders, notes] = await Promise.all([db.getAll('folders'), db.getAll('notes')]);
  state.folders = folders || [];
  state.notes = notes || [];
  const limit = Date.now() - 30 * 86400000;
  const old = state.notes.filter((n) => n.deletedAt && n.deletedAt < limit).map((n) => n.id);
  if (old.length) await deleteNotesForever(old);
}

export const getNote = (id) => state.notes.find((n) => n.id === id);
export const getFolder = (id) => state.folders.find((f) => f.id === id);

export function childFolders(parentId) {
  const p = parentId || null;
  return state.folders
    .filter((f) => (f.parentId || null) === p)
    .sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt));
}
export function folderPath(id) {
  const out = [];
  const seen = new Set();
  let f = getFolder(id);
  while (f && !seen.has(f.id)) {
    seen.add(f.id);
    out.unshift(f);
    f = f.parentId ? getFolder(f.parentId) : null;
  }
  return out;
}
export function descendantIds(id) {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const f of state.folders) if (f.parentId === out[i]) out.push(f.id);
  return out;
}
export function notesIn(folderId, recursive) {
  const ids = new Set(recursive ? descendantIds(folderId) : [folderId]);
  return state.notes.filter((n) => !n.deletedAt && ids.has(n.folderId));
}
export const liveNotes = () => state.notes.filter((n) => !n.deletedAt);

// ---------- フォルダ ----------
export async function createFolder({ name, parentId = null, color = FOLDER_COLORS[0] }) {
  const t = Date.now();
  const f = { id: uid(), name: name || '新しいフォルダ', parentId: parentId || null, color, createdAt: t, updatedAt: t, order: t };
  state.folders.push(f);
  await db.put('folders', f);
  emit('folders');
  return f;
}
export async function updateFolder(id, patch) {
  const f = getFolder(id);
  if (!f) return;
  Object.assign(f, patch, { updatedAt: Date.now() });
  await db.put('folders', f);
  emit('folders');
}
export async function moveFolder(id, parentId) {
  if (id === parentId) return false;
  if (parentId && descendantIds(id).includes(parentId)) return false;
  await updateFolder(id, { parentId: parentId || null, order: Date.now() });
  return true;
}
export async function deleteFolder(id) {
  const ids = descendantIds(id);
  const set = new Set(ids);
  const t = Date.now();
  const notes = state.notes.filter((n) => set.has(n.folderId) && !n.deletedAt);
  for (const n of notes) {
    n.deletedAt = t;
    n.folderId = null;
  }
  state.folders = state.folders.filter((f) => !set.has(f.id));
  await db.batch([...ids.map((k) => ({ store: 'folders', del: k })), ...notes.map((n) => ({ store: 'notes', put: n }))]);
  emit('folders');
  emit('notes');
  return notes.length;
}

// ---------- ノート ----------
export function newPageData(noteId, { template = 'blank', paper = '#ffffff', w = 794, h = 1123, bg = null } = {}) {
  const p = { id: uid(), noteId, w, h, template, paper, items: [] };
  if (bg) p.bg = bg; // 画像から作ったページ（背景画像のアセット ID）
  return p;
}

export async function createNote(opts = {}) {
  const size = PAGE_SIZES[opts.size] || PAGE_SIZES.a4p;
  const t = Date.now();
  const note = {
    id: uid(),
    title: (opts.title || '').trim() || '無題のノート',
    folderId: opts.folderId || null,
    cover: opts.cover || 'indigo',
    favorite: false,
    createdAt: t,
    updatedAt: t,
    openedAt: t,
    deletedAt: null,
    pageIds: [],
    defaults: { template: opts.template || 'ruled7', paper: opts.paper || '#ffffff', size: opts.size || 'a4p' },
  };
  // opts.pageSpecs があればそのページで作る（画像から作るノートなど）
  const pages = (opts.pageSpecs && opts.pageSpecs.length ? opts.pageSpecs : [{ template: note.defaults.template, paper: note.defaults.paper, w: size.w, h: size.h }])
    .map((s) => newPageData(note.id, s));
  const assets = (opts.assets || []).map((a) => ({ ...a, noteId: note.id }));
  note.pageIds = pages.map((p) => p.id);
  state.notes.push(note);
  await db.batch([
    { store: 'notes', put: note },
    ...pages.map((p) => ({ store: 'pages', put: p })),
    ...assets.map((a) => ({ store: 'assets', put: a })),
  ]);
  emit('notes');
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  return note;
}

export async function updateNote(id, patch, silent) {
  const n = getNote(id);
  if (!n) return;
  Object.assign(n, patch);
  await db.put('notes', n);
  if (!silent) emit('notes');
}
export async function updateNotes(ids, patchFn) {
  const ns = ids.map(getNote).filter(Boolean);
  for (const n of ns) Object.assign(n, typeof patchFn === 'function' ? patchFn(n) : patchFn);
  await db.batch(ns.map((n) => ({ store: 'notes', put: n })));
  emit('notes');
}
export const trashNotes = (ids) => updateNotes(ids, { deletedAt: Date.now() });
export const restoreNotes = (ids) =>
  updateNotes(ids, (n) => ({ deletedAt: null, folderId: n.folderId && getFolder(n.folderId) ? n.folderId : null }));

export async function deleteNotesForever(ids) {
  for (const id of ids) {
    const [pages, assets] = await Promise.all([
      db.getAllKeysByIndex('pages', 'noteId', id),
      db.getAllKeysByIndex('assets', 'noteId', id),
    ]);
    await db.batch([
      ...(pages || []).map((k) => ({ store: 'pages', del: k })),
      ...(assets || []).map((k) => ({ store: 'assets', del: k })),
      { store: 'thumbs', del: id },
      { store: 'notes', del: id },
    ]);
  }
  const set = new Set(ids);
  state.notes = state.notes.filter((n) => !set.has(n.id));
  emit('notes');
}

export function cloneItem(it, assetMap) {
  const o = { ...it, id: uid() };
  if (it.pts) o.pts = new Float32Array(it.pts);
  if (it.bb) o.bb = it.bb.slice();
  if (it.asset && assetMap && assetMap.has(it.asset)) o.asset = assetMap.get(it.asset);
  return o;
}

export async function duplicateNote(id) {
  const src = getNote(id);
  if (!src) return null;
  const [pages, assets, thumb] = await Promise.all([loadPages(id), db.getAllByIndex('assets', 'noteId', id), db.get('thumbs', id)]);
  const t = Date.now();
  const note = structuredClone(src);
  Object.assign(note, { id: uid(), title: src.title + ' のコピー', createdAt: t, updatedAt: t, openedAt: t, favorite: false, deletedAt: null });
  const amap = new Map();
  const newAssets = (assets || []).map((a) => {
    const nid = uid();
    amap.set(a.id, nid);
    return { ...a, id: nid, noteId: note.id };
  });
  const newPages = pages.map((p) => {
    const np = { ...p, id: uid(), noteId: note.id, items: p.items.map((it) => cloneItem(it, amap)) };
    if (p.bg && amap.has(p.bg)) np.bg = amap.get(p.bg);
    return np;
  });
  note.pageIds = newPages.map((p) => p.id);
  state.notes.push(note);
  await db.batch([
    { store: 'notes', put: note },
    ...newPages.map((p) => ({ store: 'pages', put: p })),
    ...newAssets.map((a) => ({ store: 'assets', put: a })),
    ...(thumb ? [{ store: 'thumbs', put: { ...thumb, id: note.id } }] : []),
  ]);
  emit('notes');
  return note;
}

// ---------- ページ / アセット ----------
export async function loadPages(noteId) {
  const note = getNote(noteId);
  const pages = (await db.getAllByIndex('pages', 'noteId', noteId)) || [];
  const byId = new Map(pages.map((p) => [p.id, p]));
  const out = [];
  for (const id of (note && note.pageIds) || []) {
    const p = byId.get(id);
    if (p) {
      out.push(p);
      byId.delete(id);
    }
  }
  for (const p of byId.values()) out.push(p); // 順序情報が欠けたページも救済
  for (const p of out) normalizePage(p);
  if (!out.length) {
    const d = (note && note.defaults) || {};
    const size = PAGE_SIZES[d.size] || PAGE_SIZES.a4p;
    out.push(newPageData(noteId, { template: d.template || 'ruled7', paper: d.paper || '#ffffff', w: size.w, h: size.h }));
  }
  return out;
}

function normalizePage(p) {
  if (!Array.isArray(p.items)) p.items = [];
  for (const it of p.items) {
    if (it.pts && !(it.pts instanceof Float32Array)) it.pts = Float32Array.from(it.pts);
  }
}

export async function loadAssets(noteId) {
  return (await db.getAllByIndex('assets', 'noteId', noteId)) || [];
}
export const saveAsset = (a) => db.put('assets', a);
export const deleteAssets = (ids) => db.batch(ids.map((k) => ({ store: 'assets', del: k })));
export const getAsset = (id) => db.get('assets', id);

export async function setThumb(noteId, blob) {
  await db.put('thumbs', { id: noteId, blob, t: Date.now() });
  emit('thumb:' + noteId);
}
export const getThumb = (noteId) => db.get('thumbs', noteId);

export function notifyNotes() {
  emit('notes');
}

// ---------- スタンプ（全ノート共通） ----------
export async function loadStamps() {
  const list = (await db.getAll('stamps')) || [];
  for (const s of list) for (const it of s.items || []) if (it.pts && !(it.pts instanceof Float32Array)) it.pts = Float32Array.from(it.pts);
  return list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
export const saveStamp = (s) => db.put('stamps', s);
export const deleteStamp = (id) => db.del('stamps', id);
