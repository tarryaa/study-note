// IndexedDB ラッパー（iOS の接続切れに備えて自動再接続）
const NAME = 'benkyo-note';
const VERSION = 2;
let _db = null;
let _opening = null;

function open() {
  if (_db) return Promise.resolve(_db);
  if (_opening) return _opening;
  _opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'id' }).createIndex('noteId', 'noteId');
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' }).createIndex('noteId', 'noteId');
      if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('stamps')) db.createObjectStore('stamps', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      _db = req.result;
      _db.onclose = () => { _db = null; };
      _db.onversionchange = () => { try { _db.close(); } catch (_) {} _db = null; };
      _opening = null;
      resolve(_db);
    };
    req.onerror = () => { _opening = null; reject(req.error); };
    req.onblocked = () => {};
  });
  return _opening;
}

function retryable(e) {
  if (!e) return false;
  return e.name === 'InvalidStateError' || e.name === 'UnknownError' || e.name === 'TransactionInactiveError' || /connection|closing|closed/i.test(e.message || '');
}

async function run(stores, mode, fn) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const db = await open();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        let out;
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
        out = fn(tx);
      });
    } catch (e) {
      if (attempt < 2 && retryable(e)) {
        try { _db && _db.close(); } catch (_) {}
        _db = null;
        continue;
      }
      throw e;
    }
  }
}

function read(store, fn) {
  return run([store], 'readonly', (tx) => {
    const o = { v: undefined };
    const r = fn(tx.objectStore(store));
    r.onsuccess = () => { o.v = r.result; };
    return o;
  }).then((o) => o.v);
}

export const get = (store, key) => read(store, (s) => s.get(key));
export const getAll = (store) => read(store, (s) => s.getAll());
export const getAllByIndex = (store, index, value) => read(store, (s) => s.index(index).getAll(value));
export const getAllKeysByIndex = (store, index, value) => read(store, (s) => s.index(index).getAllKeys(value));

export function put(store, value) {
  return run([store], 'readwrite', (tx) => { tx.objectStore(store).put(value); });
}
export function del(store, key) {
  return run([store], 'readwrite', (tx) => { tx.objectStore(store).delete(key); });
}
// ops: [{ store, put: value } | { store, del: key }]
export function batch(ops) {
  if (!ops.length) return Promise.resolve();
  const stores = [...new Set(ops.map((o) => o.store))];
  return run(stores, 'readwrite', (tx) => {
    for (const o of ops) {
      const s = tx.objectStore(o.store);
      if ('del' in o) s.delete(o.del);
      else s.put(o.put);
    }
  });
}
export function clearAll() {
  const stores = ['folders', 'notes', 'pages', 'assets', 'thumbs', 'stamps'];
  return run(stores, 'readwrite', (tx) => { for (const s of stores) tx.objectStore(s).clear(); });
}
