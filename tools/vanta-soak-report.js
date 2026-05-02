#!/usr/bin/env node
// vanta-soak-report — weekly builder-readable report of Vanta routing
// health. v3.8.2 hidden observability. No user surface; the builder
// reads this manually to tune `policy/router-thresholds.yaml` and
// rule priority for v3.9.1.
//
// Inputs (all under ~/.vanta/):
//   route-quality.jsonl    one entry per executor decide() with prompt
//   manual-recalls.jsonl   user typed /ship etc. instead of /vanta
//   actions.jsonl          undo + safety-floor + auto-edit ledger
//   missed-intents.jsonl   prompts the rewriter could not classify
//
// Output: markdown to stdout (or --out FILE). Sections:
//   1. Manual command recall — % bypass rate by surface
//   2. Top routing misses — where the user followed a different route
//   3. Top ignored suggestions — /<route> suggested N times, followed 0
//   4. Top undo causes — what got auto-edited then reversed
//   5. Confidence histogram — distribution of confidence at suggestion time
//   6. Margin histogram — top-1 vs top-2 margin distribution
//
// Defaults: last 7 days. Override with --window-days N.

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function _vantaDir() {
  return process.env.VANTA_DIR_OVERRIDE || path.join(os.homedir(), '.vanta');
}
const DEFAULT_WINDOW_DAYS = 7;

function _loadJsonl(filename) {
  const file = path.join(_vantaDir(), filename);
  // Also pick up rotated .bak.<ts> siblings so the report doesn't go
  // blind right after a rotation. Mirrors the same pattern using-vanta
  // SKILL.md uses for sync-queue.
  let entries = [];
  const candidates = [file];
  try {
    const dir = _vantaDir();
    if (fs.existsSync(dir)) {
      const baks = fs.readdirSync(dir)
        .filter(f => f.startsWith(filename + '.bak.'))
        .map(f => path.join(dir, f));
      candidates.push(...baks);
    }
  } catch (_) { /* ignore */ }
  for (const fp of candidates) {
    if (!fs.existsSync(fp)) continue;
    try {
      const raw = fs.readFileSync(fp, 'utf8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { entries.push(JSON.parse(t)); } catch { /* torn line — skip */ }
      }
    } catch (_) { /* unreadable — skip */ }
  }
  return entries;
}

function _withinWindow(entry, sinceMs) {
  if (!entry || !entry.ts) return false;
  const t = Date.parse(entry.ts);
  return Number.isFinite(t) && t >= sinceMs;
}

// Top-N by count over a key extractor.
function _topN(entries, extractKey, n = 5) {
  const counts = new Map();
  for (const e of entries) {
    const k = extractKey(e);
    if (k == null) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

function buildReport({ windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  const sinceMs = Date.now() - windowDays * 24 * 3600 * 1000;
  const route = _loadJsonl('route-quality.jsonl').filter(e => _withinWindow(e, sinceMs));
  const recall = _loadJsonl('manual-recalls.jsonl').filter(e => _withinWindow(e, sinceMs));
  const actions = _loadJsonl('actions.jsonl').filter(e => _withinWindow(e, sinceMs));
  const missed = _loadJsonl('missed-intents.jsonl').filter(e => _withinWindow(e, sinceMs));

  const lines = [];
  const ts = new Date().toISOString().slice(0, 10);
  lines.push(`# Vanta Soak Report — ${ts}`);
  lines.push('');
  lines.push(`Window: last ${windowDays}d · Source: \`~/.vanta/{route-quality,manual-recalls,actions,missed-intents}.jsonl\``);
  lines.push('');

  // ── 1. Manual command recall ────────────────────────────────────────
  lines.push('## 1. Manual command recall (v3.9 success metric)');
  lines.push('');
  const totalPrompts = route.length;
  const recallTotal = recall.length;
  const recallPct = totalPrompts > 0 ? Math.round(100 * recallTotal / (totalPrompts + recallTotal)) : 0;
  lines.push(`- Vanta-routed prompts: **${totalPrompts}**`);
  lines.push(`- Manual recalls (non-/vanta slash commands): **${recallTotal}** (${recallPct}% bypass)`);
  if (recallTotal > 0) {
    const bySurface = _topN(recall, e => e.surface, 5);
    lines.push('- By surface:');
    for (const [surface, count] of bySurface) {
      const topCmds = _topN(recall.filter(e => e.surface === surface), e => `/${e.command}`, 3)
        .map(([c, n]) => `${c}×${n}`)
        .join(', ');
      lines.push(`  - **${surface}**: ${count}  (${topCmds})`);
    }
  }
  lines.push('');

  // ── 2. Top ignored suggestions ──────────────────────────────────────
  lines.push('## 2. Top ignored suggestions');
  lines.push('');
  // An "ignored" suggestion = route-quality entry with non-null
  // suggested_route AND user_followed_route === false. Until v3.9.1
  // wires that field, we count by suggested_route + later_undo === true
  // OR later_manual_correction === true as a proxy.
  const ignored = route.filter(e =>
    e.suggested_route &&
    (e.user_followed_route === false || e.later_manual_correction === true || e.later_undo === true),
  );
  if (ignored.length === 0) {
    lines.push('_No ignored suggestions in window. (Field not yet backfilled by v3.9.1 router; populated when user follows or diverges.)_');
  } else {
    const topIgnored = _topN(ignored, e => e.suggested_route, 5);
    for (const [route, count] of topIgnored) {
      lines.push(`- ${route}: suggested ${count}× / followed 0`);
    }
  }
  lines.push('');

  // ── 3. Top routing misses (rewriter unmatched) ──────────────────────
  lines.push('## 3. Top routing misses (rewriter unmatched)');
  lines.push('');
  if (missed.length === 0) {
    lines.push('_No missed intents recorded in window._');
  } else {
    const topMissed = _topN(missed, e => (e.prompt || '').slice(0, 80), 5);
    for (const [prompt, count] of topMissed) {
      lines.push(`- "${prompt}" — ${count}×`);
    }
  }
  lines.push('');

  // ── 4. Top undo causes ──────────────────────────────────────────────
  lines.push('## 4. Top undo causes');
  lines.push('');
  const undos = actions.filter(a => a.action === 'undo' || a.decision === 'rollback');
  if (undos.length === 0) {
    lines.push('_No undo events in window._');
  } else {
    const topUndo = _topN(undos, e => {
      // Prefer the kind from undo_hint if present, else action verb.
      const k = (e.undo_hint && e.undo_hint.kind) || e.action || 'unknown';
      return k;
    }, 5);
    for (const [kind, count] of topUndo) {
      lines.push(`- ${kind}: ${count}× reversed`);
    }
  }
  lines.push('');

  // ── 5. Confidence histogram ─────────────────────────────────────────
  lines.push('## 5. Confidence histogram');
  lines.push('');
  if (route.length === 0) {
    lines.push('_No route-quality entries in window._');
  } else {
    const buckets = { low: 0, medium: 0, high: 0, numeric: { low: 0, mid: 0, hi: 0 } };
    for (const e of route) {
      const c = e.confidence;
      if (typeof c === 'string' && buckets[c] != null) buckets[c]++;
      else if (typeof c === 'number') {
        if (c < 0.5) buckets.numeric.low++;
        else if (c < 0.8) buckets.numeric.mid++;
        else buckets.numeric.hi++;
      }
    }
    lines.push(`- high (≥0.8 / 'high'): ${buckets.high + buckets.numeric.hi}`);
    lines.push(`- medium (0.5–0.8 / 'medium'): ${buckets.medium + buckets.numeric.mid}`);
    lines.push(`- low (<0.5 / 'low'): ${buckets.low + buckets.numeric.low}`);
  }
  lines.push('');

  // ── 6. Margin histogram (v3.9.1 catch-all entry condition) ──────────
  lines.push('## 6. Margin histogram (top-1 vs top-2)');
  lines.push('');
  if (route.length === 0) {
    lines.push('_No route-quality entries in window._');
  } else {
    let lt10 = 0, lt33 = 0, lt99 = 0, eq100 = 0;
    for (const e of route) {
      const m = typeof e.top1_top2_margin === 'number' ? e.top1_top2_margin : 1.0;
      if (m < 0.10) lt10++;
      else if (m < 0.34) lt33++;
      else if (m < 1.0) lt99++;
      else eq100++;
    }
    lines.push(`- margin <0.10 (catch-all candidate): ${lt10}`);
    lines.push(`- margin 0.10–0.34 (ambiguous): ${lt33}`);
    lines.push(`- margin 0.34–1.00 (multi-rule overlap): ${lt99}`);
    lines.push(`- margin = 1.00 (clean): ${eq100}`);
  }
  lines.push('');

  return lines.join('\n');
}

module.exports = { buildReport, _loadJsonl };

if (require.main === module) {
  const args = process.argv.slice(2);
  const find = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const out = find('--out');
  const windowDays = Number.parseInt(find('--window-days'), 10) || DEFAULT_WINDOW_DAYS;
  const md = buildReport({ windowDays });
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, md);
    process.stdout.write(`wrote ${out}\n`);
  } else {
    process.stdout.write(md);
    if (!md.endsWith('\n')) process.stdout.write('\n');
  }
}
