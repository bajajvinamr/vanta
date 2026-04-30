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
  'vanta':             [/\bvanta[- ]run\b/i, /\bvanta[- ]council\b/i, /\bvanta[- ]sync\b/i, /\bvanta-resolve\b/, /\bvanta-brief\b/, /\bvanta-index\b/, /\bcouncil[- ]advisory\b/, /\bplan[- ]watcher\b/],
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

module.exports = {
  PROJECT_KEYWORDS,
  PROJECT_SPECIFIC_PATTERNS,
  GLOBAL_PROJECT,
  canonProject,
  isKnownProject,
  detectProject,
  slugForFilesystem,
  projectPatternsFor,
};
