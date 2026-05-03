#!/usr/bin/env node
// vanta-cancellation — cost-honest tracker for halted actions.
//
// Why this exists: when the user types "stop" or "no, I meant test
// it", an in-flight remote API call (Codex/Gemini council) may
// already be on the wire. We CANNOT guarantee no charge — the
// request may complete remotely while we throw away its result
// locally. The roadmap's "cost honesty" principle: never claim
// "no charge" preemptively. Record what we know (cancelled locally,
// remote status unknown, estimated cost) and reconcile on the next
// session start.
//
// Storage: ~/.vanta/cancellations.jsonl, append-only. Same rotation
// + torn-line semantics as action-log + route-quality.

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function _vantaDir() {
  return process.env.VANTA_DIR_OVERRIDE || path.join(os.homedir(), '.vanta');
}
function _file() { return path.join(_vantaDir(), 'cancellations.jsonl'); }

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

const CANCELLATION_KINDS = Object.freeze([
  'user-initiated-stop',
  'user-initiated-reroute',
  'user-initiated-undo',
]);
const REMOTE_STATUSES = Object.freeze(['unknown', 'completed', 'aborted']);

function _maybeRotate(file) {
  try {
    if (!fs.existsSync(file)) return;
    const st = fs.statSync(file);
    if (st.size <= MAX_BYTES) return;
    const ts = Date.now() + '.' + process.pid;
    const target = `${file}.bak.${ts}`;
    let st2;
    try { st2 = fs.statSync(file); } catch { return; }
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

// Record a cancellation. Required: action_id + cancellation_kind.
// Optional: in_flight_remote_call shape per the VantaActionCancellation
// schema in the roadmap. Returns true on success.
//
// Cost-honesty contract: if the caller knows there was a remote call
// in flight, the in_flight_remote_call MUST be passed. The caller
// MUST NOT pre-set remote_status to anything other than 'unknown';
// reconciliation is the only path that flips it to 'completed' or
// 'aborted'.
function record(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (!entry.action_id || typeof entry.action_id !== 'string') return false;
  if (!CANCELLATION_KINDS.includes(entry.cancellation_kind)) return false;
  const ts = entry.cancelled_at || new Date().toISOString();
  const out = {
    action_id: entry.action_id,
    cancelled_at: ts,
    cancellation_kind: entry.cancellation_kind,
    in_flight_remote_call: null,
    // v3.10 council C-1 (both-confirmed P1): propagate decision_id from
    // the upstream rule fire so rule-effectiveness scoring can attribute
    // this cancellation to the right rule. Optional: legacy callers and
    // pre-v3.10 cancellations read as null and are scored `unscorable`
    // by the rule scorer rather than misattributed.
    decision_id: typeof entry.decision_id === 'string' ? entry.decision_id : null,
  };
  if (entry.in_flight_remote_call) {
    const inflight = entry.in_flight_remote_call;
    if (!inflight.provider || !['codex', 'gemini', 'both'].includes(inflight.provider)) return false;
    if (!inflight.request_id || typeof inflight.request_id !== 'string') return false;
    // Cost-honesty contract (council R1 P2 fix, both-confirmed):
    // record() is the ONLY entry point that creates a cancellation;
    // remote_status MUST start 'unknown' regardless of what the
    // caller supplied. Allowing caller-supplied 'completed' or
    // 'aborted' would let the contract be bypassed (a buggy caller
    // could persist a misleadingly certain status before the actual
    // remote call finished). The only path that can flip
    // remote_status is reconcile().
    out.in_flight_remote_call = {
      provider: inflight.provider,
      request_id: inflight.request_id,
      cancelled_locally: true,
      remote_status: 'unknown',
      estimated_cost_usd: typeof inflight.estimated_cost_usd === 'number' ? inflight.estimated_cost_usd : null,
      actual_cost_usd: null,  // filled by reconcile() on next session
    };
  }
  try {
    fs.mkdirSync(_vantaDir(), { recursive: true });
    _maybeRotate(_file());
    jsonl().appendJsonlLine(_file(), out);
    return true;
  } catch (_) {
    return false;
  }
}

// Read all cancellations across live + .bak.<ts>. Council R1 P1 fix
// (Codex+Gemini both-confirmed): the prior implementation pushed every
// line without dedup, so reconciliation entries left the original
// 'unknown' rows visible forever AND repeated stop+undo of the same
// action returned both rows (doubling estimated cost in
// summarizePending).
//
// Dedup key: action_id alone. The latest cancelled_at for a given
// action_id wins (a reconciliation entry has a later ts than the
// original record, so it supersedes). For tied ts (sub-millisecond
// writes), append-order wins via `>=`. Reconciliation entries
// (cancellation_kind='reconciliation') are sentinel writes that
// override the original; readAll surfaces only the latest state per
// action.
function readAll() {
  const file = _file();
  if (!fs.existsSync(file) && !_anyBakFor(file)) return [];
  const raw = jsonl().readMergedJsonl(file);
  const byActionId = new Map();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try { e = JSON.parse(t); } catch { continue; /* torn */ }
    if (!e || !e.action_id) continue;
    const prior = byActionId.get(e.action_id);
    if (!prior || (e.cancelled_at || '') >= (prior.cancelled_at || '')) {
      byActionId.set(e.action_id, e);
    }
  }
  return [...byActionId.values()];
}

function _anyBakFor(file) {
  try {
    const dir = path.dirname(file);
    const base = path.basename(file);
    return fs.readdirSync(dir).some(f => f.startsWith(base + '.bak.'));
  } catch (_) { return false; }
}

// Find cancellations with a remote call still pending reconciliation.
// Used by the session-start crash-recovery scan and the cost-summary
// surface to tell the user "the council call you stopped may have
// charged ~$0.18 — checking actuals now".
function findPendingReconciliation() {
  return readAll().filter(c =>
    c.in_flight_remote_call &&
    c.in_flight_remote_call.remote_status === 'unknown',
  );
}

// Reconcile a cancellation: append a new entry with the same
// action_id but updated remote_status and actual_cost_usd. The
// reader's dedup-by-(action_id,cancelled_at) keeps the original
// record visible; reconciliation is a separate ts. Both are read
// when the caller wants the full trail.
//
// In v3.9.0 the actual provider lookup is a TODO — neither Codex
// nor Gemini's MCP currently expose a "did this request complete?"
// query. For now this records the user's manual disposition (or a
// best-guess timeout heuristic). v3.9.x can wire real lookups when
// the providers expose them.
function reconcile(action_id, { remote_status, actual_cost_usd, reason } = {}) {
  if (!action_id) return false;
  if (remote_status && !REMOTE_STATUSES.includes(remote_status)) return false;
  try {
    fs.mkdirSync(_vantaDir(), { recursive: true });
    _maybeRotate(_file());
    jsonl().appendJsonlLine(_file(), {
      action_id,
      cancelled_at: new Date().toISOString(),
      cancellation_kind: 'reconciliation',  // sentinel — not in CANCELLATION_KINDS
      in_flight_remote_call: {
        cancelled_locally: true,
        remote_status: remote_status || 'unknown',
        actual_cost_usd: typeof actual_cost_usd === 'number' ? actual_cost_usd : null,
        reason: reason || null,
      },
    });
    return true;
  } catch (_) {
    return false;
  }
}

// Cost-honest sentence for the user. Reads pending reconciliations
// and produces the message a handler should surface. Honest by
// default — never claims "no charge".
function summarizePending() {
  const pending = findPendingReconciliation();
  if (pending.length === 0) return null;
  const sums = pending.map(p => p.in_flight_remote_call.estimated_cost_usd || 0);
  const total = sums.reduce((a, b) => a + b, 0);
  const totalStr = total > 0 ? `~$${total.toFixed(2)}` : 'unknown amount';
  return {
    count: pending.length,
    total_estimated_usd: total,
    message: pending.length === 1
      ? `One council call you stopped may have completed remotely (${totalStr}). I'll reconcile next session if the provider exposes the lookup.`
      : `${pending.length} council calls you stopped may have completed remotely (${totalStr} estimated total). I'll reconcile next session.`,
  };
}

module.exports = {
  CANCELLATION_KINDS,
  REMOTE_STATUSES,
  record,
  readAll,
  findPendingReconciliation,
  reconcile,
  summarizePending,
  _file,
};
