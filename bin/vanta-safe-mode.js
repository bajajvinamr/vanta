#!/usr/bin/env node
// vanta-safe-mode — repo-scoped conservative posture toggle.
//
// Roadmap §safe mode (council R2 P2 fix): safe mode is a top-level
// MASKING flag, not a destructive overwrite of preferences. When
// `safe_mode.active` is true, the executor reads underlying
// preferences but applies safe-mode masks: ambient/council/
// memory_promotion/inline_preview are forced to "off" regardless of
// stored values. Exiting safe mode restores the underlying values
// exactly. The user's preferences are never clobbered.
//
// Persistence: ~/.vanta/repos/<slug>/policy.json. The file is
// canonical; any consumer that wants to know "is this repo in safe
// mode?" reads it.
//
// Surface Impact Discipline: INTERNAL MACHINERY. Adds no commands.
// Engagement happens via natural language detected in the prompt-
// rewriter hook; the user never types JSON.

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function _vantaDir() {
  return process.env.VANTA_DIR_OVERRIDE || path.join(os.homedir(), '.vanta');
}
function _policyPath(projectSlug) {
  if (!projectSlug || typeof projectSlug !== 'string') {
    throw new Error('vanta-safe-mode: projectSlug required');
  }
  return path.join(_vantaDir(), 'repos', projectSlug, 'policy.json');
}

// Default policy — applied when the repo has no policy file yet. The
// underlying values match the roadmap's recommended defaults; safe
// mode starts disengaged. When safe mode is engaged, these stored
// values are PRESERVED and the masks fire on top.
const DEFAULT_POLICY = Object.freeze({
  ambient: 'auto',
  council: 'send-when-high-risk',
  memory_promotion: 'auto-project-staged-global',
  inline_preview: 'preview',
  monthly_cost_ceiling_usd: 25.00,
  safe_mode: {
    active: false,
    engaged_at: null,
    reason: null,
  },
});

// Engage triggers. Tight set — too loose and any "be careful" mid-
// conversation would flip the repo into safe mode.
const ENGAGE_PATTERNS = [
  /^\s*be careful\s*[.!]?\s*$/i,
  /^\s*safe mode\s*[.!]?\s*$/i,
  /^\s*safe mode (on|please)\s*[.!]?\s*$/i,
  /^\s*don'?t auto\s*[.!]?\s*$/i,
  /^\s*don'?t auto-?act\s*[.!]?\s*$/i,
  /^\s*i'?m (going to be )?working alongside you\s*[.!]?\s*$/i,
  /^\s*stop suggesting things\s*[.!]?\s*$/i,
  /^\s*conservative mode\s*[.!]?\s*$/i,
];

// Exit triggers.
const EXIT_PATTERNS = [
  /^\s*back to normal\s*[.!]?\s*$/i,
  /^\s*exit safe mode\s*[.!]?\s*$/i,
  /^\s*you can act normally\s*[.!]?\s*$/i,
  /^\s*safe mode off\s*[.!]?\s*$/i,
  /^\s*disengage safe mode\s*[.!]?\s*$/i,
];

function detectEngage(prompt) {
  if (!prompt || typeof prompt !== 'string') return false;
  return ENGAGE_PATTERNS.some(rx => rx.test(prompt));
}
function detectExit(prompt) {
  if (!prompt || typeof prompt !== 'string') return false;
  return EXIT_PATTERNS.some(rx => rx.test(prompt));
}

// Read policy for a project. Auto-creates from DEFAULT_POLICY on
// first read. Returns the policy object (a fresh shallow clone — the
// caller mutating won't poison the cache).
function readPolicy(projectSlug) {
  const p = _policyPath(projectSlug);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(DEFAULT_POLICY, null, 2));
    return _clone(DEFAULT_POLICY);
  }
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return _normalizePolicy(parsed);
  } catch (_) {
    // Corrupted → restore default. Better than crashing the executor.
    fs.writeFileSync(p, JSON.stringify(DEFAULT_POLICY, null, 2));
    return _clone(DEFAULT_POLICY);
  }
}

// Apply masks: takes a stored policy and returns the EFFECTIVE policy
// the executor should obey for THIS prompt. Stored preferences are
// untouched. When safe_mode.active is true, masks override.
//
// The masks force /off/ on any path that could auto-act:
//   - ambient: 'auto' | 'suggest' → 'off'
//   - council: 'send-when-high-risk' | 'always' → 'off'
//   - memory_promotion: anything → 'off'
//   - inline_preview: 'preview' | 'auto' → 'off'
//
// The masks do NOT affect monthly_cost_ceiling_usd — it's a budget,
// not an action policy.
function applyMasks(policy) {
  const out = _clone(policy);
  if (out.safe_mode && out.safe_mode.active === true) {
    out._underlying = {
      ambient: out.ambient,
      council: out.council,
      memory_promotion: out.memory_promotion,
      inline_preview: out.inline_preview,
    };
    out.ambient = 'off';
    out.council = 'off';
    out.memory_promotion = 'off';
    out.inline_preview = 'off';
  }
  return out;
}

// Engage safe mode for a project. Flips active=true, stamps
// engaged_at, records the reason. Underlying preferences untouched.
function engage(projectSlug, { reason = 'user-initiated' } = {}) {
  const p = readPolicy(projectSlug);
  p.safe_mode = {
    active: true,
    engaged_at: new Date().toISOString(),
    reason,
  };
  _persist(projectSlug, p);
  return p;
}

// Exit safe mode for a project. Flips active=false, clears
// engaged_at + reason. Underlying preferences are restored implicitly
// because they were never mutated.
function exit(projectSlug) {
  const p = readPolicy(projectSlug);
  p.safe_mode = {
    active: false,
    engaged_at: null,
    reason: null,
  };
  _persist(projectSlug, p);
  return p;
}

// Is safe mode currently active for a project? Pure read.
function isActive(projectSlug) {
  const p = readPolicy(projectSlug);
  return !!(p.safe_mode && p.safe_mode.active);
}

// Effective view: what the executor should obey RIGHT NOW for this
// project. Composes readPolicy + applyMasks.
function effective(projectSlug) {
  return applyMasks(readPolicy(projectSlug));
}

// Top-level handler. Detects engage/exit prompts and acts; returns a
// structured result the prompt-rewriter hook renders.
function handle({ project, prompt }) {
  if (!project) return { kind: 'noop', message: null };
  if (detectEngage(prompt)) {
    const after = engage(project, { reason: 'user-initiated' });
    return {
      kind: 'engaged',
      effective: applyMasks(after),
      message:
        `[Vanta] Safe mode is on for ${project}. I'll only respond to /vanta explicitly, ` +
        `won't fire council calls or promote memory, and will ask before any action that ` +
        `can't be cleanly undone. Say "back to normal" when you're ready.`,
    };
  }
  if (detectExit(prompt)) {
    if (!isActive(project)) {
      return {
        kind: 'noop',
        message: `[Vanta] Safe mode wasn't on for ${project}. Operating normally already.`,
      };
    }
    const after = exit(project);
    return {
      kind: 'exited',
      effective: applyMasks(after),
      message:
        `[Vanta] Safe mode is off. Restored prior preferences: ` +
        `ambient=${after.ambient}, council=${after.council}, memory_promotion=${after.memory_promotion}.`,
    };
  }
  return { kind: 'noop', message: null };
}

function _persist(projectSlug, policy) {
  const p = _policyPath(projectSlug);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(policy, null, 2));
}

function _normalizePolicy(parsed) {
  // Defensive: if the stored policy is missing fields (older version),
  // fold in DEFAULT_POLICY. Never overwrite present fields with
  // defaults — only fill gaps.
  const out = _clone(DEFAULT_POLICY);
  for (const k of Object.keys(parsed || {})) {
    if (k === 'safe_mode') {
      out.safe_mode = {
        active: parsed.safe_mode && parsed.safe_mode.active === true,
        engaged_at: parsed.safe_mode && parsed.safe_mode.engaged_at || null,
        reason: parsed.safe_mode && parsed.safe_mode.reason || null,
      };
    } else if (parsed[k] != null) {
      out[k] = parsed[k];
    }
  }
  return out;
}

function _clone(o) { return JSON.parse(JSON.stringify(o)); }

module.exports = {
  DEFAULT_POLICY,
  ENGAGE_PATTERNS,
  EXIT_PATTERNS,
  detectEngage,
  detectExit,
  readPolicy,
  applyMasks,
  engage,
  exit,
  isActive,
  effective,
  handle,
  _policyPath,
};
