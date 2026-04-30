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

const LOG_FILE = path.join(os.homedir(), '.vanta', 'hook.log');
const MAX_LINES = 1000;

function _ensureDir() {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) { try { fs.mkdirSync(dir, { recursive: true }); } catch {} }
}

function _rotateIfNeeded() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size < 200_000) return;  // ~1k lines @ 200 char/line
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length <= MAX_LINES) return;
    const trimmed = lines.slice(-MAX_LINES).join('\n') + '\n';
    fs.writeFileSync(LOG_FILE, trimmed);
  } catch { /* never block */ }
}

function log(level, source, message) {
  _ensureDir();
  _rotateIfNeeded();
  const ts = new Date().toISOString();
  const line = `${ts} | ${level.padEnd(5)} | ${source.padEnd(24)} | ${String(message).replace(/\n/g, ' ').slice(0, 500)}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* never block */ }
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
