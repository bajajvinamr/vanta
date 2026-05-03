#!/usr/bin/env node
// vanta-statusline — compose with the existing statusline and append a
// terse Vanta heartbeat indicator.
//
// Wraps the user's existing statusline command (defaults to
// gsd-statusline if present), then appends ` │ vanta <state>` where
// <state> is one of:
//
//   ✓ Ns   tool-observer fired within last 60s   (definitely alive)
//   ✓ Nm   fired within last 5min                 (alive, idle)
//   ⚠ Nh   fired within last hour                 (idle, suspicious)
//   ✗ stale  no fire in >1h                       (likely broken)
//   ∅      ~/.vanta/interactions.jsonl missing    (not deployed)
//
// Plus inline alerts when present:
//   ⚡N    sync-queue has N unsynced sessions
//   ❗     hook errors in last hour
//
// Performance: <30ms hot path. Three fs.statSync calls; no full-file
// reads. Skip on any error — never break the statusline.
//
// Surface Impact Discipline: zero new commands. The user types nothing
// to invoke this; it runs automatically on every message refresh.

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const VANTA_DIR = path.join(os.homedir(), '.vanta');
const INTERACTIONS = path.join(VANTA_DIR, 'interactions.jsonl');
const SYNC_QUEUE   = path.join(VANTA_DIR, 'sync-queue.jsonl');
const HOOK_LOG     = path.join(VANTA_DIR, 'hook.log');

// Path to the upstream statusline this wraps. Defaults to gstack's;
// override via env if user has another. Empty means no upstream — we
// emit just the vanta segment.
const UPSTREAM = process.env.VANTA_STATUSLINE_UPSTREAM
  || path.join(os.homedir(), '.claude', 'hooks', 'gsd-statusline.js');

function _safeStat(fp) {
  try { return fs.statSync(fp); } catch { return null; }
}

function _heartbeat() {
  const st = _safeStat(INTERACTIONS);
  if (!st) return '∅';
  const ageMs = Date.now() - st.mtimeMs;
  if (ageMs < 60_000) {
    return `✓ ${Math.max(1, Math.floor(ageMs / 1000))}s`;
  }
  if (ageMs < 300_000) {
    return `✓ ${Math.floor(ageMs / 60_000)}m`;
  }
  if (ageMs < 3_600_000) {
    return `⚠ ${Math.floor(ageMs / 60_000)}m`;
  }
  if (ageMs < 24 * 3_600_000) {
    return `⚠ ${Math.floor(ageMs / 3_600_000)}h`;
  }
  return '✗ stale';
}

function _unsyncedCount() {
  // Cheap heuristic — file size > 0 and there's any unsynced entry.
  // We don't full-parse here; that would blow the perf budget on busy
  // installs. Just check if the file exists and has bytes; the brief's
  // crash-recovery surface handles the precise count.
  const st = _safeStat(SYNC_QUEUE);
  if (!st || st.size === 0) return 0;
  // Read up to 64KB from the END to look for "synced":false
  try {
    const fd = fs.openSync(SYNC_QUEUE, 'r');
    const cap = Math.min(st.size, 64 * 1024);
    const buf = Buffer.alloc(cap);
    fs.readSync(fd, buf, 0, cap, st.size - cap);
    fs.closeSync(fd);
    const tail = buf.toString('utf8');
    // Approximate — tail-only sample, dedup not applied. Soak report
    // does the precise math; we just want a "are there any?" signal.
    const matches = tail.match(/"synced":false/g);
    return matches ? matches.length : 0;
  } catch { return 0; }
}

function _hasRecentHookErrors() {
  const st = _safeStat(HOOK_LOG);
  if (!st || st.size === 0) return false;
  // Mtime quick-reject: if the log hasn't been touched in the last
  // hour, there can't be recent errors. Saves the tail read.
  if (Date.now() - st.mtimeMs >= 3_600_000) return false;
  // Tail read: hook.log contains both ERROR and INFO levels, so we
  // can't infer error from mtime alone. Read last 32KB and grep for
  // ERROR lines whose ts is within the hour.
  try {
    const fd = fs.openSync(HOOK_LOG, 'r');
    const cap = Math.min(st.size, 32 * 1024);
    const buf = Buffer.alloc(cap);
    fs.readSync(fd, buf, 0, cap, st.size - cap);
    fs.closeSync(fd);
    const tail = buf.toString('utf8');
    const cutoff = new Date(Date.now() - 3_600_000).toISOString();
    // Format: "2026-05-03T16:07:41.525Z | ERROR | source | msg"
    for (const line of tail.split('\n')) {
      if (!line.includes('| ERROR |')) continue;
      const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
      if (m && m[1] >= cutoff) return true;
    }
    return false;
  } catch { return false; }
}

function _vantaSegment() {
  try {
    const heartbeat = _heartbeat();
    const parts = [`vanta ${heartbeat}`];
    const unsynced = _unsyncedCount();
    if (unsynced > 0) parts.push(`⚡${unsynced}`);
    if (_hasRecentHookErrors()) parts.push('❗');
    return parts.join(' ');
  } catch (_) {
    return 'vanta ∅';  // never break the statusline
  }
}

function _runUpstream(stdin) {
  if (!UPSTREAM) return '';
  try {
    if (!fs.existsSync(UPSTREAM)) return '';
    const r = spawnSync('node', [UPSTREAM], {
      input: stdin,
      encoding: 'utf8',
      timeout: 1000,  // hard cap — never block the statusline
    });
    if (r.status !== 0) return '';
    return (r.stdout || '').replace(/\n+$/, '');
  } catch (_) { return ''; }
}

function main() {
  // Read stdin (Claude Code passes session info as JSON on stdin).
  let stdin = '';
  try {
    stdin = fs.readFileSync(0, 'utf8');
  } catch { /* no stdin — fine */ }
  const upstream = _runUpstream(stdin);
  const vanta = _vantaSegment();
  const sep = '\x1b[2m │ \x1b[0m';  // dim separator matching gsd-statusline
  const out = upstream ? `${upstream}${sep}${vanta}` : vanta;
  process.stdout.write(out);
}

if (require.main === module) main();

module.exports = { _heartbeat, _vantaSegment, _unsyncedCount, _hasRecentHookErrors };
