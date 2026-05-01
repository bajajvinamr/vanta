// vanta-jsonl — read a JSONL journal plus all rotated `.bak.<ts>` siblings.
//
// Codex+Gemini council R8 P1 — concurrency-safe rotation.
// Stop hook rotation now uses rename-only (no writeFileSync recreate)
// so concurrent appenders can't be clobbered by a folding writer.
// Trade-off: history accumulates across `.bak.<ts>` files. Readers must
// merge them to see full history; this module is the merge primitive.
//
// Used by vanta-resolve.js (episodes), vanta-brief.js (sync-queue),
// vanta-status.js (sync-queue, episodes), and any future consumer.
//
// Returns concatenated content as one string (newline-delimited). If
// callers want dedup-by-session_id, they parse + Map-by-key — preserving
// the "latest wins" semantic at read time instead of write time.

const fs = require('fs');
const path = require('path');

// Read the live file plus all rotated `.bak.<ts>` siblings, OLDEST first.
// Order matters for dedup-by-key: the LATEST entry wins, so the live file
// (most recent) must come AFTER older rotations. Our `Date.now()`-suffixed
// names sort lexicographically by age, so we can sort the bak list.
function readMergedJsonl(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const bakPrefix = base + '.bak.';
  const parts = [];

  // Older rotations first.
  let baks = [];
  try {
    baks = fs.readdirSync(dir)
      .filter(n => n.startsWith(bakPrefix))
      .sort();  // string sort = numeric-ish for `Date.now()` prefix
  } catch { /* dir missing — fine, return empty */ }

  for (const b of baks) {
    const bp = path.join(dir, b);
    try { parts.push(fs.readFileSync(bp, 'utf8')); } catch { /* skip unreadable */ }
  }

  // Live file last (newest).
  try { parts.push(fs.readFileSync(file, 'utf8')); } catch { /* may not exist post-rotation */ }

  // Ensure each chunk ends with a newline so concat doesn't fuse two records.
  return parts.map(p => p.endsWith('\n') ? p : p + '\n').join('');
}

// Same as above but returns a Map keyed by session_id (or a custom keyFn),
// keeping the LATEST entry per key. Equivalent to the old fold-on-rotate
// dedup, but applied at read time.
function readDedupedJsonl(file, keyFn = e => e.session_id) {
  const merged = readMergedJsonl(file);
  const latest = new Map();
  for (const line of merged.split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const k = keyFn(e);
    if (k != null) latest.set(k, e);
  }
  return latest;
}

// List the rotated bak files for a given live path. Used by vanta-prune
// to decide what's eligible for cleanup.
function listBaks(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const bakPrefix = base + '.bak.';
  try {
    return fs.readdirSync(dir)
      .filter(n => n.startsWith(bakPrefix))
      .map(n => path.join(dir, n))
      .sort();
  } catch { return []; }
}

// R9 P1 — torn-line guard.
//
// Gemini council finding: if a write is truncated (SIGKILL or ENOSPC) leaving
// the line WITHOUT its trailing newline, the next appendFileSync fuses into
// the torn line. Reader's split('\n') yields one merged garbage chunk;
// JSON.parse fails on it and BOTH records are lost (the torn one AND the
// next healthy one).
//
// Fix: every appended record is bracketed by leading-and-trailing newlines
// (`\n` + JSON + `\n`). On read, split('\n').filter(Boolean) drops the
// extras. A torn write that loses its trailing `\n` still gets the LEADING
// `\n` of the NEXT record, so split keeps them in separate chunks. Only
// the torn record is lost; the healthy next record survives.
//
// Cost: 1 extra byte per line. Reader semantics unchanged for already-
// healthy files because filter(Boolean) was already in use.
function appendJsonlLine(file, obj) {
  const fs = require('fs');
  fs.appendFileSync(file, '\n' + JSON.stringify(obj) + '\n');
}

module.exports = { readMergedJsonl, readDedupedJsonl, listBaks, appendJsonlLine };
