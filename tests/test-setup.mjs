// Shared setup for the browser E2E tests.
//
// The tests drive a live InkSync server (server.py on :8765), which serves
// documents out of docs/ under content-hash names. The test PDFs live in
// tests/fixtures/ so runtime data stays out of the fixture set;
// ensureFixtures() copies them into docs/ under the same hash names the
// tests navigate to. Both the file name and the copy destination are the
// sha256 prefix of the fixture PDF, so renaming a fixture requires
// re-deriving the hash. All operations are idempotent.
import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "tests", "fixtures");
const DOCS = path.join(ROOT, "docs");

// [fixture file name, doc id used by the server/tests]
const FIXTURE_DOCS = [
  ["3675713f0f24.pdf", "3675713f0f24"],
  ["6a92c8471c4d.pdf", "6a92c8471c4d"],
];

export function ensureFixtures() {
  for (const [fixture, doc] of FIXTURE_DOCS) {
    const pdfDst = path.join(DOCS, `${doc}.pdf`);
    if (!existsSync(pdfDst)) copyFileSync(path.join(FIXTURES, fixture), pdfDst);
    const metaSrc = path.join(FIXTURES, fixture.replace(/\.pdf$/, ".meta.json"));
    const metaDst = path.join(DOCS, `${doc}.meta.json`);
    if (existsSync(metaSrc) && !existsSync(metaDst)) copyFileSync(metaSrc, metaDst);
  }
}

export function cleanSidecar(doc) {
  const sidecar = path.join(DOCS, `${doc}.annotations.json`);
  if (existsSync(sidecar)) unlinkSync(sidecar);
}
