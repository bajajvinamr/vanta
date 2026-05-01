#!/usr/bin/env node
// vanta-action-log — append-only ledger of every Vanta auto-action.
//
// Without this, when auto-execution is wrong, there's no record of WHAT
// Vanta did or WHY. With this, vanta-undo can reverse the action and
// vanta-trust-metrics can compute regret rate.
//
// Each entry:
//   {
//     ts:           ISO-8601 string,
//     session_id:   string | null,
//     project:      slug | null,
//     branch:       string | null,
//     action:       'rewrite' | 'auto-edit' | 'council-fire' | 'auto-promote' |
//                   'autonomy-promote' | 'safety-floor-block' | 'staging-write' | …,
//     why:          one-line reason — "matched safety floor X" / "tier=T2 risk=8"
//     subject:      free-form (file path, command, prompt hash),
//     undo_hint:    { kind, payload } | null     -- see vanta-undo
//     trust:        'trusted' | 'untrusted'      -- prompt-injection guard
//     tier:         'T0' | 'T1' | 'T2' | 'T3' | null
//     decision:     'auto' | 'ask' | 'block'
//   }
//
// Storage: ~/.vanta/actions.jsonl. Same rotation/torn-line semantics as
// sync-queue (append-only, .bak.<ts> on > 5MB, read with vanta-jsonl
// merge primitive). Every consumer reads it via readMergedJsonl.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { appendJsonlLine, readMergedJsonl } = require('./vanta-jsonl');

let _vlog;
function vlog() {
  if (_vlog) return _vlog;
  for (const p of [
    path.join(os.homedir(), '.claude', 'bin', 'vanta-log.js'),
    path.join(__dirname, 'vanta-log.js'),
  ]) { try { _vlog = require(p); return _vlog; } catch {} }
  _vlog = { info: () => {}, warn: () => {}, error: () => {} };
  return _vlog;
}

function _vantaDir() {
  return process.env.VANTA_DIR_OVERRIDE || path.join(os.homedir(), '.vanta');
}
function _file() { return path.join(_vantaDir(), 'actions.jsonl'); }
const MAX_BYTES = 5_000_000;

// Generate a stable 12-char id for an action — enough collision space
// (16^12 ≈ 2.8e14) for an append-only log that gets at most ~10K entries
// per active project per quarter. Used by undo to target by id, not
// subject (R1 P2: subject-based attribution over-counts).
function _newActionId() {
  return 'act-' + crypto.randomBytes(6).toString('hex');
}

// Append-only writer. Rotates file via rename when > MAX_BYTES.
// Mirrors auto-sync.js rotation semantics for consistency.
//
// Rotation race (R1 P3, Gemini): two concurrent writers both see
// size > MAX_BYTES, both rename. The first wins (file moves to bak);
// the second's rename either fails (file gone) or rotates the new tiny
// file. We bound the damage by re-statting after acquiring the file
// descriptor — if the file is now small, skip rotation.
function record(entry) {
  try {
    fs.mkdirSync(_vantaDir(), { recursive: true });
    const file = _file();
    if (fs.existsSync(file)) {
      let st;
      try { st = fs.statSync(file); } catch { st = null; }
      if (st && st.size > MAX_BYTES) {
        const ts = Date.now() + '.' + process.pid;
        const target = `${file}.bak.${ts}`;
        // Re-stat with the same inode immediately before rename. If
        // a peer rotated already, the inode no longer matches and we
        // skip — prevents rotating tiny new file.
        try {
          const verify = fs.statSync(file);
          if (verify.ino === st.ino && verify.size > MAX_BYTES) {
            fs.renameSync(file, target);
          }
        } catch { /* peer rotated, race lost — fine */ }
      }
    }
    const full = {
      ts: new Date().toISOString(),
      id: entry.id || _newActionId(),  // R1 P2: stable id for undo target tracking
      session_id: entry.session_id || process.env.CLAUDE_SESSION_ID || null,
      project: entry.project || null,
      branch: entry.branch || null,
      action: entry.action,
      why: entry.why || '',
      subject: entry.subject || null,
      undo_hint: entry.undo_hint || null,
      trust: entry.trust || 'trusted',
      tier: entry.tier || null,
      decision: entry.decision || 'auto',
    };
    appendJsonlLine(file, full);
    return full;
  } catch (err) {
    vlog().error('action-log.record', err.message || String(err));
    return null;
  }
}

// Read merged ledger (live + .bak.<ts>) and return parsed entries,
// optionally filtered by session, project, action, time range.
function read({ session_id, project, action, sinceMs, untilMs, limit } = {}) {
  const merged = readMergedJsonl(_file());
  const entries = [];
  for (const line of merged.split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (session_id && e.session_id !== session_id) continue;
    if (project   && e.project   !== project)   continue;
    if (action    && e.action    !== action)    continue;
    if (sinceMs   && Date.parse(e.ts) < sinceMs) continue;
    if (untilMs   && Date.parse(e.ts) > untilMs) continue;
    entries.push(e);
  }
  if (limit && entries.length > limit) return entries.slice(-limit);
  return entries;
}

// Find the most recent entry matching a predicate. Used by vanta-undo
// to locate "what did Vanta last do?".
function findLast(pred) {
  const entries = read({});
  for (let i = entries.length - 1; i >= 0; i--) {
    if (pred(entries[i])) return entries[i];
  }
  return null;
}

// Stats roll-up by action type. Used by vanta-trust-metrics + status.
function rollup({ sinceMs } = {}) {
  const entries = read({ sinceMs });
  const byAction = new Map();
  const byDecision = new Map();
  const byTier = new Map();
  for (const e of entries) {
    byAction.set(e.action, (byAction.get(e.action) || 0) + 1);
    byDecision.set(e.decision, (byDecision.get(e.decision) || 0) + 1);
    if (e.tier) byTier.set(e.tier, (byTier.get(e.tier) || 0) + 1);
  }
  return {
    total: entries.length,
    actions: Object.fromEntries(byAction),
    decisions: Object.fromEntries(byDecision),
    tiers: Object.fromEntries(byTier),
    spanFrom: entries[0]?.ts || null,
    spanTo: entries[entries.length - 1]?.ts || null,
  };
}

module.exports = { record, read, findLast, rollup };

// CLI:
//   vanta-action-log tail [N]
//   vanta-action-log rollup [--since-h N]
if (require.main === module) {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === 'tail') {
    const n = parseInt(rest[0], 10) || 20;
    const entries = read({ limit: n });
    for (const e of entries) {
      process.stdout.write(`${e.ts}  ${(e.decision || 'auto').padEnd(5)}  ${e.action.padEnd(20)}  ${(e.subject || '').slice(0, 60)}  -- ${e.why}\n`);
    }
  } else if (cmd === 'rollup') {
    const sinceFlag = rest.find(a => a.startsWith('--since-h='));
    const sinceMs = sinceFlag ? Date.now() - parseInt(sinceFlag.slice('--since-h='.length), 10) * 3_600_000 : undefined;
    process.stdout.write(JSON.stringify(rollup({ sinceMs }), null, 2) + '\n');
  } else {
    process.stderr.write('usage: vanta-action-log <tail [N]|rollup [--since-h H]>\n');
    process.exit(2);
  }
}
