#!/usr/bin/env node
// vanta-memory-promote — surface staged invariants ONE AT A TIME.
//
// The auto-sync extractor writes candidate invariants to:
//   ~/.claude/rules/vinamr-invariants.staging.md
//
// Manual review never happens because the file accumulates and bulk
// review is overwhelming. Solution:
//   - Daily: surface ONE highest-confidence candidate (≥0.85 score)
//   - Weekly (Friday): full digest if user asks
//
// CLI:
//   vanta-memory-promote next      - print 1 candidate (highest conf)
//   vanta-memory-promote digest    - print all candidates
//   vanta-memory-promote accept ID - move to global invariants file
//   vanta-memory-promote reject ID - drop + add to reject-list
//
// Acceptance: appends the candidate text under the appropriate section
// of ~/.claude/rules/vinamr-invariants.md and removes it from staging.
// Records as action='memory-promote' with prior_text for vanta-undo.
//
// Rejection: removes from staging and records the candidate's
// fingerprint in ~/.vanta/memory-rejects.jsonl. Future runs will skip
// candidates that match a previously-rejected fingerprint (dedup +
// don't-show-again).

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const al = require('./vanta-action-log');
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

function _stagingPath() {
  return process.env.VANTA_STAGING_FILE
    || path.join(os.homedir(), '.claude', 'rules', 'vinamr-invariants.staging.md');
}

function _globalPath() {
  return process.env.VANTA_INVARIANTS_FILE
    || path.join(os.homedir(), '.claude', 'rules', 'vinamr-invariants.md');
}

function _rejectsPath() {
  return path.join(process.env.VANTA_DIR_OVERRIDE || path.join(os.homedir(), '.vanta'),
    'memory-rejects.jsonl');
}

// ─── Parse staged candidates ─────────────────────────────────────────────────
//
// Staging format (set by vanta-extract-score writer):
//   ## <Section Name>
//
//   - <bullet text>  <!-- conf=0.78 ts=2026-04-30T... -->
//   - <bullet text>  <!-- conf=0.92 ts=2026-04-29T... -->
//
// Candidates are individual bullets with conf= metadata. We parse
// section + bullet + conf and emit a unique fingerprint per candidate.

function _fingerprint(text) {
  return 'inv-' + crypto.createHash('sha256').update(text.trim()).digest('hex').slice(0, 12);
}

function loadStaged() {
  const file = _stagingPath();
  if (!fs.existsSync(file)) return [];
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  let section = null;
  for (const raw of src.split('\n')) {
    const sectionMatch = raw.match(/^##\s+(.+)$/);
    if (sectionMatch) { section = sectionMatch[1].trim(); continue; }
    const bulletMatch = raw.match(/^[-*]\s+(.+?)(?:\s*<!--\s*(.+?)\s*-->)?$/);
    if (!bulletMatch) continue;
    const text = bulletMatch[1].trim();
    if (!text) continue;
    const meta = bulletMatch[2] || '';
    const confMatch = meta.match(/conf\s*=\s*([\d.]+)/);
    const tsMatch = meta.match(/ts\s*=\s*(\S+)/);
    out.push({
      id: _fingerprint(text),
      section: section || 'Uncategorized',
      text,
      confidence: confMatch ? parseFloat(confMatch[1]) : 0.5,
      ts: tsMatch ? tsMatch[1] : null,
    });
  }
  return out;
}

function loadRejects() {
  const file = _rejectsPath();
  if (!fs.existsSync(file)) {
    // Also check rotated baks via merged read.
    const merged = readMergedJsonl(file);
    if (!merged) return new Set();
    const rejects = new Set();
    for (const line of merged.split('\n')) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e.id) rejects.add(e.id); } catch {}
    }
    return rejects;
  }
  const merged = readMergedJsonl(file);
  const rejects = new Set();
  for (const line of merged.split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e.id) rejects.add(e.id); } catch {}
  }
  return rejects;
}

// ─── Surface candidates ──────────────────────────────────────────────────────

function nextCandidate({ minConfidence = 0.85 } = {}) {
  const candidates = loadStaged();
  const rejects = loadRejects();
  const eligible = candidates
    .filter(c => !rejects.has(c.id))
    .filter(c => c.confidence >= minConfidence)
    .sort((a, b) => b.confidence - a.confidence);
  return eligible[0] || null;
}

function digest() {
  const candidates = loadStaged();
  const rejects = loadRejects();
  return candidates.filter(c => !rejects.has(c.id))
    .sort((a, b) => b.confidence - a.confidence);
}

// ─── Accept ─────────────────────────────────────────────────────────────────

function accept(id) {
  const candidates = loadStaged();
  const target = candidates.find(c => c.id === id);
  if (!target) return { ok: false, reason: 'no candidate with that id in staging' };

  // Read global file. Find the matching section. If absent, append.
  const globalFile = _globalPath();
  let global = '';
  try { global = fs.readFileSync(globalFile, 'utf8'); } catch { global = ''; }

  // Insert under the matching `## <Section>` header. If section
  // doesn't exist, append a new section at end.
  const sectionRx = new RegExp(`^##\\s+${target.section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const newBullet = `- ${target.text}`;
  let updated;
  if (sectionRx.test(global)) {
    updated = global.replace(sectionRx, m => m + '\n\n' + newBullet);
  } else {
    if (global && !global.endsWith('\n')) global += '\n';
    updated = global + `\n## ${target.section}\n\n${newBullet}\n`;
  }
  try { fs.writeFileSync(globalFile, updated); } catch (err) {
    return { ok: false, reason: `write global failed: ${err.message}` };
  }

  // Remove from staging.
  const stagingFile = _stagingPath();
  try {
    const stagingSrc = fs.readFileSync(stagingFile, 'utf8');
    const escapedText = target.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const removeRx = new RegExp(`^[-*]\\s+${escapedText}.*\\n?`, 'm');
    fs.writeFileSync(stagingFile, stagingSrc.replace(removeRx, ''));
  } catch (err) {
    vlog().warn('memory-promote.staging-remove', err.message);
  }

  // Record into action-log with undo hint (prior_text = full original line).
  al.record({
    action: 'memory-promote',
    decision: 'auto',
    why: `accepted staged invariant id=${id}`,
    subject: target.text.slice(0, 80),
    undo_hint: { kind: 'memory-promote', payload: { entry_id: id, prior_text: target.text } },
  });
  return { ok: true, id, section: target.section, target };
}

// ─── Reject ──────────────────────────────────────────────────────────────────

function reject(id) {
  const candidates = loadStaged();
  const target = candidates.find(c => c.id === id);
  if (!target) return { ok: false, reason: 'no candidate with that id in staging' };

  // Append to rejects log so we don't show it again.
  const file = _rejectsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  appendJsonlLine(file, { id, text: target.text, ts: new Date().toISOString() });

  // Remove from staging.
  try {
    const stagingFile = _stagingPath();
    const stagingSrc = fs.readFileSync(stagingFile, 'utf8');
    const escapedText = target.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const removeRx = new RegExp(`^[-*]\\s+${escapedText}.*\\n?`, 'm');
    fs.writeFileSync(stagingFile, stagingSrc.replace(removeRx, ''));
  } catch {}

  al.record({
    action: 'memory-reject',
    decision: 'auto',
    why: `rejected staged invariant id=${id}`,
    subject: target.text.slice(0, 80),
  });
  return { ok: true, id, target };
}

module.exports = { nextCandidate, digest, accept, reject, loadStaged, loadRejects };

// CLI
if (require.main === module) {
  const cmd = process.argv[2] || 'next';
  switch (cmd) {
    case 'next': {
      const c = nextCandidate({});
      if (!c) {
        process.stdout.write('no high-confidence staged invariants pending\n');
        process.exit(0);
      }
      process.stdout.write(`[${c.id}] (conf=${c.confidence}) section=${c.section}\n  ${c.text}\n`);
      break;
    }
    case 'digest': {
      const all = digest();
      if (all.length === 0) { process.stdout.write('no staged invariants\n'); break; }
      for (const c of all) {
        process.stdout.write(`[${c.id}] conf=${c.confidence} ${c.section}\n  ${c.text}\n`);
      }
      break;
    }
    case 'accept': {
      const id = process.argv[3];
      if (!id) { process.stderr.write('usage: vanta-memory-promote accept <id>\n'); process.exit(2); }
      const r = accept(id);
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      process.exit(r.ok ? 0 : 1);
    }
    case 'reject': {
      const id = process.argv[3];
      if (!id) { process.stderr.write('usage: vanta-memory-promote reject <id>\n'); process.exit(2); }
      const r = reject(id);
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      process.exit(r.ok ? 0 : 1);
    }
    default:
      process.stderr.write('usage: vanta-memory-promote <next|digest|accept ID|reject ID>\n');
      process.exit(2);
  }
}
