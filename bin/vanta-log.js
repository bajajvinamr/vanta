// vanta-log — minimal append-only logger for hooks + bins.
//
// Cleanup #11: hooks previously failed silently. They must never block, so
// we can't throw — but they CAN write a one-line entry to ~/.vanta/hook.log
// and exit 0. Without this, broken hooks rot invisibly for months.
//
// Format: ISO-ts | level | hook | message
// Capped at 1000 lines via best-effort rotation (don't block on rotation
// failure — keep writing).

const fs = require('fs');
const path = require('path');
const os = require('os');

// Codex+Gemini council R5 P1+P2 fixes — VANTA_DIR_OVERRIDE honored;
// rotation no longer races concurrent appends.
function _vantaDir() { return process.env.VANTA_DIR_OVERRIDE || path.join(os.homedir(), '.vanta'); }
function _logFile()  { return path.join(_vantaDir(), 'hook.log'); }
const LOG_FILE = path.join(os.homedir(), '.vanta', 'hook.log');  // back-compat const
const MAX_BYTES = 200_000;  // ~1k lines @ 200 char/line

function _ensureDir() {
  const dir = path.dirname(_logFile());
  if (!fs.existsSync(dir)) { try { fs.mkdirSync(dir, { recursive: true }); } catch {} }
}

// Atomic rotation: rename live log to .bak. POSIX rename is atomic and
// concurrent appendFileSync calls keep working — they either land in the
// already-renamed .bak (we lose its trailing entries on next rotation,
// fine for best-effort hook telemetry) or in the freshly-created file.
// Earlier read-then-writeFileSync would silently destroy any append that
// happened in the read-write window.
function _rotateIfNeeded() {
  try {
    const file = _logFile();
    const st = fs.statSync(file);
    if (st.size < MAX_BYTES) return;
    fs.renameSync(file, file + '.bak');
  } catch { /* never block */ }
}

function log(level, source, message) {
  _ensureDir();
  _rotateIfNeeded();
  const ts = new Date().toISOString();
  const line = `${ts} | ${level.padEnd(5)} | ${source.padEnd(24)} | ${String(message).replace(/\n/g, ' ').slice(0, 500)}\n`;
  try { fs.appendFileSync(_logFile(), line); } catch { /* never block */ }
}

function info(source, message)  { log('INFO',  source, message); }
function warn(source, message)  { log('WARN',  source, message); }
function error(source, message) { log('ERROR', source, message); }

// Wrap a hook entry point so any throw lands in the log instead of stderr.
// hookFn receives input parsed from stdin; expected to return a JSON-stringifiable
// object (or string '{}'). Always exits 0.
async function runHook(hookName, hookFn) {
  try {
    let input = {};
    if (!process.stdin.isTTY) {
      const raw = await new Promise(resolve => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', c => data += c);
        process.stdin.on('end', () => resolve(data));
        // Fallback: 2s readiness timeout
        setTimeout(() => resolve(data), 2000);
      });
      if (raw) { try { input = JSON.parse(raw); } catch { /* leave {} */ } }
    }
    const result = await hookFn(input);
    process.stdout.write(typeof result === 'string' ? result : JSON.stringify(result || {}));
    process.exit(0);
  } catch (err) {
    error(hookName, err && err.stack ? err.stack.slice(0, 400) : String(err));
    process.stdout.write('{}');
    process.exit(0);
  }
}

module.exports = { info, warn, error, log, runHook, LOG_FILE };
