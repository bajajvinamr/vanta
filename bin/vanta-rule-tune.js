#!/usr/bin/env node
// vanta-rule-tune — operator CLI for the rewriter rule corpus.
//
// v3.10 commit 3. Per the v3.10 PLAN.md, this is the human escape hatch
// for the auto-quarantine loop:
//
//   list                        — show every rule with current scores + status
//   status <rule_id>            — detailed status for one rule
//   compute [--project p]       — recompute scores from telemetry, snapshot
//   quarantine <rule_id>        — manually quarantine (skip in rewriter)
//   rehabilitate <rule_id>      — flip back to active, open new scoring epoch
//   auto-quarantine [--dry-run] — quarantine every eligible rule (>=50 fires,
//                                 ci_lower<0.30, last_50_window_rate<0.30)
//
// Surface Impact Discipline: INTERNAL MACHINERY. Operator-only CLI;
// not surfaced as a slash command, not described in the user-facing
// three-command promise. Used by Vinamr (and future maintainers) to
// debug/tune the rewriter; behavior is auto-managed by snapshot()+
// auto-quarantine in the soak report otherwise.

'use strict';
const path = require('path');
const os = require('os');

let _eff;
function eff() {
  if (_eff) return _eff;
  for (const p of [
    path.join(__dirname, 'vanta-rule-effectiveness.js'),
    path.join(os.homedir(), '.claude', 'bin', 'vanta-rule-effectiveness.js'),
  ]) {
    try { _eff = require(p); return _eff; } catch (_) { /* try next */ }
  }
  throw new Error('vanta-rule-effectiveness.js not resolvable');
}

// ─── Output formatters ───────────────────────────────────────────────

function _formatRow(rule, status) {
  const fires = rule?.fires ?? 0;
  const success = rule?.success_rate != null
    ? (rule.success_rate * 100).toFixed(1) + '%'
    : '   —  ';
  const ci = rule?.ci_lower != null
    ? rule.ci_lower.toFixed(3)
    : '  —  ';
  const win = rule?.last_50_window_rate != null
    ? (rule.last_50_window_rate * 100).toFixed(0) + '%'
    : ' — ';
  const st = (status?.status || 'active').padEnd(12);
  const ruleId = (rule?.rule_id || '?').padEnd(20);
  return `${ruleId}  fires=${String(fires).padStart(4)}  success=${success.padStart(7)}  ci_lower=${ci}  last50=${win.padStart(4)}  status=${st}`;
}

function cmdList({ project = null } = {}) {
  const { rules } = eff().compute({ project });
  const status = eff().readLatestStatus();
  if (rules.length === 0) {
    process.stdout.write('No rules found in telemetry or rewriter source.\n');
    return 0;
  }
  process.stdout.write('rule-id              fires  success  ci_lower  last50  status\n');
  process.stdout.write('───────────────────  ─────  ───────  ────────  ──────  ──────────\n');
  for (const rule of rules) {
    process.stdout.write(_formatRow(rule, status.get(rule.rule_id)) + '\n');
  }
  return 0;
}

function cmdStatus(ruleId) {
  if (!ruleId) {
    process.stderr.write('error: status requires <rule_id>\n');
    return 2;
  }
  const { rules } = eff().compute();
  const rule = rules.find(r => r.rule_id === ruleId);
  const status = eff().readLatestStatus().get(ruleId);
  if (!rule && !status) {
    process.stderr.write(`error: rule '${ruleId}' not found\n`);
    return 1;
  }
  const out = {
    rule_id: ruleId,
    status: status?.status || 'active',
    status_reason: status?.status_reason || null,
    status_changed_at: status?.status_changed_at || null,
    scoring_epoch_start_ts: status?.scoring_epoch_start_ts || null,
    rule_content_hash: rule?.rule_content_hash || status?.rule_content_hash || null,
    score: rule
      ? {
          fires: rule.fires,
          unscorable: rule.unscorable,
          proceeded: rule.proceeded,
          recalled: rule.recalled,
          undone: rule.undone,
          rerouted: rule.rerouted,
          stopped: rule.stopped,
          success_rate: rule.success_rate,
          ci_lower: rule.ci_lower,
          last_50_window_rate: rule.last_50_window_rate,
        }
      : null,
    eligibility: rule ? eff().quarantineEligible(rule) : null,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  return 0;
}

function cmdCompute({ project = null } = {}) {
  const { rules } = eff().compute({ project });
  if (rules.length === 0) {
    process.stdout.write('No rules to score.\n');
    return 0;
  }
  const written = eff().snapshot(rules, { reason: 'cli:compute' });
  process.stdout.write(`Snapshotted ${written.length} rule(s).\n`);
  // Report any newly auto-flagged rules (status='flagged' after snapshot).
  const flagged = written.filter(e => e.status === 'flagged');
  if (flagged.length > 0) {
    process.stdout.write(`Auto-flagged for review:\n`);
    for (const f of flagged) {
      process.stdout.write(`  ${f.rule_id}: ${f.status_reason}\n`);
    }
    process.stdout.write(`Run 'vanta-rule-tune auto-quarantine --dry-run' to preview, then drop --dry-run to commit.\n`);
  }
  return 0;
}

function cmdQuarantine(ruleId, { reason = null } = {}) {
  if (!ruleId) {
    process.stderr.write('error: quarantine requires <rule_id>\n');
    return 2;
  }
  const entry = eff().setStatus(ruleId, 'quarantined', {
    reason: reason || 'manual:cli',
  });
  process.stdout.write(`Quarantined rule: ${ruleId}\n`);
  process.stdout.write(`  prior_status: ${entry.prior_status || 'active'}\n`);
  process.stdout.write(`  status_seq: ${entry.status_seq}\n`);
  process.stdout.write(`  rule_content_hash: ${entry.rule_content_hash || '(not extractable)'}\n`);
  if (!entry.rule_content_hash) {
    process.stderr.write(`  warning: no content hash recorded — auto-rehab on edit will not fire.\n`);
  }
  return 0;
}

function cmdRehabilitate(ruleId, { reason = null } = {}) {
  if (!ruleId) {
    process.stderr.write('error: rehabilitate requires <rule_id>\n');
    return 2;
  }
  const entry = eff().setStatus(ruleId, 'active', {
    reason: reason || 'manual:cli',
  });
  process.stdout.write(`Rehabilitated rule: ${ruleId}\n`);
  process.stdout.write(`  prior_status: ${entry.prior_status || '(none)'}\n`);
  process.stdout.write(`  status_seq: ${entry.status_seq}\n`);
  if (entry.scoring_epoch_start_ts) {
    process.stdout.write(`  scoring_epoch_start_ts: ${entry.scoring_epoch_start_ts}\n`);
    process.stdout.write(`  (fires before this ts are excluded from re-quarantine.)\n`);
  }
  return 0;
}

function cmdAutoQuarantine({ project = null, dryRun = false } = {}) {
  const { rules } = eff().compute({ project });
  const status = eff().readLatestStatus();
  const eligible = [];
  for (const rule of rules) {
    if (status.get(rule.rule_id)?.status === 'quarantined') continue;
    const elig = eff().quarantineEligible(rule);
    if (elig.eligible) eligible.push({ rule, reason: elig.reason });
  }
  if (eligible.length === 0) {
    process.stdout.write('No rules eligible for auto-quarantine.\n');
    return 0;
  }
  process.stdout.write(`${eligible.length} rule(s) eligible for quarantine:\n`);
  for (const { rule, reason } of eligible) {
    process.stdout.write(`  ${rule.rule_id}: ${reason}\n`);
  }
  if (dryRun) {
    process.stdout.write('\n(dry run — no changes written. Re-run without --dry-run to commit.)\n');
    return 0;
  }
  for (const { rule, reason } of eligible) {
    eff().setStatus(rule.rule_id, 'quarantined', {
      reason: `auto:${reason}`,
      contentHash: rule.rule_content_hash,
    });
  }
  process.stdout.write(`\nQuarantined ${eligible.length} rule(s).\n`);
  return 0;
}

// ─── CLI entry ───────────────────────────────────────────────────────

function _parseFlags(args) {
  const opts = {};
  const positional = [];
  // v3.10 commit 3 R1 council fix (Gemini P3): validate that flag values
  // aren't another flag. e.g. `--reason --dry-run` would have swallowed
  // --dry-run as the reason text and silently disabled the safety guard.
  const _takeValue = (i, flagName) => {
    const v = args[i];
    if (v == null || v.startsWith('--') || v === '-h') {
      throw new Error(`flag ${flagName} requires a value (got '${v ?? '(end)'}')`);
    }
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a === '--project') { opts.project = _takeValue(++i, '--project'); continue; }
    if (a === '--reason')  { opts.reason  = _takeValue(++i, '--reason');  continue; }
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    positional.push(a);
  }
  return { opts, positional };
}

function _printUsage() {
  process.stdout.write(`Usage: vanta-rule-tune <command> [args] [flags]

Commands:
  list                          List all rules with effectiveness scores
  status <rule_id>              Detailed status for one rule (JSON)
  compute                       Recompute scores from telemetry, snapshot
  quarantine <rule_id>          Manually quarantine a rule (skip in rewriter)
  rehabilitate <rule_id>        Flip back to active, open new scoring epoch
  auto-quarantine [--dry-run]   Quarantine every eligible rule

Flags:
  --project <slug>     Filter telemetry to a specific project
  --reason <text>      Audit reason for quarantine/rehabilitate (recorded)
  --dry-run            Print plan without committing changes
  -h, --help           Show this message
`);
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0) { _printUsage(); return 0; }
  const { opts, positional } = _parseFlags(args);
  if (opts.help) { _printUsage(); return 0; }
  const cmd = positional[0];
  const arg1 = positional[1];
  switch (cmd) {
    case 'list':            return cmdList({ project: opts.project });
    case 'status':          return cmdStatus(arg1);
    case 'compute':         return cmdCompute({ project: opts.project });
    case 'quarantine':      return cmdQuarantine(arg1, { reason: opts.reason });
    case 'rehabilitate':    return cmdRehabilitate(arg1, { reason: opts.reason });
    case 'auto-quarantine': return cmdAutoQuarantine({ project: opts.project, dryRun: !!opts.dryRun });
    default:
      process.stderr.write(`error: unknown command '${cmd}'\n\n`);
      _printUsage();
      return 2;
  }
}

if (require.main === module) {
  try {
    process.exit(main(process.argv));
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  cmdList,
  cmdStatus,
  cmdCompute,
  cmdQuarantine,
  cmdRehabilitate,
  cmdAutoQuarantine,
  main,
};
