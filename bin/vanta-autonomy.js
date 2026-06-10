#!/usr/bin/env node
// vanta-autonomy — per-project autonomy level (L0-L3, earned).
//
// Levels:
//   L0  Observe-only        — never auto-execute. Default for non-code dirs.
//   L1  Suggest + ask       — rewriter shadow + tier recommendations only.
//   L2  Auto safe actions   — T0/T1 auto-execute; T2/T3 still ask.
//   L3  Full executor        — auto T0-T2; T3 still asks (product authority).
//
// Promotion is EARNED, not assigned:
//   L0 → L1: user runs `vanta-autonomy upgrade` (manual opt-in once project
//            type is verified as code-bearing)
//   L1 → L2: 7d at L1 with regret_rate < 2% AND undo_rate < 2%
//   L2 → L3: 14d at L2 with same thresholds
//   Any regret/undo spike → auto-demote one level immediately
//   User can override anytime; override locks for 7d
//
// Project-context auto-detect: cwd with NO .git/package.json/pyproject.toml/
// go.mod/Cargo.toml/etc → default L0 (CV folders, doc projects, etc).
// Otherwise default L1.

const fs = require('fs');
const path = require('path');
const os = require('os');

const al = require('./vanta-action-log');

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

const VALID_LEVELS = ['L0', 'L1', 'L2', 'L3'];
const PROMOTE_RULES = {
  // [from, to]: { min_days, max_undo_rate, max_regret_rate }
  'L1->L2': { min_days: 7,  max_undo_rate: 0.02, max_regret_rate: 0.02 },
  'L2->L3': { min_days: 14, max_undo_rate: 0.02, max_regret_rate: 0.02 },
};
const DEMOTION_TRIGGERS = {
  // Any of these spikes triggers immediate demote-one-level.
  undo_rate_spike: 0.05,    // >5% in last 24h
  regret_rate_spike: 0.05,  // >5% in last 7d
};
const OVERRIDE_LOCK_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days

// ─── Repo detection ──────────────────────────────────────────────────────────

function _repoRoot(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const CODE_PROJECT_MARKERS = [
  'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'composer.json',
  'Gemfile', 'pom.xml', 'build.gradle', 'requirements.txt', 'tsconfig.json',
  'deno.json', 'pubspec.yaml',
];

function detectProjectKind(cwd) {
  const root = _repoRoot(cwd);
  if (!root) return { kind: 'non-repo', root: null };
  for (const m of CODE_PROJECT_MARKERS) {
    if (fs.existsSync(path.join(root, m))) {
      return { kind: 'code', root, marker: m };
    }
  }
  // Could still be a code repo with no manifest (rare). Look for any
  // source-shaped files at depth 2.
  const hasSourceFiles = (() => {
    try {
      const entries = fs.readdirSync(root);
      for (const e of entries) {
        if (/\.(ts|js|py|go|rs|java|rb|php)$/.test(e)) return true;
      }
      // Check src/ if exists
      const srcDir = path.join(root, 'src');
      if (fs.existsSync(srcDir)) {
        const sub = fs.readdirSync(srcDir);
        for (const e of sub) {
          if (/\.(ts|js|py|go|rs|java|rb|php)$/.test(e)) return true;
        }
      }
    } catch {}
    return false;
  })();
  return {
    kind: hasSourceFiles ? 'code' : 'doc',
    root,
    marker: hasSourceFiles ? 'source-files' : 'no-marker',
  };
}

// ─── Config read/write ───────────────────────────────────────────────────────

function _configPath(repoRoot) { return path.join(repoRoot, '.vanta', 'config.yaml'); }

function _parseConfig(src) {
  // Minimal: only `level: <Lx>` and `override_until: <iso-ts>` are read.
  const out = { level: null, override_until: null, history: [] };
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let m = line.match(/^level:\s*(L[0-3])\s*$/);
    if (m) { out.level = m[1]; continue; }
    m = line.match(/^override_until:\s*(\S+)/);
    if (m) { out.override_until = m[1]; continue; }
  }
  return out;
}

function readConfig(cwd) {
  const root = _repoRoot(cwd);
  if (!root) return { level: null, root: null };
  const cfg = _configPath(root);
  if (!fs.existsSync(cfg)) return { level: null, root, override_until: null };
  try {
    const parsed = _parseConfig(fs.readFileSync(cfg, 'utf8'));
    return { ...parsed, root };
  } catch (err) {
    vlog().error('autonomy.read', err.message);
    return { level: null, root };
  }
}

function writeConfig(repoRoot, { level, override_until }) {
  if (!VALID_LEVELS.includes(level)) throw new Error(`invalid level: ${level}`);
  const dir = path.join(repoRoot, '.vanta');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    `# Vanta autonomy config — managed by bin/vanta-autonomy.js`,
    `# Manual edits are honored; auto-promote / auto-demote will respect`,
    `# the override_until lock.`,
    `level: ${level}`,
  ];
  if (override_until) lines.push(`override_until: ${override_until}`);
  fs.writeFileSync(_configPath(repoRoot), lines.join('\n') + '\n');
}

// ─── Effective level (with detection + locks) ────────────────────────────────

function effectiveLevel(cwd) {
  const detected = detectProjectKind(cwd);
  const configured = readConfig(cwd);
  // Non-repo or doc project → always L0.
  if (detected.kind !== 'code') {
    return {
      level: 'L0',
      reason: `project-kind=${detected.kind}; non-code dirs default to L0`,
      detected,
      configured,
      locked: false,
    };
  }
  // Repo with explicit config → use it.
  if (configured.level) {
    let locked = false;
    if (configured.override_until) {
      const until = Date.parse(configured.override_until);
      if (Number.isFinite(until) && until > Date.now()) locked = true;
    }
    return { level: configured.level, reason: 'explicit config', detected, configured, locked };
  }
  // Code repo with no config → default L1.
  return {
    level: 'L1',
    reason: 'code repo, no config — default L1',
    detected,
    configured,
    locked: false,
  };
}

// ─── Auto-promote / auto-demote ──────────────────────────────────────────────

function _trustOverWindow({ days }) {
  let tm;
  try { tm = require('./vanta-trust-metrics'); } catch { return null; }
  return tm.compute({ days });
}

function _regretOverWindow({ days }) {
  let rd;
  try { rd = require('./vanta-regret-detector'); } catch { return null; }
  try { return rd.regretRate({ days }); } catch { return null; }
}

// Returns { promote_to, why } or null if no promotion.
function _checkPromotion(currentLevel) {
  if (currentLevel === 'L3') return null;  // already top
  if (currentLevel === 'L0') return null;  // L0→L1 is manual only
  const transition = `${currentLevel}->L${parseInt(currentLevel.slice(1), 10) + 1}`;
  const rule = PROMOTE_RULES[transition];
  if (!rule) return null;
  const tm = _trustOverWindow({ days: rule.min_days });
  const rd = _regretOverWindow({ days: rule.min_days });
  if (!tm || tm.spanDays < rule.min_days) return null;
  if (tm.undo_within_2m.rate >= rule.max_undo_rate) return null;
  if (rd && rd.rate >= rule.max_regret_rate) return null;
  return {
    promote_to: transition.split('->')[1],
    why: `${transition}: ${tm.spanDays}d span, undo=${(tm.undo_within_2m.rate * 100).toFixed(1)}%, regret=${rd ? (rd.rate * 100).toFixed(1) : '?'}%`,
  };
}

// Demotion cooldown — once a project demotes, the same 7d regret window
// will continue to read above-threshold for up to 7 days. Without a
// cooldown the demotion would cascade L3 → L2 → L1 → L0 in rapid
// succession on every tick (R1 P2 — Gemini).
const DEMOTION_COOLDOWN_MS = 24 * 60 * 60 * 1000;  // 24h between demotions

// Returns the timestamp of the most recent autonomy-demote action for
// this repo (or 0 if none). Used to enforce DEMOTION_COOLDOWN_MS.
function _lastDemoteMs(repoRoot) {
  const entries = al.read({ action: 'autonomy-demote' });
  let last = 0;
  for (const e of entries) {
    if (e.subject !== repoRoot) continue;
    const ms = Date.parse(e.ts);
    if (ms > last) last = ms;
  }
  return last;
}

// Returns { demote_to, why } or null. Always demotes by exactly one level.
function _checkDemotion(currentLevel, repoRoot) {
  if (currentLevel === 'L0') return null;  // floor
  // Cooldown: refuse to demote again within DEMOTION_COOLDOWN_MS of the
  // most recent demote. The 7d regret window decays naturally; rapid
  // re-demotion on the same incident is what we're guarding against.
  if (repoRoot) {
    const lastMs = _lastDemoteMs(repoRoot);
    if (lastMs && Date.now() - lastMs < DEMOTION_COOLDOWN_MS) {
      return null;
    }
  }
  // Read recent (24h) undo rate + 7d regret rate.
  const tm24 = _trustOverWindow({ days: 1 });
  const rd7  = _regretOverWindow({ days: 7 });
  const triggers = [];
  if (tm24 && tm24.undo_within_2m.rate > DEMOTION_TRIGGERS.undo_rate_spike) {
    triggers.push(`undo_24h=${(tm24.undo_within_2m.rate * 100).toFixed(1)}%`);
  }
  if (rd7 && rd7.rate > DEMOTION_TRIGGERS.regret_rate_spike) {
    triggers.push(`regret_7d=${(rd7.rate * 100).toFixed(1)}%`);
  }
  if (triggers.length === 0) return null;
  const idx = parseInt(currentLevel.slice(1), 10);
  return {
    demote_to: `L${idx - 1}`,
    why: `spike: ${triggers.join(', ')}`,
  };
}

// Manual upgrade — opt-in step from L0 → L1 (the only manual path).
function manualUpgrade(cwd) {
  const eff = effectiveLevel(cwd);
  if (!eff.detected.root) throw new Error('not in a git repo');
  if (eff.locked) throw new Error('autonomy is locked by override_until — manual upgrade not allowed');
  const cur = eff.level;
  if (cur === 'L3') return { level: 'L3', changed: false };
  // P1 gate: manualUpgrade is opt-in L0→L1 ONLY. L1→L2 and above require
  // sustained trust-metrics thresholds via autonomy-promote (tick()). This
  // matches the documented intent ("the only manual path") and prevents
  // a single call from jumping multiple trust levels.
  if (cur !== 'L0') throw new Error(`manualUpgrade only allows L0→L1 — current level is ${cur}; higher levels require trust-metrics promotion`);
  const next = `L${parseInt(cur.slice(1), 10) + 1}`;
  writeConfig(eff.detected.root, { level: next });
  al.record({
    project: path.basename(eff.detected.root),
    action: 'autonomy-promote',
    decision: 'auto',
    why: `manual upgrade ${cur} -> ${next}`,
    subject: eff.detected.root,
    undo_hint: { kind: 'autonomy-promote', payload: {
      repo: eff.detected.root, prior_level: cur, new_level: next,
    } },
  });
  return { level: next, changed: true, prior: cur };
}

// Tick-once: check promote + demote, apply at most one transition.
function tick(cwd) {
  const eff = effectiveLevel(cwd);
  if (!eff.detected.root) return { level: eff.level, changed: false, reason: 'not-in-repo' };
  if (eff.detected.kind !== 'code') return { level: eff.level, changed: false, reason: 'non-code' };
  if (eff.locked) return { level: eff.level, changed: false, reason: 'override-locked' };

  // Demotion has priority over promotion (safety bias).
  const demote = _checkDemotion(eff.level, eff.detected.root);
  if (demote) {
    writeConfig(eff.detected.root, { level: demote.demote_to });
    al.record({
      project: path.basename(eff.detected.root),
      action: 'autonomy-demote',
      decision: 'auto',
      why: demote.why,
      subject: eff.detected.root,
      undo_hint: { kind: 'autonomy-promote', payload: {
        repo: eff.detected.root, prior_level: eff.level, new_level: demote.demote_to,
      } },
    });
    return { level: demote.demote_to, changed: true, prior: eff.level, kind: 'demote', reason: demote.why };
  }

  const promote = _checkPromotion(eff.level);
  if (promote) {
    // Don't auto-promote — surface a SUGGESTION instead. Earned promotion
    // requires explicit user assent (records + manual upgrade or skill flow).
    return {
      level: eff.level, changed: false, kind: 'suggest-promote',
      suggested_level: promote.promote_to, reason: promote.why,
    };
  }

  return { level: eff.level, changed: false, reason: 'stable' };
}

module.exports = {
  effectiveLevel, readConfig, writeConfig, detectProjectKind,
  manualUpgrade, tick,
};

// CLI:
//   vanta-autonomy [status]  - print effective level + reason
//   vanta-autonomy upgrade   - L0->L1 or L1->L2 (manual opt-in)
//   vanta-autonomy tick      - run promote/demote check
//   vanta-autonomy set L1    - explicit override (locks for 7d)
if (require.main === module) {
  const cmd = process.argv[2] || 'status';
  const cwd = process.cwd();
  switch (cmd) {
    case 'status': {
      process.stdout.write(JSON.stringify(effectiveLevel(cwd), null, 2) + '\n');
      break;
    }
    case 'upgrade': {
      try {
        const r = manualUpgrade(cwd);
        process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      } catch (err) {
        process.stderr.write('upgrade failed: ' + err.message + '\n');
        process.exit(1);
      }
      break;
    }
    case 'tick': {
      const r = tick(cwd);
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      break;
    }
    case 'set': {
      const lvl = process.argv[3];
      if (!VALID_LEVELS.includes(lvl)) {
        process.stderr.write(`invalid level: ${lvl}\n`);
        process.exit(2);
      }
      const root = _repoRoot(cwd);
      if (!root) { process.stderr.write('not in repo\n'); process.exit(2); }
      const until = new Date(Date.now() + OVERRIDE_LOCK_MS).toISOString();
      writeConfig(root, { level: lvl, override_until: until });
      process.stdout.write(`set ${lvl} (locked until ${until})\n`);
      break;
    }
    default:
      process.stderr.write('usage: vanta-autonomy [status|upgrade|tick|set Lx]\n');
      process.exit(2);
  }
}
