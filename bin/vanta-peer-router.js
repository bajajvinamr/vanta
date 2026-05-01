#!/usr/bin/env node
// vanta-peer-router — pick which council peer (codex / gemini / both)
// to fire for T2 single-peer review.
//
// Reads policy/peer-routing.yaml. Each rule: { pattern, against, peer,
// why }. First match wins. `against` is a pipe-separated list of
// signal sources (prompt, file_path, command).
//
// Usage:
//   const router = require('./vanta-peer-router');
//   router.pick({ prompt: 'fix the auth flow', file_path: 'src/auth/jwt.ts' });
//   → { peer: 'both', why: 'security blind-spot diversity required',
//       rule_index: 0 }
//
// The router does NOT actually invoke peers — it just picks. The
// council orchestration in skills/council/SKILL.md and
// bin/vanta-council-run.js does the firing.

const fs = require('fs');
const path = require('path');
const os = require('os');

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

function _routingPath() {
  const userOverride = process.env.VANTA_PEER_ROUTING;
  if (userOverride && fs.existsSync(userOverride)) return userOverride;
  const deployed = path.join(os.homedir(), '.vanta', 'policy', 'peer-routing.yaml');
  if (fs.existsSync(deployed)) return deployed;
  const repoLocal = path.join(__dirname, '..', 'policy', 'peer-routing.yaml');
  if (fs.existsSync(repoLocal)) return repoLocal;
  const user = path.join(os.homedir(), 'Projects', 'vanta', 'policy', 'peer-routing.yaml');
  if (fs.existsSync(user)) return user;
  return null;
}

// Same minimal YAML parse style as safety-floor — the routing file is
// flat list-of-objects, no nesting beyond top-level keys.
function _parseRoutingYaml(src) {
  const out = { version: 0, rules: [], default: 'codex' };
  const lines = src.split('\n');
  let inRules = false;
  let entry = null;
  const flush = () => {
    if (entry && entry.pattern && entry.peer) out.rules.push(entry);
    entry = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const versionMatch = line.match(/^version:\s*(\d+)/);
    if (versionMatch) { out.version = parseInt(versionMatch[1], 10); continue; }

    const defaultMatch = line.match(/^default:\s*(.+)$/);
    if (defaultMatch && !inRules) { out.default = defaultMatch[1].trim().replace(/['"]/g, ''); continue; }

    if (/^rules:\s*$/.test(line)) { inRules = true; continue; }
    if (!inRules) continue;

    // After a `default:` at root we leave inRules — but YAML order
    // here always has `default` AFTER the rules list (file convention).
    // If we encounter `default:` while inRules, treat it as terminator.
    if (defaultMatch && inRules) {
      flush();
      out.default = defaultMatch[1].trim().replace(/['"]/g, '');
      inRules = false;
      continue;
    }

    const startMatch = line.match(/^\s*-\s*pattern:\s*(.+)$/);
    if (startMatch) {
      flush();
      let v = startMatch[1].trim();
      if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
        v = v.slice(1, -1);
      }
      entry = { pattern: v };
      continue;
    }

    if (!entry) continue;

    const kvMatch = line.match(/^\s+(\w+):\s*(.+)$/);
    if (kvMatch) {
      const [, key, value] = kvMatch;
      let v = value.trim();
      if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
        v = v.slice(1, -1);
      }
      entry[key] = v;
    }
  }
  flush();
  return out;
}

let _cache = null;
let _cacheMtime = 0;

function reload() { _cache = null; _cacheMtime = 0; }

function load() {
  const p = _routingPath();
  if (!p) {
    if (!_cache) _cache = { version: 0, rules: [], default: 'codex' };
    return _cache;
  }
  let st;
  try { st = fs.statSync(p); } catch { return _cache || { version: 0, rules: [], default: 'codex' }; }
  if (_cache && st.mtimeMs === _cacheMtime) return _cache;
  try {
    const src = fs.readFileSync(p, 'utf8');
    const parsed = _parseRoutingYaml(src);
    for (const r of parsed.rules) {
      try { r._re = new RegExp(r.pattern, 'i'); } catch (err) {
        vlog().error('peer-router.compile', `bad regex for "${r.pattern}": ${err.message}`);
        r._re = null;
      }
      r._against = (r.against || 'prompt').split('|').map(s => s.trim());
    }
    _cache = parsed;
    _cacheMtime = st.mtimeMs;
    return _cache;
  } catch (err) {
    vlog().error('peer-router.load', err.message);
    if (!_cache) _cache = { version: 0, rules: [], default: 'codex' };
    return _cache;
  }
}

// Pick a peer. signals = { prompt, file_path, command }.
function pick(signals = {}) {
  const cfg = load();
  for (let i = 0; i < cfg.rules.length; i++) {
    const r = cfg.rules[i];
    if (!r._re) continue;
    for (const src of r._against) {
      const text = signals[src];
      if (typeof text === 'string' && r._re.test(text)) {
        return { peer: r.peer, why: r.why || `matched rule ${i}`, rule_index: i, matched_against: src };
      }
    }
  }
  return { peer: cfg.default, why: 'no rule matched — using default', rule_index: -1 };
}

// Convenience: list all rules (for vanta-status / debug surface).
function listRules() {
  return load().rules.map(r => ({ pattern: r.pattern, against: r._against, peer: r.peer, why: r.why }));
}

module.exports = { pick, listRules, reload, load };

// CLI:
//   echo '{"prompt": "fix auth", "file_path": "src/auth.ts"}' | vanta-peer-router
//   vanta-peer-router --prompt "fix the auth flow"
if (require.main === module) {
  const args = process.argv.slice(2);
  let signals = {};
  const promptFlag = args.indexOf('--prompt');
  const fileFlag = args.indexOf('--file');
  const commandFlag = args.indexOf('--command');
  if (promptFlag >= 0)  signals.prompt    = args[promptFlag + 1];
  if (fileFlag >= 0)    signals.file_path = args[fileFlag + 1];
  if (commandFlag >= 0) signals.command   = args[commandFlag + 1];

  if (Object.keys(signals).length > 0) {
    const r = pick(signals);
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exit(0);
  }
  // stdin path.
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => stdin += c);
  process.stdin.on('end', () => {
    try {
      signals = JSON.parse(stdin || '{}');
    } catch { signals = {}; }
    const r = pick(signals);
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  });
}
