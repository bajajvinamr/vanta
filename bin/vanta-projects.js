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

module.exports = {
  PROJECT_KEYWORDS,
  GLOBAL_PROJECT,
  canonProject,
  isKnownProject,
  detectProject,
  slugForFilesystem,
};
