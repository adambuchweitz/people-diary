// Diary keeps its entries in this browser (IndexedDB). People gets a memory
// for each person an entry mentions, not the entries themselves.

export type Photo = { id: string; name: string; type: string; blob: Blob };

/** Someone an entry mentions, and the memory People keeps for it. */
export type Mention = {
  personId: string;
  name: string;
  /** The memory in People, once saved there. */
  memoryId?: string;
  /** What was last sent, so unchanged entries aren't sent again. */
  sent?: string;
  /** Which photos the memory carries; files can't be changed, so new ones mean a new memory. */
  sentPhotos?: string;
};

export type Entry = {
  id: string;
  /** The day it's about, YYYY-MM-DD. */
  date: string;
  title: string;
  body: string;
  photos: Photo[];
  mentions: Mention[];
  createdAt: string;
  updatedAt: string;
};

const DB = "diary";
const STORE = "entries";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = work(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function listEntries(): Promise<Entry[]> {
  const entries = await run<Entry[]>("readonly", (store) => store.getAll());
  return entries.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

export function saveEntry(entry: Entry): Promise<IDBValidKey> {
  return run("readwrite", (store) => store.put(entry));
}

export function deleteEntry(id: string): Promise<undefined> {
  return run("readwrite", (store) => store.delete(id));
}

export function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function newEntry(): Entry {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), date: today(), title: "", body: "", photos: [], mentions: [], createdAt: now, updatedAt: now };
}
