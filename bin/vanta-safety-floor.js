#!/usr/bin/env node
// vanta-safety-floor — load + match against policy/safety-floor.yaml.
//
// The floor is the deterministic always-ask layer. The 3-axis LLM
// classifier sits ABOVE this; the floor wins on conflict. Anything
// matched here returns { ask: true, floor_id, why } and short-circuits
// the rest of the auto-vs-ask decision.
//
// Loaded once per process. Re-load by deleting from require.cache or
// calling reload().
//
// Usage:
//   const floor = require('./vanta-safety-floor');
//   floor.matchCommand('git push --force origin main');
//     -> { ask: true, id: 'git-force-push-main', why: '...' }
//   floor.matchFile('apps/web/.env.local');
//     -> { ask: true, id: 'env-file-write', why: '...' }
//   floor.matchPrompt('should we pivot to b2c?');
//     -> { ask: true, id: 'prompt-pivot-decision', why: '...' }
//   floor.matchSymbol('+  TIER_PRICE = 999');
//     -> { ask: true, id: 'pricing-constants', why: '...' }
//
// All matchers are PURE; they don't read the filesystem or persist.
// Loader is the only IO. Errors during load fall back to a permissive
// empty floor with a vlog().error so always-on layer doesn't break on
// a malformed YAML.

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

function _floorPath() {
  // P0 security: VANTA_SAFETY_FLOOR env override removed. An arbitrary env var
  // pointing to /dev/null or an empty file could silently disable all safety
  // rules. Policy must live in one of the three known safe locations below.
  const deployed = path.join(os.homedir(), '.vanta', 'policy', 'safety-floor.yaml');
  if (fs.existsSync(deployed)) return deployed;
  const repoLocal = path.join(__dirname, '..', 'policy', 'safety-floor.yaml');
  if (fs.existsSync(repoLocal)) return repoLocal;
  const user = path.join(os.homedir(), 'Projects', 'vanta', 'policy', 'safety-floor.yaml');
  if (fs.existsSync(user)) return user;
  return null;
}

// Minimal YAML parser. The floor file is structurally simple — version
// + a list of {id, kind, pattern, why} entries. Avoids a runtime
// dependency on js-yaml.
function _parseFloorYaml(src) {
  const out = { version: 0, floor: [] };
  const lines = src.split('\n');
  let inFloor = false;
  let entry = null;
  const flush = () => { if (entry && entry.id && entry.kind && entry.pattern) out.floor.push(entry); entry = null; };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const versionMatch = line.match(/^version:\s*(\d+)/);
    if (versionMatch) { out.version = parseInt(versionMatch[1], 10); continue; }
    if (/^floor:\s*$/.test(line)) { inFloor = true; continue; }
    if (!inFloor) continue;

    const idStart = line.match(/^\s*-\s*id:\s*(.+)$/);
    if (idStart) { flush(); entry = { id: idStart[1].trim() }; continue; }

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

// P0 safety-floor fail-closed: hardcoded minimal floor returned on ANY load
// failure. Previously all failure paths returned {floor:[]}, making the
// deterministic always-ask layer silently disappear on YAML corruption or a
// missing policy file. The entries below cover the most critical always-ask
// rules so a broken policy file degrades to "fewer rules" not "no rules".
// _re fields are pre-compiled to avoid depending on the compile step.
const MINIMAL_FLOOR = Object.freeze({
  version: 0,
  _minimal: true,
  floor: [
    {
      id: 'git-force-push-main', kind: 'command',
      pattern: 'push.*(--force|-f).*(main|master)',
      why: 'force-pushing main/master rewrites shared history — always confirm',
      _re: /push.*(--force|-f).*(main|master)/,
    },
    {
      id: 'env-file-write', kind: 'file',
      pattern: '**/.env*',
      why: '.env files risk leaking secrets',
    },
    {
      id: 'destructive-sql', kind: 'command',
      pattern: '(DROP\\s+(TABLE|DATABASE)|TRUNCATE\\s+TABLE)',
      why: 'irreversible data destruction — always confirm',
      _re: /(DROP\s+(TABLE|DATABASE)|TRUNCATE\s+TABLE)/i,
    },
    {
      id: 'rm-rf-root', kind: 'command',
      pattern: 'rm\\s+(-rf|-fr)\\s+/',
      why: 'deleting from / is catastrophic — always confirm',
      _re: /rm\s+(-rf|-fr)\s+\//,
    },
    {
      id: 'reset-hard', kind: 'command',
      pattern: 'git\\s+reset\\s+--hard',
      why: 'hard reset discards uncommitted work — always confirm',
      _re: /git\s+reset\s+--hard/,
    },
  ],
});

let _cache = null;
let _cacheMtime = 0;

function reload() { _cache = null; _cacheMtime = 0; }

function load() {
  const p = _floorPath();
  if (!p) {
    // No policy file anywhere — warn and use the minimal floor.
    if (!_cache) {
      vlog().warn('safety-floor.load', 'no policy file found — using hardcoded minimal floor');
      _cache = MINIMAL_FLOOR;
    }
    return _cache;
  }
  let st;
  try { st = fs.statSync(p); } catch {
    // Stat failed — use minimal floor, not empty floor.
    vlog().warn('safety-floor.load', `cannot stat ${p} — using hardcoded minimal floor`);
    return _cache || MINIMAL_FLOOR;
  }
  if (_cache && _cache !== MINIMAL_FLOOR && st.mtimeMs === _cacheMtime) return _cache;
  try {
    const src = fs.readFileSync(p, 'utf8');
    const parsed = _parseFloorYaml(src);
    for (const e of parsed.floor) {
      if (e.kind === 'command' || e.kind === 'symbol') {
        try { e._re = new RegExp(e.pattern); } catch (err) {
          vlog().error('safety-floor.compile', `bad regex for ${e.id}: ${err.message}`);
          e._re = null;
        }
      } else if (e.kind === 'prompt') {
        try { e._re = new RegExp(e.pattern, 'i'); } catch (err) {
          vlog().error('safety-floor.compile', `bad regex for ${e.id}: ${err.message}`);
          e._re = null;
        }
      }
    }
    _cache = parsed;
    _cacheMtime = st.mtimeMs;
    return _cache;
  } catch (err) {
    vlog().error('safety-floor.load', `failed to load ${p}: ${err.message}`);
    // Parse error — return minimal floor, not empty floor.
    if (!_cache || _cache === MINIMAL_FLOOR) {
      _cache = MINIMAL_FLOOR;
    }
    return _cache;
  }
}

// Convert a glob pattern to a RegExp. Supports `**`, `*`, `**/*.{a,b,c}`.
//
// Char-by-char tokenizer to avoid sentinel-substitution bugs that bit
// the v3.6.13 RC1 implementation (NUL/SOH sneaking into string literals
// via Write-tool encoding glitches). This pass produces the regex
// directly, escaping literal characters as encountered.
function _globToRegex(glob) {
  let out = '^';
  let i = 0;
  const SPECIAL = /[.+^${}()|[\]\\?]/;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*') {
      // `**/` → optional any-dir prefix so root-level files still match.
      // Without this, `**/.env*` compiles to `.*/\.env.*` and root `.env`
      // (no leading slash) bypasses the floor — the bug both R1 reviewers
      // flagged as P1 in v3.6.20.
      if (glob[i + 1] === '*' && glob[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 3;
      } else if (glob[i + 1] === '*') {
        out += '.*';
        i += 2;
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (ch === '{') {
      const close = glob.indexOf('}', i + 1);
      if (close < 0) {
        out += '\\{';  // unmatched brace — treat as literal
        i += 1;
      } else {
        const alts = glob.slice(i + 1, close).split(',').map(s => s.trim());
        out += '(' + alts.map(a => a.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('|') + ')';
        i = close + 1;
      }
    } else if (SPECIAL.test(ch)) {
      out += '\\' + ch;
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return new RegExp(out + '$');
}

function matchCommand(commandString) {
  const f = load();
  if (!commandString || typeof commandString !== 'string') return null;
  const stripped = commandString.replace(/^(\s*[A-Z_][A-Z0-9_]*=\S+\s+)+/, '').replace(/^sudo\s+/, '');
  for (const e of f.floor) {
    if (e.kind !== 'command' || !e._re) continue;
    if (e._re.test(stripped) || e._re.test(commandString)) {
      return { ask: true, id: e.id, why: e.why };
    }
  }
  return null;
}

function matchFile(filePath) {
  const f = load();
  if (!filePath || typeof filePath !== 'string') return null;
  const normalized = filePath.replace(/\\/g, '/');
  for (const e of f.floor) {
    if (e.kind !== 'file') continue;
    if (!e._glob) e._glob = _globToRegex(e.pattern);
    if (e._glob.test(normalized)) {
      return { ask: true, id: e.id, why: e.why };
    }
  }
  return null;
}

function matchPrompt(prompt) {
  const f = load();
  if (!prompt || typeof prompt !== 'string') return null;
  for (const e of f.floor) {
    if (e.kind !== 'prompt' || !e._re) continue;
    if (e._re.test(prompt)) {
      return { ask: true, id: e.id, why: e.why };
    }
  }
  return null;
}

function matchSymbol(diffBody) {
  const f = load();
  if (!diffBody || typeof diffBody !== 'string') return null;
  for (const e of f.floor) {
    if (e.kind !== 'symbol' || !e._re) continue;
    if (e._re.test(diffBody)) {
      return { ask: true, id: e.id, why: e.why };
    }
  }
  return null;
}

function listEntries() {
  return load().floor.map(e => ({ id: e.id, kind: e.kind, why: e.why }));
}

module.exports = { matchCommand, matchFile, matchPrompt, matchSymbol, listEntries, reload, load };

if (require.main === module) {
  const [, , kind, ...rest] = process.argv;
  const arg = rest.join(' ');
  if (!kind) {
    process.stderr.write('usage: vanta-safety-floor <command|file|prompt|symbol|list> [arg]\n');
    process.exit(2);
  }
  if (kind === 'list') {
    for (const e of listEntries()) {
      process.stdout.write(`${e.id.padEnd(28)}  ${e.kind.padEnd(8)}  ${e.why}\n`);
    }
    process.exit(0);
  }
  const matchers = { command: matchCommand, file: matchFile, prompt: matchPrompt, symbol: matchSymbol };
  const match = matchers[kind];
  if (!match) {
    process.stderr.write(`unknown kind: ${kind}\n`);
    process.exit(2);
  }
  const r = match(arg);
  if (r) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exit(1);
  }
  process.stdout.write('null\n');
  process.exit(0);
}
