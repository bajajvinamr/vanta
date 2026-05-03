#!/usr/bin/env node
// vanta-sync-consume — source-ref ledger for /vanta-sync idempotency.
//
// v3.11 commit 1. Per .planning/v3-11/PLAN.md council R1+R2 verdict:
//
//   C-1 (P1 both-confirmed) — global watermark causes cross-project
//   starvation. Replaced with per-slug source-ref ledger.
//
//   C-5 (P2 Codex single) — non-atomic mark-done. The ledger is
//   append-only; consume-after-stage is the atomicity boundary. Crash
//   between stage and consume → next run replays exactly the un-consumed
//   refs (correct idempotency).
//
// Storage: ~/.vanta/sync-consumed.jsonl (or $VANTA_DIR_OVERRIDE).
// Append-only. Dedup-on-read by (slug, source, ref). Auto-trims entries
// older than 30 days at read time.
//
// Surface Impact Discipline: INTERNAL MACHINERY. No new commands.

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_LOOKBACK_MS = DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

// ─── Paths ──────────────────────────────────────────────────────────────

function _vantaDir() {
  return process.env.VANTA_DIR_OVERRIDE || path.join(os.homedir(), '.vanta');
}

function _ledgerPath() {
  return path.join(_vantaDir(), 'sync-consumed.jsonl');
}

// ─── Read-time merge across bak siblings + live ────────────────────────
//
// Mirrors v3.10 R8 P1 invariant — producer (mark) appends only; consumer
// merges across `.bak.*` siblings at read time. Entries older than 30d
// are dropped at read time (lazy retention).

function _readAllLines() {
  const live = _ledgerPath();
  const dir = path.dirname(live);
  const base = path.basename(live);
  const parts = [];
  try {
    const baks = fs.readdirSync(dir)
      .filter(n => n.startsWith(base + '.bak.'))
      .sort();
    for (const b of baks) {
      try { parts.push(fs.readFileSync(path.join(dir, b), 'utf8')); } catch {}
    }
  } catch { /* dir missing — fine */ }
  try { parts.push(fs.readFileSync(live, 'utf8')); } catch {}
  return parts.join('\n').split('\n').filter(Boolean);
}

function _parseLines(lines) {
  const out = [];
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      if (!e || typeof e !== 'object') continue;
      if (typeof e.slug !== 'string' || !e.slug) continue;
      if (typeof e.source !== 'string' || !e.source) continue;
      if (typeof e.ref !== 'string' || !e.ref) continue;
      if (typeof e.ts !== 'string' || !e.ts) continue;
      out.push(e);
    } catch { /* malformed line — skip */ }
  }
  return out;
}

function _isRetained(entry, nowMs) {
  // Use consumed_at for retention; fall back to ts if missing.
  const ref = entry.consumed_at || entry.ts;
  if (!ref) return false;
  const t = Date.parse(ref);
  if (isNaN(t)) return false;
  return (nowMs - t) <= RETENTION_MS;
}

// ─── Public API ────────────────────────────────────────────────────────

// read({ slug }) → Set of "source|ref" strings for the given slug.
// Returns an empty Set if ledger missing or no matches. Auto-trims by
// retention (30d) at read time.
function read({ slug } = {}) {
  if (!slug) return new Set();
  const now = Date.now();
  const entries = _parseLines(_readAllLines());
  const set = new Set();
  for (const e of entries) {
    if (e.slug !== slug) continue;
    if (!_isRetained(e, now)) continue;
    set.add(`${e.source}|${e.ref}`);
  }
  return set;
}

// has({ slug, source, ref }) → boolean. Convenience wrapper.
function has({ slug, source, ref }) {
  if (!slug || !source || !ref) return false;
  return read({ slug }).has(`${source}|${ref}`);
}

// lookback({ slug }) → ISO timestamp.
//   max(ts) per slug if present, else now() - 7d.
// This is the floor for incremental extraction. Per-slug isolation —
// other slugs' entries do NOT advance this slug's lookback.
function lookback({ slug } = {}) {
  if (!slug) return new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString();
  const now = Date.now();
  const entries = _parseLines(_readAllLines());
  let maxTs = 0;
  for (const e of entries) {
    if (e.slug !== slug) continue;
    if (!_isRetained(e, now)) continue;
    const t = Date.parse(e.ts);
    if (!isNaN(t) && t > maxTs) maxTs = t;
  }
  if (maxTs === 0) {
    return new Date(now - DEFAULT_LOOKBACK_MS).toISOString();
  }
  return new Date(maxTs).toISOString();
}

// mark({ slug, source, ref, ts, candidate_hash }) — atomic append.
//
// POSIX appendFileSync < PIPE_BUF (4096B) is atomic. Each entry is a
// few hundred bytes. Crash between stage write and this call → next run
// replays the candidate (correct idempotency); duplicate mark for same
// (slug, source, ref) is harmless because read() dedups via Set.
//
// R12 P1 — torn-line guard. Prefix with newline so a previous truncated
// write doesn't fuse with this entry on read. Matches v3.10 pattern in
// auto-sync.js sync-queue and rule-effectiveness ledger.
function mark({ slug, source, ref, ts, candidate_hash } = {}) {
  if (!slug || !source || !ref) {
    throw new Error('mark: slug, source, ref required');
  }
  const entry = {
    slug,
    source,
    ref,
    ts: ts || new Date().toISOString(),
    consumed_at: new Date().toISOString(),
  };
  if (candidate_hash) entry.candidate_hash = candidate_hash;
  const dir = _vantaDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const line = '\n' + JSON.stringify(entry) + '\n';
  // Hard cap at 4KB per entry (PIPE_BUF). If somehow oversized, drop —
  // never write a non-atomic entry that could interleave with another
  // session's writes.
  if (Buffer.byteLength(line, 'utf8') >= 4096) return false;
  fs.appendFileSync(_ledgerPath(), line);
  return true;
}

// ─── CLI (minimal — operator inspection) ───────────────────────────────

function _cli() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help') {
    console.error('Usage:');
    console.error('  vanta-sync-consume read --slug <slug>');
    console.error('  vanta-sync-consume lookback --slug <slug>');
    console.error('  vanta-sync-consume mark --slug <slug> --source <src> --ref <ref> [--ts <iso>]');
    process.exit(2);
  }
  const cmd = argv[0];
  const flag = (name) => {
    const arg = argv.find(a => a === '--' + name || a.startsWith('--' + name + '='));
    if (!arg) return null;
    if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
    const idx = argv.indexOf(arg);
    return argv[idx + 1] || null;
  };
  const slug = flag('slug');
  if (cmd === 'read') {
    const out = [];
    for (const k of read({ slug })) {
      const [src, ref] = k.split('|');
      out.push({ source: src, ref });
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (cmd === 'lookback') {
    console.log(lookback({ slug }));
    return;
  }
  if (cmd === 'mark') {
    const ok = mark({
      slug,
      source: flag('source'),
      ref: flag('ref'),
      ts: flag('ts'),
      candidate_hash: flag('hash'),
    });
    console.log(ok ? 'ok' : 'rejected');
    return;
  }
  console.error('Unknown command: ' + cmd);
  process.exit(2);
}

if (require.main === module) _cli();

module.exports = {
  read,
  has,
  lookback,
  mark,
  // exposed for tests
  _ledgerPath,
  _vantaDir,
  RETENTION_DAYS,
  DEFAULT_LOOKBACK_DAYS,
};
