// vanta-projects — shared project keyword + slug canonicalization.
//
// Tier 4: extracted from vanta-index-code.js + vanta-resolve.js to eliminate
// PROJECT_KEYWORDS duplication. Both councils flagged the duplication as
// silent sync-drift surface — a project added to one file but not the other
// would either silently leak (resolver added) or land in an unknown bucket
// (indexer added). One source of truth.
//
// Used by: bin/vanta-index-code.js, bin/vanta-resolve.js, hooks/council-advisory.js
// require('./vanta-projects') from siblings; require('../bin/vanta-projects')
// from hooks/.

const PROJECT_KEYWORDS = {
  'little-wins':       [/\blittle[\s-]?wins?\b/i, /\bMitthu\b/i, /\bPOCSO\b/i, /\bSDQ\b/i, /\bIndian norms\b/i, /\btwo[- ]signal\b/i, /\bDPDP\b/i, /\bbajajvinamr-little-wins\b/],
  'pi-perception':     [/\bpi[- ]?perception\b/i, /\b12[- ]dim\b/i, /\bperception intelligence\b/i, /\bbajajvinamr-pi-perception\b/],
  'sales-agent-publisher': [/\bsales[- ]agent[- ]publisher\b/i, /\bsalestracker\b/i],
  'founderos':         [/\bfounder ?os\b/i, /\bpaperclip\b/i],
  'priyaa-audit':      [/\bpriyaa\b/i],
  'vanta':             [/\bvanta[- ]run\b/i, /\bvanta[- ]council\b/i, /\bvanta[- ]sync\b/i, /\bvanta-resolve\b/, /\bvanta-brief\b/, /\bvanta-index\b/, /\bcouncil[- ]advisory\b/, /\bplan[- ]watcher\b/, /\bbajajvinamr-vanta\b/],
};

// Sentinel for content that is project-agnostic (e.g. global invariants).
// Distinct from "unknown" — global is "applies everywhere"; unknown is
// "we don't know which project this belongs to".
const GLOBAL_PROJECT = '__global__';

// Canonical slug. Handles bare repo names ("little-wins"), gstack slugs
// ("bajajvinamr-little-wins"), and suffixed memory slugs ("little-wins-stack")
// via PROJECT_KEYWORDS lookup first, then user-prefix stripping fallback.
function canonProject(slug) {
  if (!slug) return null;
  const lower = String(slug).toLowerCase();
  for (const [proj, regexes] of Object.entries(PROJECT_KEYWORDS)) {
    if (regexes.some(re => re.test(lower))) return proj;
  }
  const m = lower.match(/^([a-z0-9]+)-(.+)$/);
  if (m && m[2].includes('-')) return m[2];
  return lower;
}

// True if the slug matches a known project keyword. Used to distinguish
// "well-known" (LW, pi-perception, …) from "raw inferred slug" — the latter
// gets its own shard but is treated as foreign by the resolver in
// cross-project context.
function isKnownProject(slug) {
  if (!slug) return false;
  return Object.prototype.hasOwnProperty.call(PROJECT_KEYWORDS, canonProject(slug));
}

// Detect a project tag from arbitrary text. Returns first matching slug or
// GLOBAL_PROJECT if nothing matched. Used to project-tag invariants and
// memory entries whose origin is text, not a directory.
function detectProject(text) {
  if (!text) return GLOBAL_PROJECT;
  for (const [slug, regexes] of Object.entries(PROJECT_KEYWORDS)) {
    if (regexes.some(re => re.test(text))) return slug;
  }
  return GLOBAL_PROJECT;
}

// Sanitize a slug for filesystem use as a shard filename. Returns just the
// safe basename (no extension, no path separators).
function slugForFilesystem(slug) {
  return String(slug || 'unknown').replace(/[^a-z0-9_.-]/gi, '_');
}

// Curated per-project SENSITIVE_PATTERNS. Lives here (not in the indexer)
// so adding a new project edits ONE file: PROJECT_KEYWORDS + this table
// together. Codex Tier 5 R1 finding — was previously in vanta-index-code.js
// which re-introduced sync drift between the two.
//
// Each entry: { cat: <category>, re: <regex with /g or /gi>, why: <rationale> }.
// These merge with BASELINE_PATTERNS (in indexer) and any user-defined
// `## Sensitive Patterns` section in the project's CLAUDE.md.
const PROJECT_SPECIFIC_PATTERNS = {
  'little-wins': [
    { cat: 'child-safety',  re: /\b(POCSO|COPPA|safeguard(?:ing)?|child[- ]safe|mandatory[- ]report|incident[- ]rout)/gi, why: 'Child-safety boundary — POCSO §19/§21 reporting, mandatory incident routing.' },
    { cat: 'output-filter', re: /\b(filterOutput|outputFilter|output[- ]filter|filter[- ]veto|llm[- ]safe(?:ty)?|output[- ]gate)\b/gi, why: 'LLM output filter — final veto gate. Regression here = unfiltered LLM reaches child.' },
    { cat: 'consent',       re: /\b(DPDP|parental[- ]consent|guardian[- ]consent|child[- ]pii|EU[- ]region|india[- ]region)\b/gi, why: 'DPDP Rules 2025 — child PII region restriction, parental consent flow.' },
    { cat: 'pii-lw',        re: /\b(child_name|parent_phone|school_name|dob)\b/gi, why: 'LW-specific PII — region-locked, never logged, encrypted at rest.' },
    { cat: 'two-signal',    re: /\btwo[- ]signal\b|\bpaired[- ]sensors?\b|\bcorrobor(?:ate|ation)\b/gi, why: 'Two-signal rule — clinical claim requires ≥2 independent paradigms agreeing.' },
    { cat: 'norms-gate',    re: /\b(indian[- ]norms?|cbse[- ]norms?|norms[- ]gate|age[- ]band|band[- ]baseline|isParadigmEnabled)\b/gi, why: 'Norms gate — age-band enablement, single source of truth for paradigm dispatch.' },
  ],
  'pi-perception': [
    { cat: '12-dim',        re: /\b(12[- ]dim|twelve[- ]dim|perception[- ]intelligence|pi[- ]score)\b/gi, why: '12-dim perception scoring — calibration is load-bearing.' },
  ],
  // Add new projects here. Keep regex /gi unless case-sensitivity is meaningful.
};

// Returns the curated patterns for a slug, or [] if none.
function projectPatternsFor(slug) {
  return PROJECT_SPECIFIC_PATTERNS[canonProject(slug)] || [];
}

// Codex council R7 P2 fix — centralize slug computation.
//
// Earlier callers used `path.basename(cwd)` directly, which collapsed two
// projects with the same basename ("/Users/x/work/api" and
// "/Users/x/personal/api") into the same slug. That mixed their decisions,
// gotchas, episodes, and code-knowledge.
//
// Strategy:
//   1. Resolve symlinks via fs.realpathSync — symlinked worktrees no longer
//      slug to the symlink's basename.
//   2. Try `git config --get remote.origin.url` to derive an org-repo slug.
//      Globally unique when present.
//   3. Try `git rev-parse --show-toplevel` for the repo root and use its
//      basename — better than cwd basename for subdirs.
//   4. Try canonical-keyword matching for known projects.
//   5. Last resort: basename. Returns null when basename is ambiguous
//      (cwd is $HOME, /, /tmp, etc.) so callers disable project-scoped
//      reads/writes rather than collide with a neighbor.
const _fs = require('fs');
const _path = require('path');
const _child = require('child_process');

const AMBIGUOUS_BASENAMES = new Set([
  '', '/', 'tmp', 'var', 'home', 'usr', 'root', 'desktop', 'documents',
  'downloads', 'projects', 'src', 'code', 'repo', 'repos', 'work',
]);

// Known-meaningful workspace paths that a bare basename can't identify.
// ~/Projects is the Vinamr OS central layer (CoS sessions run there) — its
// basename "projects" is in AMBIGUOUS_BASENAMES, so without this alias every
// CoS session logged slug '' and project-scoped trust fragmented (114 empty
// slugs in the 07-17 sync-queue audit).
const _os = require('os');
const WORKSPACE_ALIASES = {
  [_path.join(_os.homedir(), 'Projects')]: 'vinamr-os',
};

function slugFromCwd(cwd) {
  if (!cwd) return null;
  let real = cwd;
  try { real = _fs.realpathSync(cwd); } catch { /* not a real path; use as-is */ }

  try {
    const remote = _child.execFileSync('git',
      ['-C', real, 'config', '--get', 'remote.origin.url'],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000, shell: false },
    ).toString().trim();
    const m = remote.match(/[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (m) return `${m[1]}-${m[2]}`;
  } catch { /* no git, no remote, or timeout */ }

  let repoRoot = null;
  try {
    repoRoot = _child.execFileSync('git',
      ['-C', real, 'rev-parse', '--show-toplevel'],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000, shell: false },
    ).toString().trim();
  } catch { /* not a git repo */ }
  const target = repoRoot || real;
  if (WORKSPACE_ALIASES[target]) return WORKSPACE_ALIASES[target];
  // $HOME's basename is the username ("vinamr"), which the name-set can't
  // catch — 30 sessions fragmented onto that slug before this guard.
  if (target === _os.homedir()) return null;
  const base = _path.basename(target).toLowerCase();

  if (AMBIGUOUS_BASENAMES.has(base)) return null;

  const canon = canonProject(base);
  if (canon) return canon;

  return base;
}

module.exports = {
  PROJECT_KEYWORDS,
  PROJECT_SPECIFIC_PATTERNS,
  GLOBAL_PROJECT,
  canonProject,
  isKnownProject,
  detectProject,
  slugForFilesystem,
  slugFromCwd,
  projectPatternsFor,
};
