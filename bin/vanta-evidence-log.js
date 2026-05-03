#!/usr/bin/env node
// vanta-evidence-log — side-channel evidence stream for invariants.
//
// v3.10 commit 2. Per the v3.10 PLAN.md:
//
//   ~/.vanta/invariant-evidence.jsonl
//   { ts, invariant_hash, event: 'retrieved' | 'council_tp' | 'unused_30d',
//     origin: 'user-prompt' | 'internal' | null, project: string|null }
//
// Why: invariants accumulate forever in vinamr-invariants.md. Without a
// usage signal, retired invariants linger and a "never cited in 30d"
// review can't surface them. v3.10 tracks retrievals (when vanta-resolve
// returns an invariant in user-prompt context) and council true-positive
// attributions as evidence of usefulness. The invariants file ITSELF is
// not modified — that boundary stays human-only per R7 P1.
//
// Council fixes this commit consumes:
//   C-7 — Origin field with default-deny: only 'user-prompt' contributes
//         to evidence. 'internal' and null retrievals do NOT inflate
//         scores. Self-citation by Vanta machinery is structurally
//         impossible.
//   C-13 — Last-5 daily bak rotation policy, matching v3.8.2.

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function _vantaDir() {
  return process.env.VANTA_DIR_OVERRIDE || path.join(os.homedir(), '.vanta');
}
function _file() { return path.join(_vantaDir(), 'invariant-evidence.jsonl'); }

const MAX_BYTES = 5_000_000;
const BAK_RETAIN = 5;

let _jsonl;
function jsonl() {
  if (_jsonl) return _jsonl;
  for (const p of [
    path.join(__dirname, 'vanta-jsonl.js'),
    path.join(os.homedir(), '.claude', 'bin', 'vanta-jsonl.js'),
  ]) {
    try { _jsonl = require(p); return _jsonl; } catch (_) { /* try next */ }
  }
  throw new Error('vanta-jsonl.js not resolvable');
}

const VALID_EVENTS = Object.freeze(['retrieved', 'council_tp', 'unused_30d']);
const VALID_ORIGINS = Object.freeze(['user-prompt', 'internal']);

// Stable hash for an invariant text. Trim + lowercase first 256 chars
// (more than enough to disambiguate). The audit-comment line that
// precedes invariants in vinamr-invariants.md isn't part of the hash —
// edits to the audit comment shouldn't break the evidence chain.
function hashInvariant(text) {
  if (typeof text !== 'string') return null;
  const norm = text.trim().slice(0, 256).toLowerCase();
  if (!norm) return null;
  return 'inv-' + crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

// ─── Rotation (matches vanta-route-quality / vanta-cancellation) ──
function _maybeRotate(file) {
  try {
    if (!fs.existsSync(file)) return;
    const st = fs.statSync(file);
    if (st.size <= MAX_BYTES) return;
    const ts = Date.now() + '.' + process.pid;
    const target = `${file}.bak.${ts}`;
    let st2; try { st2 = fs.statSync(file); } catch { return; }
    if (!st2 || st2.ino !== st.ino || st2.size <= MAX_BYTES) return;
    fs.renameSync(file, target);
    _pruneBaks(file);
  } catch (_) { /* never let rotation fail a write */ }
}
function _pruneBaks(file) {
  try {
    const dir = path.dirname(file);
    const base = path.basename(file);
    const baks = fs.readdirSync(dir)
      .filter(f => f.startsWith(base + '.bak.'))
      .map(f => ({ full: path.join(dir, f), m: _safeMtime(path.join(dir, f)) }))
      .sort((a, b) => b.m - a.m);
    for (const old of baks.slice(BAK_RETAIN)) {
      try { fs.unlinkSync(old.full); } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }
}
function _safeMtime(fp) { try { return fs.statSync(fp).mtimeMs; } catch { return 0; } }

// ─── Public API ─────────────────────────────────────────────────────

// Record an evidence event. Returns true on success, false on validation
// failure or write error.
//
// C-7 default-deny: origin must be one of VALID_ORIGINS. A missing or
// unrecognized origin is REJECTED. Internal callers (soak-report,
// session-start brief, machinery loops) pass 'internal' and the entry
// is recorded but is FILTERED OUT of evidence-count rollups by the
// reader. Only 'user-prompt' contributes to citation counts.
function record({ invariant_hash, event, origin, project = null, ts = null } = {}) {
  if (!invariant_hash || typeof invariant_hash !== 'string') return false;
  if (!VALID_EVENTS.includes(event)) return false;
  // Origin is REQUIRED for 'retrieved' events (default-deny). 'council_tp'
  // is server-attributed (no origin needed). 'unused_30d' is batch-
  // computed (no origin needed).
  if (event === 'retrieved') {
    if (!VALID_ORIGINS.includes(origin)) return false;
  }
  const out = {
    ts: ts || new Date().toISOString(),
    invariant_hash,
    event,
    origin: origin || null,
    project: project || null,
  };
  try {
    fs.mkdirSync(_vantaDir(), { recursive: true });
    _maybeRotate(_file());
    jsonl().appendJsonlLine(_file(), out);
    return true;
  } catch (_) {
    return false;
  }
}

// Convenience: record a retrieval. Default-deny on missing/invalid origin.
function recordRetrieval(args) {
  return record({ ...args, event: 'retrieved' });
}

// Convenience: record a council true-positive attribution.
function recordCouncilTP(args) {
  return record({ ...args, event: 'council_tp' });
}

// Convenience: record a periodic "unused for 30 days" marker.
function recordUnusedThirtyDays(args) {
  return record({ ...args, event: 'unused_30d' });
}

// Read all evidence entries. C-11: live file by default; pass
// allHistory: true to merge bak siblings.
function readAll({ allHistory = false } = {}) {
  const file = _file();
  if (!fs.existsSync(file)) {
    if (!allHistory) return [];
    // also check bak siblings
    try {
      const dir = path.dirname(file);
      const base = path.basename(file);
      const has = fs.readdirSync(dir).some(n => n.startsWith(base + '.bak.'));
      if (!has) return [];
    } catch { return []; }
  }
  const raw = jsonl().readMergedJsonl(file, { includeBaks: allHistory });
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* torn — skip */ }
  }
  return out;
}

// Compute citation summary per invariant_hash:
//   - retrieved_count (only origin='user-prompt' contributes — C-7)
//   - council_tp_count
//   - unused_30d_count
//   - last_retrieved_ts
//
// Returns Map<invariant_hash, summary>. The 30-day unused window is
// computed against `now` so test code can pass a fixed clock.
function summarize({ now = Date.now(), windowDays = 30 } = {}) {
  const all = readAll();
  const summary = new Map();
  const cutoff = new Date(now - windowDays * 24 * 60 * 60 * 1000).toISOString();
  for (const e of all) {
    if (!e.invariant_hash) continue;
    let s = summary.get(e.invariant_hash);
    if (!s) {
      s = {
        invariant_hash: e.invariant_hash,
        retrieved_count: 0,
        council_tp_count: 0,
        unused_30d_count: 0,
        last_retrieved_ts: null,
        last_council_tp_ts: null,
      };
      summary.set(e.invariant_hash, s);
    }
    if (e.event === 'retrieved' && e.origin === 'user-prompt') {
      s.retrieved_count++;
      if (!s.last_retrieved_ts || (e.ts || '') > s.last_retrieved_ts) s.last_retrieved_ts = e.ts;
    } else if (e.event === 'council_tp') {
      s.council_tp_count++;
      if (!s.last_council_tp_ts || (e.ts || '') > s.last_council_tp_ts) s.last_council_tp_ts = e.ts;
    } else if (e.event === 'unused_30d') {
      s.unused_30d_count++;
    }
  }
  // Annotate each with whether it's currently 'cold' (no user-prompt
  // retrieval since cutoff). Soft-quarantine candidate flag.
  for (const s of summary.values()) {
    s.cold = !s.last_retrieved_ts || s.last_retrieved_ts < cutoff;
  }
  return summary;
}

// Top-K most-cited and least-cited (C-9 alarm-fatigue cap). Pass
// `topK` and `bottomK` to control surface size in soak report.
function topAndBottomCited({ topK = 5, bottomK = 5, now = Date.now() } = {}) {
  const summary = summarize({ now });
  const arr = [...summary.values()];
  arr.sort((a, b) => (b.retrieved_count + b.council_tp_count) - (a.retrieved_count + a.council_tp_count));
  return {
    top: arr.slice(0, topK),
    cold: arr.filter(s => s.cold && s.retrieved_count === 0).slice(0, bottomK),
  };
}

module.exports = {
  hashInvariant,
  record,
  recordRetrieval,
  recordCouncilTP,
  recordUnusedThirtyDays,
  readAll,
  summarize,
  topAndBottomCited,
  VALID_EVENTS,
  VALID_ORIGINS,
};
