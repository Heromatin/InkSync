// Local PDF cache backed by IndexedDB (works on plain-HTTP LAN origins,
// unlike Service Workers which need a secure context). The server's document
// IDs are content hashes, so a cached copy with the requested ID is
// guaranteed byte-identical to the server copy — no validation needed.

const DB_NAME = "studyapp-pdf-cache";
const STORE = "pdfs";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getCachedPdf(id) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

export async function putCachedPdf(id, buffer) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readwrite").objectStore(STORE).put(buffer, id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // private mode / storage full: fall back to network-only, non-fatal
  }
}

// Returns { data: ArrayBuffer } — download only if not already on device.
export async function loadPdfSource(id) {
  const hit = await getCachedPdf(id);
  if (hit) return { data: hit, fromCache: true };
  const res = await fetch(`/doc/${id}.pdf`);
  if (!res.ok) throw new Error(`PDF download failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  await putCachedPdf(id, buf.slice(0));  // independent copy for the cache
  return { data: buf, fromCache: false };
}
