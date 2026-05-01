#!/usr/bin/env node
// vanta-trust-metrics — aggregate trust signals from action-log + git.
//
// Computes the composite trust score described in the v3.7 plan:
//
//   undo_within_2m_rate  = pct of auto-actions undone via vanta-undo within 2min
//   manual_interrupt_rate = pct of sessions where user typed "stop"/"don't"/"undo"
//   chain_success_rate   = pct of multi-step auto-actions that completed clean
//   silent_regret_rate   = pct of files Vanta auto-edited that user later reverted
//                          (semantic undo across >1 day) — see vanta-regret-detector
//
// Composite trust threshold for default-inline rewriter:
//   undo_within_2m < 2%  AND
//   manual_interrupt < 5%  AND
//   chain_success > 70%
//   sustained for 14 days
//
// Output is JSON for programmatic consumers (vanta-status, autonomy
// auto-promote logic) and a human summary for direct CLI use.

const fs = require('fs');
const path = require('path');
const os = require('os');

const { read, rollup } = require('./vanta-action-log');
const { readMergedJsonl } = require('./vanta-jsonl');

function _vantaDir() {
  return process.env.VANTA_DIR_OVERRIDE || path.join(os.homedir(), '.vanta');
}
function _interactionsFile() { return path.join(_vantaDir(), 'interactions.jsonl'); }

const TWO_MIN_MS = 2 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Detect manual-interrupt prompts. Crude regex on the user prompt
// (vanta interaction log captures shape only — see how events look in
// interactions.jsonl). Words: "stop", "undo", "don't", "no actually",
// "revert that", "wait".
const INTERRUPT_RX = /\b(stop|undo|revert.{0,15}that|don'?t|no.{0,4}actually|wait.{0,30}don'?t|that's wrong)\b/i;

// undo_within_2m: an auto-action is "regretted" if a vanta-undo entry
// references it and lands within 2 min of the original.
//
// R1 P2 (Codex): the original implementation matched by subject equality
// when no id was present. One undo on `foo.ts` was attributed to every
// recent auto-action on `foo.ts`, spiking undo_24h above 5% and triggering
// false autonomy demotions. v3.6.20 fix: prefer id match when present
// (which is now ALWAYS, since action-log assigns one), fall back to
// subject only when targets_action_id is null AND the timing is unique
// within the window (no other auto-actions on the same subject in the
// 2-min window).
function _undoWithin2m(entries) {
  const auto = entries.filter(e => e.decision === 'auto' && e.action !== 'undo');
  if (auto.length === 0) return { rate: 0, n: 0, regretted: 0 };
  const undoEntries = entries.filter(e => e.action === 'undo');
  let regretted = 0;
  // Pre-compute: for each undo, did it have a targets_action_id?
  // If so, only match against the action with that id — never fan out
  // attribution to siblings on the same subject.
  for (const a of auto) {
    const aMs = Date.parse(a.ts);
    const found = undoEntries.find(u => {
      const within = (Date.parse(u.ts) - aMs) <= TWO_MIN_MS && (Date.parse(u.ts) - aMs) >= 0;
      if (!within) return false;
      const targetId = u.undo_hint && u.undo_hint.payload && u.undo_hint.payload.targets_action_id;
      if (targetId) {
        // Authoritative: only attribute to the action whose id matches.
        return a.id === targetId;
      }
      // Backward compat: undo logs from before v3.6.20 have no id.
      // Fall back to subject only when there's exactly ONE auto-action
      // with that subject in the 2-min window — otherwise we can't tell.
      if (!u.subject || !a.subject || u.subject !== a.subject) return false;
      const sameSubjectInWindow = auto.filter(x =>
        x.subject === a.subject &&
        Math.abs(Date.parse(x.ts) - aMs) <= TWO_MIN_MS).length;
      return sameSubjectInWindow === 1;
    });
    if (found) regretted++;
  }
  return { rate: regretted / auto.length, n: auto.length, regretted };
}

// manual_interrupt_rate: pct of distinct sessions where the user issued
// an interrupt-style prompt at any point. Reads interactions.jsonl
// (UserPromptSubmit shape captured by tool-observer).
//
// v3.8.0 council P2 fix — accepts a `project` filter so that interrupt
// rate is project-scoped too. Without this, a noisy repo poisons the
// `manual_interrupt` metric for every other repo, breaking the v3.7.5
// "project-scoped trust" promise.
function _interruptRate({ sinceMs, project }) {
  const file = _interactionsFile();
  if (!fs.existsSync(file)) return { rate: 0, n: 0, interrupted: 0 };
  const merged = readMergedJsonl(file);
  const lines = merged.split('\n').filter(Boolean);
  const sessions = new Set();
  const interruptedSessions = new Set();
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (sinceMs && Date.parse(e.ts) < sinceMs) continue;
    if (!e.session_id) continue;
    // Project filter: tool-observer writes `slug` (canonical project
    // name) and/or `project` to interactions.jsonl. Skip events from
    // other projects when the caller asked for a specific scope.
    if (project) {
      const eventProject = e.slug || e.project || null;
      if (eventProject && eventProject !== project) continue;
    }
    sessions.add(e.session_id);
    // Look for interrupt markers in the captured prompt text shape.
    // tool-observer stores `event` and `args.prompt` where applicable.
    const promptText = (e.args && e.args.prompt) || e.prompt || '';
    if (typeof promptText === 'string' && INTERRUPT_RX.test(promptText)) {
      interruptedSessions.add(e.session_id);
    }
  }
  if (sessions.size === 0) return { rate: 0, n: 0, interrupted: 0 };
  return {
    rate: interruptedSessions.size / sessions.size,
    n: sessions.size,
    interrupted: interruptedSessions.size,
  };
}

// chain_success_rate: a "chain" is N consecutive auto-actions in the
// same session. A chain "succeeds" if no interrupt or undo lands within
// the chain or 2min after its last action.
function _chainSuccess({ sinceMs, project }) {
  const entries = read({ sinceMs, project }).filter(e => e.session_id);
  if (entries.length === 0) return { rate: 0, n: 0, succeeded: 0 };
  // Group by session.
  const bySession = new Map();
  for (const e of entries) {
    if (!bySession.has(e.session_id)) bySession.set(e.session_id, []);
    bySession.get(e.session_id).push(e);
  }
  let chains = 0, succeeded = 0;
  for (const [, eList] of bySession) {
    // A chain = 2+ consecutive auto/decision='auto' entries.
    let i = 0;
    while (i < eList.length) {
      if (eList[i].decision !== 'auto') { i++; continue; }
      const start = i;
      while (i < eList.length && eList[i].decision === 'auto') i++;
      const end = i - 1;
      if (end - start < 1) continue;  // single action != a chain
      chains++;
      // Look for undo/block within the chain or 2 min after its end.
      const endMs = Date.parse(eList[end].ts);
      let broken = false;
      for (let j = end + 1; j < eList.length; j++) {
        const ms = Date.parse(eList[j].ts);
        if (ms - endMs > TWO_MIN_MS) break;
        if (eList[j].action === 'undo' || eList[j].decision === 'block') {
          broken = true;
          break;
        }
      }
      if (!broken) succeeded++;
    }
  }
  if (chains === 0) return { rate: 0, n: 0, succeeded: 0 };
  return { rate: succeeded / chains, n: chains, succeeded };
}

// Composite verdict: are we ready to flip rewriter shadow→inline?
//
// v3.7.5 — adds min_sample requirement. A 14-day span with 3 auto
// actions doesn't earn inline. Default min sample = 50 actions.
const DEFAULT_MIN_SAMPLE = 50;
function readyForInline(metrics, opts = {}) {
  const minSample = opts.min_sample != null ? opts.min_sample : DEFAULT_MIN_SAMPLE;
  const totalAuto = metrics.undo_within_2m && metrics.undo_within_2m.n || 0;
  return (
    metrics.undo_within_2m.rate < 0.02 &&
    metrics.manual_interrupt.rate < 0.05 &&
    metrics.chain_success.rate > 0.70 &&
    metrics.spanDays >= 14 &&
    totalAuto >= minSample
  );
}

// v3.7.5 — accepts `project` filter so trust is per-project, not global.
// A user with high trust in project-A doesn't auto-promote actions in a
// brand-new project-B. Reads action-log filtered by `project` slug.
function compute({ sinceMs, days, project, min_sample } = {}) {
  if (!sinceMs && days) sinceMs = Date.now() - days * ONE_DAY_MS;
  const entries = read({ sinceMs, project });
  const undoWithin2m = _undoWithin2m(entries);
  const manualInterrupt = _interruptRate({ sinceMs, project });
  const chainSuccess = _chainSuccess({ sinceMs, project });
  const spanDays = entries.length > 0
    ? Math.max(1, Math.round((Date.now() - Date.parse(entries[0].ts)) / ONE_DAY_MS))
    : 0;
  const out = {
    sinceMs: sinceMs || null,
    project: project || null,
    spanDays,
    actions: rollup({ sinceMs }),
    undo_within_2m: undoWithin2m,
    manual_interrupt: manualInterrupt,
    chain_success: chainSuccess,
  };
  out.ready_for_inline = readyForInline(out, { min_sample });
  return out;
}

module.exports = { compute, readyForInline, DEFAULT_MIN_SAMPLE };

// CLI: `vanta-trust-metrics [--days N|--since-h H]`
if (require.main === module) {
  const args = process.argv.slice(2);
  const daysArg = args.find(a => a.startsWith('--days='));
  const sinceHArg = args.find(a => a.startsWith('--since-h='));
  const days = daysArg ? parseInt(daysArg.slice('--days='.length), 10) : undefined;
  const sinceMs = sinceHArg ? Date.now() - parseInt(sinceHArg.slice('--since-h='.length), 10) * 3_600_000 : undefined;
  const json = args.includes('--json');
  const m = compute({ sinceMs, days });
  if (json) {
    process.stdout.write(JSON.stringify(m, null, 2) + '\n');
  } else {
    const pct = (n) => (n * 100).toFixed(1) + '%';
    process.stdout.write(`Trust metrics (span ${m.spanDays}d, ${m.actions.total} actions)\n`);
    process.stdout.write(`  undo_within_2m   ${pct(m.undo_within_2m.rate)}  (${m.undo_within_2m.regretted}/${m.undo_within_2m.n})\n`);
    process.stdout.write(`  manual_interrupt ${pct(m.manual_interrupt.rate)}  (${m.manual_interrupt.interrupted}/${m.manual_interrupt.n})\n`);
    process.stdout.write(`  chain_success    ${pct(m.chain_success.rate)}  (${m.chain_success.succeeded}/${m.chain_success.n})\n`);
    process.stdout.write(`  ready_for_inline ${m.ready_for_inline ? 'YES' : 'no'}\n`);
  }
}
