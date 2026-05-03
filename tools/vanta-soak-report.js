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
  // R1 council fix (Codex P3): the prior denominator was
  // `totalPrompts + recallTotal`, but route-quality.jsonl already
  // includes recall prompts (recordRoute fires on every prompt that
  // hits the executor, regardless of slash-prefix). That math
  // double-counted recalls and diluted the bypass rate. Correct
  // formula: bypass rate = recallTotal / totalPrompts (recall is a
  // subset of total).
  lines.push('## 1. Manual command recall (v3.9 success metric)');
  lines.push('');
  const totalPrompts = route.length;
  const recallTotal = recall.length;
  const recallPct = totalPrompts > 0 ? Math.round(100 * recallTotal / totalPrompts) : 0;
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

  // ── 7. Rule Effectiveness (v3.10 commit 5) ─────────────────────────
  // Reads rule-effectiveness.jsonl + uses vanta-rule-effectiveness.js
  // to compute current per-rule scores against the live telemetry.
  // Surfaces: top fired, lowest CI, currently quarantined.
  lines.push('## 7. Rule Effectiveness (v3.10)');
  lines.push('');
  try {
    const re = _loadRuleEffectiveness();
    if (!re) {
      lines.push('_vanta-rule-effectiveness.js not deployed — install bin then re-run._');
    } else {
      const { rules } = re.compute({});
      const status = re.readLatestStatus();
      if (rules.length === 0) {
        lines.push('_No rules visible in current telemetry window._');
      } else {
        // Sort by total signal (fires + recalls)
        const sorted = [...rules].sort((a, b) =>
          (b.fires + b.recalled) - (a.fires + a.recalled),
        );
        lines.push('### Top fired (with success rate / Wilson CI lower)');
        for (const r of sorted.slice(0, 5)) {
          const st = status.get(r.rule_id)?.status || 'active';
          const success = (r.success_rate * 100).toFixed(0) + '%';
          const ci = r.ci_lower.toFixed(3);
          lines.push(`- ${r.rule_id}: fires=${r.fires}, success=${success}, ci_lower=${ci}, status=${st}`);
        }
        const flaggedOrQuar = sorted.filter(r => {
          const st = status.get(r.rule_id)?.status;
          return st === 'flagged' || st === 'quarantined';
        });
        if (flaggedOrQuar.length > 0) {
          lines.push('');
          lines.push('### Flagged / Quarantined');
          for (const r of flaggedOrQuar) {
            const entry = status.get(r.rule_id);
            const reason = entry.status_reason || '(no reason)';
            lines.push(`- ${r.rule_id}: ${entry.status} — ${reason}`);
          }
        }
      }
    }
  } catch (e) {
    lines.push(`_Rule effectiveness section error: ${e.message}_`);
  }
  lines.push('');

  // ── 8. Invariant Evidence (v3.10 commit 5) ─────────────────────────
  // Reads invariant-evidence.jsonl. Surfaces top-cited and cold (no
  // user-prompt retrieval in window) invariants.
  lines.push('## 8. Invariant Evidence (v3.10)');
  lines.push('');
  try {
    const evid = _loadEvidenceLog();
    if (!evid) {
      lines.push('_vanta-evidence-log.js not deployed — install bin then re-run._');
    } else {
      const { top, cold } = evid.topAndBottomCited({ topK: 5, bottomK: 5 });
      if (top.length === 0 && cold.length === 0) {
        lines.push('_No invariant evidence recorded yet._');
      } else {
        if (top.length > 0) {
          lines.push('### Top-cited (user-prompt retrievals + council TPs)');
          for (const s of top) {
            const total = s.retrieved_count + s.council_tp_count;
            lines.push(`- ${s.invariant_hash}: ${total} citations (retrieved=${s.retrieved_count}, council_tp=${s.council_tp_count})`);
          }
        }
        if (cold.length > 0) {
          lines.push('');
          lines.push('### Cold (no user-prompt retrieval in 30d — quarantine candidates)');
          for (const s of cold) {
            lines.push(`- ${s.invariant_hash}: 0 retrievals in window`);
          }
        }
      }
    }
  } catch (e) {
    lines.push(`_Invariant evidence section error: ${e.message}_`);
  }
  lines.push('');

  // ── 10. /vanta-sync extraction health (v3.11 commit 5 — MANDATORY per C-7)
  // Without this section, silent extract regressions are invisible:
  // a buggy extract bin would silently fall back to transcript scan
  // (or produce zero candidates), and the user wouldn't know /vanta-sync
  // had quietly degraded back to the 1M-context wall it was meant to fix.
  //
  // Three metrics per the v3.11 done-definition:
  //   (a) extract success rate (target ≥99%)
  //   (b) transcript_fallback rate (target <20%)
  //   (c) standard-context completion proxy (target ≥95%)
  //       — proxied by extract runs that emit ≥1 candidate without hint
  const extractEvents = _loadJsonl('sync-extract-events.jsonl').filter(e => _withinWindow(e, sinceMs));
  lines.push('## 10. /vanta-sync extraction health (v3.11)');
  lines.push('');
  if (extractEvents.length === 0) {
    lines.push('_No /vanta-sync runs in window._');
    lines.push('');
  } else {
    const total = extractEvents.length;
    const ok = extractEvents.filter(e => e.success !== false).length;
    const successRate = Math.round(100 * ok / total);
    // Council R2 P2 (both-confirmed) — `transcript_hint_emitted === true`
    // is the wrong signal. The hint is always emitted when sync-queue
    // has unsynced entries, regardless of whether the SKILL.md actually
    // tails the transcript. The true "fallback used" proxy is:
    //   hint emitted AND zero structured candidates produced
    // (i.e., extract had nothing to give and the SKILL.md will fall
    // back to the transcript path it received).
    const withFallback = extractEvents.filter(e =>
      e.transcript_hint_emitted === true && (e.candidate_count || 0) === 0
    ).length;
    const fallbackRate = Math.round(100 * withFallback / total);
    const standardOk = extractEvents.filter(e =>
      e.success !== false && (e.candidate_count || 0) > 0
    ).length;
    const standardRate = Math.round(100 * standardOk / total);
    const zeroCandidate = extractEvents.filter(e => (e.candidate_count || 0) === 0).length;
    const zeroRate = Math.round(100 * zeroCandidate / total);
    const avgDuration = Math.round(
      extractEvents.reduce((s, e) => s + (e.duration_ms || 0), 0) / total
    );

    const flag = (rate, target, dir) => {
      if (dir === 'gte' && rate < target) return ' ⚠';
      if (dir === 'lte' && rate > target) return ' ⚠';
      return '';
    };
    lines.push(`- Total /vanta-sync extract runs: **${total}**`);
    lines.push(`- Extract success rate: **${successRate}%** (target ≥99%)${flag(successRate, 99, 'gte')}`);
    lines.push(`- Standard-context completion: **${standardRate}%** (target ≥95%)${flag(standardRate, 95, 'gte')}`);
    lines.push(`- Transcript-fallback rate: **${fallbackRate}%** (target <20%)${flag(fallbackRate, 20, 'lte')}`);
    lines.push(`- Zero-candidate runs: **${zeroRate}%** (high may indicate extract regression)`);
    lines.push(`- Avg duration: **${avgDuration}ms**`);
    if (zeroRate > 50) {
      lines.push('');
      lines.push('  > ⚠ More than half of runs produce zero candidates. Check `~/.vanta/episodes.jsonl` is being written by the Stop hook.');
    }
    if (fallbackRate > 20) {
      lines.push('');
      lines.push('  > ⚠ Transcript fallback rate above 20% target. The structured-telemetry path is missing signals — investigate auto-sync.js Stop hook.');
    }
    lines.push('');
  }

  // ── 9. Missed-Intent Clusters (v3.10 commit 5) ─────────────────────
  // Better than topN by exact-string: clusters semantically-similar
  // missed prompts together so the operator can see "5 prompts about
  // X" rather than 5 separate entries.
  lines.push('## 9. Missed-Intent Clusters (v3.10)');
  lines.push('');
  if (missed.length === 0) {
    lines.push('_No missed intents recorded in window._');
  } else {
    const clusters = clusterMissedIntents(missed, { topK: 5 });
    if (clusters.length === 0) {
      lines.push('_All missed intents were unique (no cluster threshold met)._');
    } else {
      for (const c of clusters) {
        lines.push(`- "${c.label}" — ${c.size} prompts (top tokens: ${c.tokens.slice(0, 4).join(', ')})`);
      }
    }
  }
  lines.push('');

  return lines.join('\n');
}

// ─── v3.10 commit 5 helpers ─────────────────────────────────────────

function _loadRuleEffectiveness() {
  for (const p of [
    path.join(__dirname, '..', 'bin', 'vanta-rule-effectiveness.js'),
    path.join(os.homedir(), '.claude', 'bin', 'vanta-rule-effectiveness.js'),
  ]) {
    try { return require(p); } catch (_) { /* try next */ }
  }
  return null;
}

function _loadEvidenceLog() {
  for (const p of [
    path.join(__dirname, '..', 'bin', 'vanta-evidence-log.js'),
    path.join(os.homedir(), '.claude', 'bin', 'vanta-evidence-log.js'),
  ]) {
    try { return require(p); } catch (_) { /* try next */ }
  }
  return null;
}

// Cluster missed intents by token-set similarity (Jaccard). Greedy:
// pick the most-frequent token, group all prompts containing it, label
// the cluster by the most-distinctive shared token.
//
// This is a simple-on-purpose clusterer — soak report runs once a
// week, doesn't need k-means or LDA. The point is to surface "5
// prompts about deploying" instead of 5 distinct strings.
function clusterMissedIntents(missed, { topK = 5, minClusterSize = 2 } = {}) {
  if (!Array.isArray(missed) || missed.length === 0) return [];
  // Normalize: prompts → token-sets (lowercased, length>=4, deduped)
  const STOPWORDS = new Set(['this','that','what','when','where','with','from','have','will','would','should','could','about','which','please','could','make','just','need','want','help','really']);
  const docs = [];
  for (const e of missed) {
    const text = String(e.prompt || '').toLowerCase();
    const tokens = new Set();
    for (const m of text.match(/[a-z][a-z0-9-]{3,}/g) || []) {
      if (!STOPWORDS.has(m)) tokens.add(m);
    }
    if (tokens.size > 0) docs.push({ prompt: e.prompt, tokens });
  }
  if (docs.length === 0) return [];
  // Token frequency across corpus
  const tokenFreq = new Map();
  for (const d of docs) {
    for (const tok of d.tokens) tokenFreq.set(tok, (tokenFreq.get(tok) || 0) + 1);
  }
  const sortedTokens = [...tokenFreq.entries()].sort((a, b) => b[1] - a[1]);
  const clusters = [];
  const claimed = new Set();
  for (const [pivot, _freq] of sortedTokens) {
    if (clusters.length >= topK) break;
    const members = [];
    for (let i = 0; i < docs.length; i++) {
      if (claimed.has(i)) continue;
      if (docs[i].tokens.has(pivot)) members.push(i);
    }
    if (members.length < minClusterSize) continue;
    // Compute the cluster's distinctive tokens: those appearing in
    // ≥50% of cluster members.
    const memberTokenCounts = new Map();
    for (const idx of members) {
      for (const tok of docs[idx].tokens) {
        memberTokenCounts.set(tok, (memberTokenCounts.get(tok) || 0) + 1);
      }
    }
    const tokenScore = [...memberTokenCounts.entries()]
      .filter(([_, c]) => c >= Math.max(2, Math.ceil(members.length / 2)))
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => t);
    // Use a representative prompt as the label (truncated)
    const labelPrompt = docs[members[0]].prompt.slice(0, 60);
    clusters.push({
      label: labelPrompt,
      size: members.length,
      tokens: tokenScore,
    });
    for (const idx of members) claimed.add(idx);
  }
  return clusters;
}

module.exports = { buildReport, _loadJsonl, clusterMissedIntents };

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
