#!/usr/bin/env node
// vanta-prune — archive dormant project shards.
//
// Cleanup #9: shards accumulate forever. Once a project goes dormant (no
// indexer writes for >30 days) it still loads on every status check and
// every resolver scan that walks the shard dir. Worse: stale shards point
// to projectRoot paths that may no longer exist on disk.
//
// vanta-prune moves dormant shards to ~/.vanta/knowledge/.archive/ instead
// of deleting them. Reversible — `vanta-prune --restore <slug>` brings them
// back. Default dormancy threshold: 30 days since the .jsonl mtime.
//
// SAFETY: this only writes (rename); never reads inside shards. If a shard
// is locked, we skip it. If the projectRoot in the cursor still exists on
// disk AND has been touched recently, we treat that as "active" even if the
// shard mtime is old — the project is alive but quiet.
//
// Modes:
//   (no flags)     dry-run — list candidates, print what would happen
//   --apply        actually move dormant shards to .archive/
//   --restore SLUG move .archive/<slug>.* back into knowledge/
//   --threshold N  override default dormancy in days (default: 30)
//   --slug SLUG    target a specific shard (paired with --apply or --restore)
//   --json         machine-readable output

const fs = require('fs');
const path = require('path');
const os = require('os');

const KNOWLEDGE_DIR = path.join(os.homedir(), '.vanta', 'knowledge');
const ARCHIVE_DIR = path.join(KNOWLEDGE_DIR, '.archive');

const args = process.argv.slice(2);
const FLAG_APPLY   = args.includes('--apply');
const FLAG_JSON    = args.includes('--json');
const restoreIdx   = args.indexOf('--restore');
const FLAG_RESTORE = restoreIdx !== -1 ? args[restoreIdx + 1] : null;
const slugIdx      = args.indexOf('--slug');
const ONLY_SLUG    = slugIdx !== -1 ? args[slugIdx + 1] : null;
const thrIdx       = args.indexOf('--threshold');
const THRESHOLD_DAYS = thrIdx !== -1 ? parseInt(args[thrIdx + 1], 10) : 30;
const THRESHOLD_MS = THRESHOLD_DAYS * 86400_000;

function safeStat(p) { try { return fs.statSync(p); } catch { return null; } }
function safeJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function ageDays(mtimeMs) {
  return Math.floor((Date.now() - mtimeMs) / 86400_000);
}

// Companion files for a slug. We move all of them as a unit so a partial
// archive can never leave a half-restored cursor pointing at a missing
// shard or vice versa.
function companions(slug) {
  return [`${slug}.jsonl`, `${slug}.cursor.json`, `${slug}.lock`];
}

// Determine if the project's source directory still exists and has been
// touched recently. We open the cursor's first projectRoot key (Tier 5
// stamps projectRoot on every entry; Tier 4 cursors do not — those fall
// through to mtime-only check).
function isProjectRootActive(slug) {
  const cursorPath = path.join(KNOWLEDGE_DIR, `${slug}.cursor.json`);
  const cur = safeJSON(cursorPath);
  if (!cur || !cur.files) return null;  // can't tell — fall back to mtime
  const firstFile = Object.keys(cur.files)[0];
  if (!firstFile) return null;
  // The cursor key is an absolute file path. Walk up to find the project root.
  // Heuristic: the project root is the deepest existing ancestor up to 6 levels.
  let dir = path.dirname(firstFile);
  for (let i = 0; i < 6; i++) {
    const st = safeStat(dir);
    if (st && st.isDirectory()) {
      // Active if any directory in the project tree has been touched recently.
      if ((Date.now() - st.mtimeMs) < THRESHOLD_MS) return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Source files exist but nothing has been touched recently → dormant
  return false;
}

function listCandidates() {
  if (!fs.existsSync(KNOWLEDGE_DIR)) return [];
  const out = [];
  let files;
  try { files = fs.readdirSync(KNOWLEDGE_DIR); } catch { return []; }
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const slug = f.slice(0, -'.jsonl'.length);
    if (ONLY_SLUG && slug !== ONLY_SLUG) continue;
    const jsonlPath = path.join(KNOWLEDGE_DIR, f);
    const lockPath = path.join(KNOWLEDGE_DIR, `${slug}.lock`);
    const st = safeStat(jsonlPath);
    if (!st) continue;
    const days = ageDays(st.mtimeMs);
    if (!ONLY_SLUG && days < THRESHOLD_DAYS) continue;  // not dormant by mtime
    const isLocked = fs.existsSync(lockPath);
    const rootActive = isProjectRootActive(slug);
    out.push({
      slug,
      ageDays: days,
      bytes: st.size,
      isLocked,
      rootActive,
      // Reason classification:
      //   skipped-lock   → currently being indexed; never archive
      //   skipped-active → projectRoot was touched recently; user is just away
      //   archive        → dormant by mtime AND project tree is also dormant
      reason: isLocked ? 'skipped-lock'
            : (rootActive === true ? 'skipped-active'
            : 'archive'),
    });
  }
  return out;
}

function moveSet(slug, fromDir, toDir) {
  if (!fs.existsSync(toDir)) fs.mkdirSync(toDir, { recursive: true });
  const moved = [];
  for (const c of companions(slug)) {
    const src = path.join(fromDir, c);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(toDir, c);
    fs.renameSync(src, dst);
    moved.push(c);
  }
  return moved;
}

function applyArchive(candidates) {
  const results = [];
  for (const c of candidates) {
    if (c.reason !== 'archive') continue;
    if (c.isLocked) continue;
    try {
      const moved = moveSet(c.slug, KNOWLEDGE_DIR, ARCHIVE_DIR);
      results.push({ slug: c.slug, archived: true, moved });
    } catch (err) {
      results.push({ slug: c.slug, archived: false, error: String(err.message || err) });
    }
  }
  return results;
}

function applyRestore(slug) {
  if (!fs.existsSync(ARCHIVE_DIR)) return { slug, restored: false, error: 'no archive dir' };
  const moved = [];
  for (const c of companions(slug)) {
    const src = path.join(ARCHIVE_DIR, c);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(KNOWLEDGE_DIR, c);
    if (fs.existsSync(dst)) {
      return { slug, restored: false, error: `${c} already exists in knowledge dir — manual merge required` };
    }
    fs.renameSync(src, dst);
    moved.push(c);
  }
  if (!moved.length) return { slug, restored: false, error: 'no archived files for this slug' };
  return { slug, restored: true, moved };
}

// ── render ─────────────────────────────────────────────────────────────────

function main() {
  // Restore mode is the simplest path
  if (FLAG_RESTORE) {
    const result = applyRestore(FLAG_RESTORE);
    if (FLAG_JSON) console.log(JSON.stringify(result, null, 2));
    else if (result.restored) console.log(`✓ restored ${FLAG_RESTORE}: ${result.moved.join(', ')}`);
    else console.log(`✗ restore failed: ${result.error}`);
    return;
  }

  const candidates = listCandidates();

  if (FLAG_APPLY) {
    const results = applyArchive(candidates);
    if (FLAG_JSON) {
      console.log(JSON.stringify({ candidates, results, threshold: THRESHOLD_DAYS }, null, 2));
      return;
    }
    if (!results.length) {
      console.log('Nothing to archive.');
      return;
    }
    for (const r of results) {
      if (r.archived) console.log(`✓ archived ${r.slug} (${r.moved.length} files)`);
      else            console.log(`✗ ${r.slug}: ${r.error}`);
    }
    console.log('');
    console.log(`Archived ${results.filter(r => r.archived).length}/${results.length} shard(s).`);
    console.log('Restore with: node vanta-prune.js --restore <slug>');
    return;
  }

  // Dry-run (default)
  if (FLAG_JSON) {
    console.log(JSON.stringify({ candidates, threshold: THRESHOLD_DAYS, applied: false }, null, 2));
    return;
  }

  console.log(`=== vanta-prune (dry-run, threshold ${THRESHOLD_DAYS}d) ===`);
  console.log('');
  if (!candidates.length) {
    console.log(`No dormant shards found (none idle ≥${THRESHOLD_DAYS}d).`);
    return;
  }
  const archive = candidates.filter(c => c.reason === 'archive');
  const skipped = candidates.filter(c => c.reason !== 'archive');

  if (archive.length) {
    console.log('WOULD ARCHIVE:');
    for (const c of archive) {
      console.log(`  ${c.slug}  (idle ${c.ageDays}d, project tree also dormant)`);
    }
    console.log('');
  }

  if (skipped.length) {
    console.log('WOULD SKIP:');
    for (const c of skipped) {
      const why = c.reason === 'skipped-lock' ? 'currently locked'
                : c.reason === 'skipped-active' ? 'shard old but project tree was touched recently'
                : c.reason;
      console.log(`  ${c.slug}  (idle ${c.ageDays}d) — ${why}`);
    }
    console.log('');
  }

  console.log(`Apply with: node vanta-prune.js --apply${ONLY_SLUG ? ' --slug ' + ONLY_SLUG : ''}`);
  console.log(`Restore later: node vanta-prune.js --restore <slug>`);
}

if (require.main === module) main();
