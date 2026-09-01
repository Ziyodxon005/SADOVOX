/**
 * SADO VOX — IndexedDB wrapper
 * Stores: projects metadata + blobs (video, audio)
 */

const DB_NAME    = 'sadovox_db';
const DB_VERSION = 1;
const STORE_META  = 'projects';
const STORE_BLOBS = 'blobs';

let _db = null;

async function openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS, { keyPath: 'id' });
      }
    };

    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror   = (e) => reject(e.target.error);
  });
}

function tx(stores, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    t.oncomplete = () => resolve();
    t.onerror    = (e) => reject(e.target.error);
    fn(t);
  }));
}

function txGet(store, key) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = (e) => reject(e.target.error);
  }));
}

function txGetAll(store) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = (e) => reject(e.target.error);
  }));
}

/* ── Projects ────────────────────────────────────────────── */

export async function saveProject(meta) {
  await tx(STORE_META, 'readwrite', t =>
    t.objectStore(STORE_META).put(meta)
  );
}

export async function getProjects() {
  const all = await txGetAll(STORE_META);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getProject(id) {
  return txGet(STORE_META, id);
}

export async function deleteProject(id) {
  await tx([STORE_META, STORE_BLOBS], 'readwrite', t => {
    t.objectStore(STORE_META).delete(id);
    t.objectStore(STORE_BLOBS).delete(`video_${id}`);
    t.objectStore(STORE_BLOBS).delete(`audio_${id}`);
  });
}

/* ── Blobs ───────────────────────────────────────────────── */

export async function saveBlob(key, blob) {
  await tx(STORE_BLOBS, 'readwrite', t =>
    t.objectStore(STORE_BLOBS).put({ id: key, blob })
  );
}

export async function getBlob(key) {
  const row = await txGet(STORE_BLOBS, key);
  return row?.blob ?? null;
}
