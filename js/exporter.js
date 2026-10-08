// 書き出し：PNG / PDF / バックアップ（読み込みも）
import * as db from './db.js';
import * as store from './store.js';
import { renderPageTo } from './render.js';
import { canvasToBlob, blobToDataURL, dataURLToBlob } from './util.js';

export async function pageBlob(page, assets, scale = 2, type = 'image/png', q) {
  const cv = document.createElement('canvas');
  const s = Math.min(scale, Math.sqrt(16e6 / (page.w * page.h)));
  cv.width = Math.round(page.w * s);
  cv.height = Math.round(page.h * s);
  renderPageTo(cv.getContext('2d'), page, cv.width / page.w, cv.height / page.h, { assets });
  const b = await canvasToBlob(cv, type, q);
  cv.width = cv.height = 0;
  return b;
}

// 画像ベースのシンプルな PDF（各ページを JPEG として埋め込む）
export async function buildPdf(pages, assets, onProgress) {
  const enc = new TextEncoder();
  const chunks = [];
  let offset = 0;
  const offsets = [];
  const write = (d) => {
    const u = typeof d === 'string' ? enc.encode(d) : d;
    chunks.push(u);
    offset += u.length;
  };
  const N = pages.length;
  const total = 2 + N * 3;
  write('%PDF-1.4\n%âãÏÓ\n');
  const obj = (num, body) => {
    offsets[num] = offset;
    write(`${num} 0 obj\n${body}\nendobj\n`);
  };
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] /Count ${N} >>`);
  for (let i = 0; i < N; i++) {
    const p = pages[i];
    const wpt = (p.w * 0.75).toFixed(2), hpt = (p.h * 0.75).toFixed(2);
    const cv = document.createElement('canvas');
    const s = Math.min(2, Math.sqrt(9e6 / (p.w * p.h)));
    cv.width = Math.round(p.w * s);
    cv.height = Math.round(p.h * s);
    renderPageTo(cv.getContext('2d'), p, cv.width / p.w, cv.height / p.h, { assets });
    const blob = await canvasToBlob(cv, 'image/jpeg', 0.9);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const W = cv.width, H = cv.height;
    cv.width = cv.height = 0;
    const pn = 3 + i * 3, cn = pn + 1, inum = pn + 2;
    obj(pn, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wpt} ${hpt}] /Resources << /XObject << /Im${i} ${inum} 0 R >> >> /Contents ${cn} 0 R >>`);
    const content = `q ${wpt} 0 0 ${hpt} 0 0 cm /Im${i} Do Q`;
    obj(cn, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    offsets[inum] = offset;
    write(`${inum} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);
    write(bytes);
    write('\nendstream\nendobj\n');
    onProgress && onProgress(i + 1, N);
    await new Promise((r) => setTimeout(r, 0));
  }
  const xref = offset;
  let x = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let k = 1; k <= total; k++) x += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
  write(x);
  write(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}

// ---------- バックアップ ----------
const MAGIC = 'benkyo-note-backup';

function serializeItem(it) {
  const o = { ...it };
  if (it.pts) o.pts = Array.from(it.pts, (v) => Math.round(v * 100) / 100);
  if (it.bb) o.bb = it.bb.map((v) => Math.round(v * 100) / 100);
  return o;
}

async function gzip(str) {
  if (typeof CompressionStream === 'undefined') return new Blob([str], { type: 'application/json' });
  const cs = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Blob([await new Response(cs).arrayBuffer()], { type: 'application/octet-stream' });
}
async function readMaybeGzip(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') throw new Error('この端末は圧縮バックアップの読み込みに対応していません');
    const ds = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(ds).text();
  }
  return new TextDecoder().decode(buf);
}

export async function exportBackup(noteIds, onProgress) {
  const all = !noteIds;
  const notes = all ? store.state.notes.slice() : noteIds.map(store.getNote).filter(Boolean);
  const folders = all ? store.state.folders.slice() : [];
  const out = { magic: MAGIC, version: 2, exportedAt: Date.now(), folders, notes, pages: [], assets: [], stamps: [] };
  let i = 0;
  for (const n of notes) {
    const pages = await store.loadPages(n.id);
    for (const p of pages) out.pages.push({ ...p, items: p.items.map(serializeItem) });
    const assets = await store.loadAssets(n.id);
    for (const a of assets) out.assets.push({ ...a, blob: undefined, data: await blobToDataURL(a.blob) });
    onProgress && onProgress(++i, notes.length);
  }
  if (all) {
    for (const s of await store.loadStamps()) {
      out.stamps.push({
        ...s,
        items: s.items.map(serializeItem),
        thumb: s.thumb ? await blobToDataURL(s.thumb) : null,
        assets: await Promise.all((s.assets || []).map(async (a) => ({ ...a, blob: undefined, data: await blobToDataURL(a.blob) }))),
      });
    }
  }
  return gzip(JSON.stringify(out));
}

export async function importBackup(file) {
  const text = await readMaybeGzip(file);
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new Error('バックアップファイルを読み込めませんでした');
  }
  if (!data || data.magic !== MAGIC) throw new Error('このファイルはバックアップではありません');
  const folderIds = new Set([...store.state.folders.map((f) => f.id), ...(data.folders || []).map((f) => f.id)]);
  const ops = [];
  for (const f of data.folders || []) ops.push({ store: 'folders', put: f });
  for (const n of data.notes || []) {
    if (n.folderId && !folderIds.has(n.folderId)) n.folderId = null;
    ops.push({ store: 'notes', put: n });
  }
  for (const p of data.pages || []) {
    for (const it of p.items || []) if (it.pts) it.pts = Float32Array.from(it.pts);
    ops.push({ store: 'pages', put: p });
  }
  for (const a of data.assets || []) {
    const blob = await dataURLToBlob(a.data);
    const rec = { ...a, blob };
    delete rec.data;
    ops.push({ store: 'assets', put: rec });
  }
  for (const s of data.stamps || []) {
    const rec = { ...s };
    rec.items = (s.items || []).map((it) => (it.pts ? { ...it, pts: Float32Array.from(it.pts) } : it));
    rec.thumb = s.thumb ? await dataURLToBlob(s.thumb) : null;
    rec.assets = [];
    for (const a of s.assets || []) {
      const r = { ...a, blob: await dataURLToBlob(a.data) };
      delete r.data;
      rec.assets.push(r);
    }
    ops.push({ store: 'stamps', put: rec });
  }
  for (let k = 0; k < ops.length; k += 200) await db.batch(ops.slice(k, k + 200));
  await store.loadAll();
  store.notifyNotes();
  return { notes: (data.notes || []).length, folders: (data.folders || []).length };
}
