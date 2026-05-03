#!/usr/bin/env node
// Stop hook — fires when a Claude Code session ends.
//
// Two outputs:
//   1. ~/.vanta/sync-queue.jsonl — pending items for /vanta-sync to process
//   2. ~/.vanta/episodes.jsonl   — durable episodic memory: {topic, decision, outcome, date, project}
//
// A session is captured when:
//   - >5 tool calls (meaningful work), OR
//   - transcript contains decision/fix markers (root cause / fixed it / decided to / shipped / merged)
//
// Episodes enable time-aware recall: "what did we discuss about X last week"

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Cleanup #11: lazy logger.
let _vlog;
function vlog() {
  if (_vlog) return _vlog;
  for (const p of [
    path.join(process.env.HOME || '', '.claude', 'bin', 'vanta-log.js'),
    path.join(process.env.HOME || '', 'Projects', 'vanta', 'bin', 'vanta-log.js'),
  ]) { try { _vlog = require(p); return _vlog; } catch {} }
  _vlog = { info: () => {}, warn: () => {}, error: () => {} };
  return _vlog;
}

// Codex R4 P3 fix — honor VANTA_DIR_OVERRIDE so tests don't pollute ~/.vanta.
function _vantaDir() {
  return process.env.VANTA_DIR_OVERRIDE || path.join(os.homedir(), '.vanta');
}
function _queuePath()    { return path.join(_vantaDir(), 'sync-queue.jsonl'); }
function _episodesPath() { return path.join(_vantaDir(), 'episodes.jsonl'); }
function _failuresPath() { return path.join(_vantaDir(), 'recent-failures.jsonl'); }

// v3.10 commit 4 — lazy-load the failure extractor. Returns null if
// the bin isn't deployed (older install) — we degrade silently rather
// than break the Stop hook on missing modules.
let _failExtractor = null;
function _failureExtractor() {
  if (_failExtractor !== null) return _failExtractor;
  for (const p of [
    path.join(__dirname, '..', 'bin', 'vanta-failure-extract.js'),
    path.join(os.homedir(), '.claude', 'bin', 'vanta-failure-extract.js'),
  ]) {
    try { _failExtractor = require(p); return _failExtractor; } catch (_) { /* try next */ }
  }
  _failExtractor = false;  // mark as searched
  return null;
}
const MAX_BYTES = 5_000_000;
const TOOL_CALL_THRESHOLD = 5;
const DECISION_MARKERS = /\b(root cause|fixed it|decided to|shipped|merged|landed|figured out|the bug was)\b/i;

// Topic extraction: scan for technical nouns/proper nouns that appear repeatedly.
// Cheap heuristic — looks for capitalized multi-word phrases and common stack terms.
const TECH_TERMS = /\b(JWT|OAuth|Stripe|Supabase|Prisma|Next\.?js|React|Redis|BullMQ|PixiJS|Cloudflare|Vercel|Docker|Postgres|GraphQL|WebSocket|TLS|CORS|CSP|RBAC|Webhook|Migration|Auth|Payment|Council|Memory|Routing|Hook|Skill|Vanta|gstack|GSD)\b/g;

function topTopics(text, max = 3) {
  const counts = new Map();
  const matches = text.match(TECH_TERMS) || [];
  for (const m of matches) {
    const key = m.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([term]) => term);
}

// Extract a 1-line decision summary from text following a decision marker.
// Strips markdown noise (code blocks, headers, list bullets), rejects skill-
// documentation patterns, and demands actual prose — not just a marker phrase
// followed by a section header.
const SKILL_DOC_PHRASES = [
  /\bUse when\b/i, /\bDon'?t use\b/i, /\bUse if\b/i, /\bWhen to (Run|Use)\b/i,
  /\bMultiple subsystems\b/i, /\bEach problem\b/i, /\bNo shared state\b/i,
  /\bUse this skill\b/i, /\bThis skill (is|will|can)\b/i,
];

function extractDecision(text) {
  // Remove fenced code blocks and inline code first — they contain marker words.
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]+`/g, ' ');
  // Match the marker and capture up to ~300 chars of following prose.
  const re = /(decided to|the bug was|root cause(?:\s+was)?|fixed it|the fix was)([^\n]{10,300})/i;
  const m = cleaned.match(re);
  if (!m) return null;
  const candidate = (m[1] + m[2])
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[*_`#>|-]+/g, '')  // strip leftover markdown
    .trim();
  if (/^[#\-*]/.test(candidate)) return null;
  if (candidate.length < 30) return null;  // too short = noise
  // Reject if it looks like skill documentation
  if (SKILL_DOC_PHRASES.some(rx => rx.test(candidate))) return null;
  // Reject if more than 2 of these doc-section words are present together
  const docMarkers = (candidate.match(/\b(investigation|subsystem|problem|step|phase|skill)\b/gi) || []).length;
  if (docMarkers >= 3) return null;
  return candidate.slice(0, 200);
}

// Outcome detection: did this session ship/land/resolve?
function detectOutcome(text) {
  if (/\b(shipped|merged|landed|deployed|fixed|resolved)\b/i.test(text)) return 'resolved';
  if (/\b(blocked|stuck|reverted|rolled back)\b/i.test(text)) return 'blocked';
  if (/\b(decided to|chose|went with)\b/i.test(text)) return 'decided';
  return 'in-progress';
}

// Codex R7 P3 fix — earlier impl cleared the timeout BEFORE reading the
// transcript, then ran fs.readFileSync + several regex scans on a file
// that can be MB. On long sessions this could exceed Claude Code's ~10s
// Stop-hook budget and the hook would be force-killed mid-write,
// stranding sync-queue/episode entries. Now: keep the deadline alive
// through the entire hook lifetime AND cap the transcript bytes
// processed so even a 100MB transcript doesn't push us past budget.
const TRANSCRIPT_BYTES_CAP = 8 * 1024 * 1024;  // 8MB — typical session is <2MB
let input = '';
// R8 P2 — Gemini council finding. Earlier impl exited silently when the
// 9.5s deadline tripped, never reaching the catch-block logger. If a
// growing transcript consistently breached 9.5s (large project, ~MB
// transcript), Vanta would stop recording memories with zero error
// signal. Log before exit so silent breakage becomes visible in
// hook.log, which vanta-status surfaces.
const timeout = setTimeout(() => {
  try { vlog().error('auto-sync', 'timeout (9.5s) exceeded — Stop hook force-exiting'); } catch {}
  process.exit(0);
}, 9500);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  // Note: timeout still armed; cleared only at process.exit at end.
  try {
    const data = JSON.parse(input);
    const { session_id, transcript_path, cwd } = data;

    if (!transcript_path || !fs.existsSync(transcript_path)) {
      clearTimeout(timeout); process.exit(0);
    }

    // Read up to the cap from the END of the transcript (most recent
    // content is most relevant for decision-marker + tool-use detection).
    let transcript;
    try {
      const st = fs.statSync(transcript_path);
      if (st.size > TRANSCRIPT_BYTES_CAP) {
        const fd = fs.openSync(transcript_path, 'r');
        const buf = Buffer.alloc(TRANSCRIPT_BYTES_CAP);
        fs.readSync(fd, buf, 0, TRANSCRIPT_BYTES_CAP, st.size - TRANSCRIPT_BYTES_CAP);
        fs.closeSync(fd);
        transcript = buf.toString('utf8');
      } else {
        transcript = fs.readFileSync(transcript_path, 'utf8');
      }
    } catch {
      clearTimeout(timeout); process.exit(0);
    }
    const toolCallCount = (transcript.match(/"type"\s*:\s*"tool_use"/g) || []).length;
    const hasDecisionMarker = DECISION_MARKERS.test(transcript);

    if (toolCallCount <= TOOL_CALL_THRESHOLD && !hasDecisionMarker) {
      clearTimeout(timeout); process.exit(0);
    }

    fs.mkdirSync(_vantaDir(), { recursive: true });

    let branch = 'unknown';
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: cwd || process.cwd(),
        stdio: ['pipe', 'pipe', 'ignore'],
      }).toString().trim();
    } catch (_) {}

    // R7 P2 fix — robust slug. Use shared resolver from vanta-projects;
    // basename(cwd) collided across projects with the same directory name.
    let slug = path.basename(cwd || process.cwd());
    try {
      const projects = require(path.join(os.homedir(), '.claude', 'bin', 'vanta-projects.js'));
      if (projects.slugFromCwd) {
        const better = projects.slugFromCwd(cwd || process.cwd());
        if (better) slug = better;
      }
    } catch {
      try {
        const projects = require(path.join(os.homedir(), 'Projects', 'vanta', 'bin', 'vanta-projects.js'));
        if (projects.slugFromCwd) {
          const better = projects.slugFromCwd(cwd || process.cwd());
          if (better) slug = better;
        }
      } catch { /* fall back to basename */ }
    }
    const ts = new Date().toISOString();

    // R9 P1 — Codex council finding. The synthetic 'unknown' fallback
    // collapsed multiple session_id-less Stop hook invocations into one
    // dedup bucket: consumers that fold by session_id (vanta-brief,
    // vanta-resolve, vanta-status) silently overwrote each other's
    // entries. Prefer a unique fallback so unknown-source events still
    // get distinct dedup keys.
    const sid = session_id || `unknown-${process.pid}-${Date.now()}`;

    // Codex R4 P2 fix — was read-modify-write under .tmp+rename. Two
    // sessions stopping concurrently could both load the same baseline and
    // the second rename would clobber the first session's entry. Now we
    // append-only; readers dedup by session_id taking the LAST occurrence.
    // POSIX appendFileSync < PIPE_BUF (4096B) is atomic; each entry is
    // a few hundred bytes, well under the limit.
    //
    // Rotation: if file > 5MB, fold to last-occurrence-per-session before
    // appending. This is a per-Stop-hook event (not per tool call), so
    // the fold cost is negligible vs hook lifetime.
    // R5 P2 fix — earlier rotation read+folded then renamed tmp→file. A
    // concurrent appendFileSync between the read and the rename would be
    // lost. New: rename live file to .bak when oversized, then write the
    // folded snapshot as the fresh file. POSIX rename is atomic; any
    // concurrent appendFileSync either lands in the soon-to-be-.bak file
    // (preserved) or the freshly-recreated file. No clobber window.
    // Codex+Gemini council R8 P1 — concurrent-stop data loss.
    // Earlier impl folded inline: rename file→.bak, then writeFileSync(file)
    // with the deduped snapshot. When 5 Claude Code windows ended within the
    // same second, Session A's writeFileSync clobbered Session B's
    // freshly-appended entry (B's appendFileSync between A's rename and A's
    // writeFileSync created a fresh file with B's data; A's writeFileSync
    // then OVERWROTE it). The R5 P2 comment claiming "no clobber window"
    // was wrong.
    //
    // R8 fix: rotation no longer recreates the file. We rename to a
    // timestamp-suffixed `.bak.<ts>` and let appendFileSync recreate the
    // live file for the new entry. Folding moves to READ-TIME — readers
    // (vanta-sync, vanta-status, using-vanta SKILL.md) glob `.bak.*` plus
    // the live file and dedup by session_id. This is the correct semantics
    // for an append-only log; the producer never needs to compact.
    //
    // Also R8 P2 — legacy entries without session_id used to silently
    // disappear when fold-on-rotate dropped them. With rotation no longer
    // folding, legacy entries are preserved verbatim in `.bak.<ts>` and
    // remain visible to readers that don't require session_id.
    const appendJsonl = (file, newEntry) => {
      try {
        if (fs.existsSync(file)) {
          const st = fs.statSync(file);
          if (st.size > MAX_BYTES) {
            // Atomic-rename rotation. Timestamp suffix avoids overwriting
            // an earlier rotation's .bak — a yearly system can rotate
            // many times. The next rotator picks up where this one left off.
            const ts = Date.now() + '.' + process.pid;
            const bak = `${file}.bak.${ts}`;
            try { fs.renameSync(file, bak); } catch { /* race: someone else rotated; fine */ }
            // No writeFileSync — file is recreated by appendFileSync below
            // with this session's entry. Concurrent appenders also create
            // it; appendFileSync per-line atomicity (POSIX) means each
            // entry lands intact.
          }
        }
      } catch { /* never block on rotation */ }
      try {
        // R9 P1 — torn-line guard. Gemini council: if a previous append
        // was truncated mid-write (SIGKILL/ENOSPC) and lost its trailing
        // newline, this write fuses to it and corrupts BOTH records on
        // read. Leading \n ensures the next record's start is anchored
        // even when the previous one lost its terminator.
        fs.appendFileSync(file, '\n' + JSON.stringify(newEntry) + '\n');
      } catch (e) { vlog().error('auto-sync.append', e.message || String(e)); }
    };

    // 1. Sync queue (pending learning extraction)
    appendJsonl(_queuePath(), {
      ts, cwd: cwd || process.cwd(), slug, branch,
      session_id: sid,
      transcript_path,
      tool_calls: toolCallCount,
      decision_marker: hasDecisionMarker,
      synced: false,
    });

    // 2a. v3.10 commit 4 — recent failures pipeline.
    //
    // C-2 council fix (hardened): structured allowlisted fields ONLY.
    // The failure extractor (bin/vanta-failure-extract.js) is a pure
    // regex parser; it returns null for any output shape it doesn't
    // recognize. We dedupe within this session by (kind, file,
    // test_name, tool_name) and only persist DISTINCT failure
    // signatures, with `count` reflecting occurrences. This prevents a
    // single noisy command from drowning the brief.
    try {
      const ex = _failureExtractor();
      if (ex && typeof ex.extractFailure === 'function') {
        // Scan transcript for tool_use (Bash) + their tool_use_result
        // pairs. Transcript JSONL format: each line is a message; each
        // message contains a content array; tool_use blocks have
        // `tool_use_id`, `name`, `input.command`; tool_results carry
        // `tool_use_id`, `content` (often {type:'text',text:...}) and
        // an `is_error` flag. We do a best-effort line-by-line walk
        // — full JSONL parse would be too slow on a multi-MB transcript.
        const failuresThisSession = new Map();  // key → entry
        const lines = transcript.split('\n');
        // Build a tool_use_id → command map first
        const toolUses = new Map();
        for (const line of lines) {
          if (!line.includes('"tool_use"') && !line.includes('"name":"Bash"')) continue;
          let parsed;
          try { parsed = JSON.parse(line); } catch { continue; }
          const content = parsed?.message?.content || parsed?.content;
          if (!Array.isArray(content)) continue;
          for (const block of content) {
            if (block?.type === 'tool_use' && block.name === 'Bash' && block.id) {
              const cmd = block.input?.command || '';
              toolUses.set(block.id, cmd);
            }
          }
        }
        // Now match results
        for (const line of lines) {
          if (!line.includes('"tool_result"')) continue;
          let parsed;
          try { parsed = JSON.parse(line); } catch { continue; }
          const content = parsed?.message?.content || parsed?.content;
          if (!Array.isArray(content)) continue;
          for (const block of content) {
            if (block?.type !== 'tool_result' || !block.tool_use_id) continue;
            const cmd = toolUses.get(block.tool_use_id);
            if (cmd == null) continue;  // not a Bash result
            // Extract text from content (can be string or [{type:text,text}])
            let text = '';
            if (typeof block.content === 'string') text = block.content;
            else if (Array.isArray(block.content)) {
              for (const c of block.content) {
                if (typeof c?.text === 'string') text += c.text + '\n';
              }
            }
            // Heuristic: stderr is typically embedded; we treat the
            // whole tool_result as 'stderr' for matching purposes, and
            // pass an exit_code of 1 when is_error is set.
            const exitCode = block.is_error ? 1 : 0;
            if (exitCode === 0) continue;
            const failure = ex.extractFailure({
              tool_name: 'Bash',
              command: cmd,
              exit_code: exitCode,
              stderr: text.slice(0, 32 * 1024),  // cap input size
              stdout: '',
            });
            if (!failure) continue;
            const key = `${failure.kind}|${failure.file || ''}|${failure.test_name || ''}|${failure.tool_name || ''}`;
            const prior = failuresThisSession.get(key);
            if (prior) { prior.count = (prior.count || 1) + 1; continue; }
            failuresThisSession.set(key, { ...failure, count: 1 });
          }
        }
        // Persist distinct failures with allowlist validation.
        for (const f of failuresThisSession.values()) {
          const entry = {
            ts,
            project: slug,
            session_id: sid,
            ...f,
            signal: f.count > 1 ? 'recurring' : 'first_seen',
          };
          try {
            ex.validateFailure(entry);
            appendJsonl(_failuresPath(), entry);
          } catch (e) {
            // C-2 hard gate — never write if validation fails.
            vlog().error('auto-sync.failures', `validation rejected: ${e.message}`);
          }
        }
      }
    } catch (e) {
      vlog().error('auto-sync.failures', e.message || String(e));
    }

    // 2b. Episode (durable, time-aware memory) — only if decision-marker session
    if (hasDecisionMarker) {
      const topics = topTopics(transcript);
      const decision = extractDecision(transcript);
      const outcome = detectOutcome(transcript);

      appendJsonl(_episodesPath(), {
        ts, slug, branch,
        topics,           // ["jwt", "auth"] etc.
        decision,         // 1-line decision summary (null if extractor rejected noise)
        outcome,          // "resolved" | "blocked" | "decided" | "in-progress"
        session_id: sid,
      });
    }
    // R8 P2 — wire resetSession + reapStale (Codex council finding).
    // Earlier code exposed both functions via vanta-runtime-state.js but
    // nothing called them. Per-session journals at ~/.vanta/runtime/*.jsonl
    // accumulated forever. Now: clean THIS session's journal on its Stop,
    // and run a once-a-day reapStale pass for orphans.
    try {
      const rs = require(path.join(os.homedir(), '.claude', 'bin', 'vanta-runtime-state.js'));
      if (rs && rs.resetSession) rs.resetSession(sid);
      // Once-per-day gate to keep the work cheap. Marker file mtime tracks last reap.
      const reapMarker = path.join(_vantaDir(), '.last-reap');
      let needsReap = true;
      try {
        const st = fs.statSync(reapMarker);
        if (Date.now() - st.mtimeMs < 24 * 60 * 60_000) needsReap = false;
      } catch { /* marker missing — first reap */ }
      if (needsReap && rs && rs.reapStale) {
        rs.reapStale({ days: 7 });
        // Sweep stale .tmp / .compact leaks across the persistent dirs too.
        if (rs.reapStaleTmp) {
          rs.reapStaleTmp([
            _vantaDir(),
            path.join(os.homedir(), '.vanta', 'knowledge'),
          ]);
        }
        // R12 P1 — Gemini council finding. R8 P1 rotation produced
        // unbounded `.bak.<ts>` siblings; nothing ever deleted them.
        // Keep the 10 most recent per journal; drop older ones.
        if (rs.reapStaleBaks) {
          rs.reapStaleBaks([_vantaDir()], [
            'sync-queue.jsonl',
            'episodes.jsonl',
            'interactions.jsonl',
            'query-log.jsonl',
          ], 10);
        }
        try { fs.writeFileSync(reapMarker, ''); } catch {}
      }
    } catch (e) {
      // R12 P2 — Gemini council finding. If require()'ing vanta-runtime-state
      // fails (bin not deployed), this catch swallows the error and the
      // R11 .bin-missing sentinel never gets touched from the Stop side —
      // breaking composition with prompt-context's R8 P2 sentinel logic.
      // Now: also touch the sentinel when the require fails, so vanta-status
      // surfaces "always-on layer disabled" regardless of which hook
      // discovered it first.
      vlog().error('auto-sync.reap', e.message || String(e));
      try {
        const sentinel = path.join(_vantaDir(), '.bin-missing');
        let shouldTouch = true;
        try {
          const st = fs.statSync(sentinel);
          if (Date.now() - st.mtimeMs < 60 * 60_000) shouldTouch = false;
        } catch {}
        if (shouldTouch) {
          fs.writeFileSync(sentinel,
            `${new Date().toISOString()} auto-sync: bins missing (${e.message || String(e)})\n`);
        }
      } catch {}
    }
  } catch (err) {
    // Never block a session from ending — but log so silent breakage is visible.
    vlog().error('auto-sync', err && err.message || String(err));
  }
  clearTimeout(timeout);
  process.exit(0);
});
