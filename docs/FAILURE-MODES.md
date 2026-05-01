# Vanta Failure Modes

Known ways Vanta can fail and what to do. Updated when a council session
or production incident surfaces a new mode.

This is the doc to read when:
- A hook is firing weirdly (or not at all)
- `/council` returns PARTIAL or BLOCK without explanation
- An undo refuses
- Memory promotion stalls
- Trust metrics look wrong

Each entry: **symptom → root cause → fix**.

---

## Council / Multi-CLI

### Gemini exits with code 55 in headless mode

**Symptom:** `/council` returns "PARTIAL COUNCIL — Codex only" with a `model_health` block flagging Gemini as failed.

**Root cause:** Gemini CLI requires `GEMINI_CLI_TRUST_WORKSPACE=true` (or `--skip-trust`) when running outside an interactive terminal. Without it, exit code 55 means "not running in a trusted directory."

**Fix:** Pre-trust the directory by running `gemini` interactively in it once, OR set `GEMINI_CLI_TRUST_WORKSPACE=true` in the MCP server config. `vanta-council-health` falls back automatically; PARTIAL is acceptable as a degraded mode but you should fix the trust state if you want full council coverage.

### Codex exits with code 2 — "unexpected argument '-a'"

**Symptom:** Same as above — PARTIAL or BLOCK from council with Codex marked failed.

**Root cause:** Optional Multi-CLI parameters (`approvalPolicy`, `sandbox`) cause Codex CLI's arg-parse to fail. The Multi-CLI MCP forwards them as flags Codex doesn't know.

**Fix:** Omit `approvalPolicy` and `sandbox` from the `Ask-Codex` tool call entirely. Defaults are safe for review tasks. The vanta-council skill is already configured this way; if you customize the call site, mirror that.

### Both peers fail simultaneously

**Symptom:** `/council` cascades through every model in `model_health` and returns BLOCK with no findings.

**Root cause:** Multi-CLI MCP itself is down, or both auth tokens are stale.

**Fix:** Run `gemini --version` and `codex --version` directly to verify CLIs work. Re-auth if needed. As a workaround, vanta-council falls back to **solo adversarial review** (Claude self-review with adversarial prompt) — labeled "SOLO COUNCIL" in the verdict. Don't merge under solo when the original change touched auth, payments, or migrations.

---

## Action log / sync queue

### Sync alerts repeat every session forever

**Symptom:** Every session-start brief surfaces "UNSYNCED: N sessions" and N never decreases.

**Root cause:** vanta-sync writes `synced: false` entries to `~/.vanta/sync-queue.jsonl` but the consumer (whatever runs after extraction) never marks them `synced: true`.

**Fix:** vanta-sync MUST write a final `synced: true` line per session_id after processing. The queue is append-only; later entries with the same `session_id` win on read. Scan with `grep '"synced":true' ~/.vanta/sync-queue.jsonl | wc -l` to verify recent work is closed out.

### Action-log entries pile up across `.bak.<ts>` files

**Symptom:** `~/.vanta/actions.jsonl` is small but `~/.vanta/actions.jsonl.bak.*` files have thousands of unprocessed entries.

**Root cause:** The producer rotates the live JSONL when it gets large, leaving `.bak.<ts>` siblings on disk. Consumers (trust-metrics, regret-detector) MUST read merged across `.bak.*` siblings — `bin/vanta-jsonl.js`'s `readMergedJsonl()` does this.

**Fix:** If a custom consumer is missing entries, switch to `readMergedJsonl()` from `vanta-jsonl.js`. Don't compact the bak files manually.

---

## Undo

### Undo refuses with "moved on"

**Symptom:** `vanta-undo` returns `{ok: false, reason: "refused — file ... has moved on since Vanta wrote it"}`.

**Root cause:** v3.7.3 added a state-check. The file's current SHA doesn't match what Vanta recorded as `after_sha`. Either you (or another process) edited the file after Vanta wrote it. Reverting would silently throw away those edits.

**Fix:** Inspect the current state with `git diff <path>`. If your edits matter, save them in a separate commit first, then run `vanta-undo --force` to override. If the current state is wrong and you DO want to revert, `--force` does it.

### Undo says "no candidate to undo"

**Symptom:** `vanta-undo --dry` returns "no candidate to undo" but you remember Vanta just edited a file.

**Root cause:** The action wasn't logged with an `undo_hint`. Most older actions (pre-v3.6) lack the hint and aren't reversible. Some actions (memory-promote, autonomy-promote) are partial-undo only.

**Fix:** Use `git diff` + manual `git checkout <path>` to revert. Newer Vanta writes always carry the hint; this should be rare.

---

## Memory / promotion

### Memory promote does nothing

**Symptom:** `/vanta-sync` says it ran but `~/.claude/rules/vinamr-invariants.md` is unchanged.

**Root cause:** v3.5 `vanta-extract-score` 3-stage gating: skill-doc hard-reject, length/marker scoring, near-dup detection. The candidate fell into one of those gates.

**Fix:** Run `vanta-extract-score --dry --line "<your candidate>"` to see why it was scored low. Common reasons:
- Too short (under 40 chars)
- No specific tool/service name
- Sounds like a how-to, not an invariant
- Near-dup with an existing entry (gets folded as an update rather than a new line)

---

## Hooks

### Hook fires but does nothing visible

**Symptom:** `~/.vanta/hook.log` shows the hook ran but no constraint pack appeared in the chat.

**Root cause:** The hook gracefully degrades when its dependencies aren't available. `council-advisory.js` skips when `vanta-resolve.js` isn't loadable, for example.

**Fix:** Verify the bin scripts are deployed: `ls ~/.claude/bin/vanta-*`. If a script is missing, re-run `~/Projects/vanta/setup.sh`. v3.7.5 added missing scripts to the deploy list — if you're on older deployed bins, `vanta-executor.js` might not be installed.

### Hook blocks a tool call I want to run

**Symptom:** Bash command refused with "HARD BLOCK" from `git-guardrails.js`.

**Root cause:** v3.6 introduced the two-tier policy: HARD BLOCK on `force-push to main`, `--no-verify`, `rm -rf /`, `DROP/TRUNCATE`. Advisory-only on lesser destructive ops.

**Fix:** If the block is wrong (e.g., you really do need to force-push), do it manually outside the hook (e.g., from a separate terminal). Don't override Vanta's hard blocks via `--no-verify` (which is itself blocked) — the block exists because the action is dangerous, not because Vanta is wrong.

### Hooks fight each other

**Symptom:** Two hooks under `PreToolUse:Bash` execute, one blocks, the other tries to log — race or weird ordering.

**Root cause:** Hooks under the same matcher fire sequentially; ANY non-zero exit blocks the call. Two hooks claiming overlapping regex tables = design bug.

**Fix:** Each hook MUST be self-contained. Don't rely on another hook's state. Don't claim the same regex from two hooks. `slopsquatting-guard.sh` and `git-guardrails.js` partition cleanly today; if you add a third PreToolUse:Bash hook, make sure its regex doesn't overlap.

---

## Storage

### Knowledge shards corrupt under concurrent writes

**Symptom:** `~/.vanta/knowledge/<slug>.jsonl` has malformed lines, missing entries.

**Root cause:** `O_EXCL` is unreliable on NFS. Two indexer fires from different processes both think they hold the lockfile and clobber each other.

**Fix:** Move `~/.vanta/` to a local filesystem. NFSv3 silently grants the same lock to multiple writers; NFSv4 with delegations is better but still not guaranteed.

### Atomic rename fails with EXDEV

**Symptom:** Indexer logs `EXDEV: cross-device link not permitted` during shard rotation.

**Root cause:** `~/.vanta/` and `/tmp` are on different filesystems; the indexer writes via `tmp + rename` and the rename crosses a mount boundary.

**Fix:** Set `TMPDIR` to a path on the same filesystem as `~/.vanta/`, or move `~/.vanta/` to a partition that includes the system temp dir.

---

## Risk classification

### Classifier says T0 for an obviously risky prompt

**Symptom:** "delete all users" doesn't hit T3.

**Root cause:** Pre-v3.7.2 the safety-floor lacked a `prompt-bulk-delete` entry. The classifier alone landed bulk deletes at T2.

**Fix:** Upgrade to v3.7.2+. The floor entry catches "delete/wipe/nuke/purge/drop + all/every/the/from + users/accounts/customers/records/data" before the heuristic runs. Run `node bin/vanta-executor.js --prompt "delete all users"` to verify.

### Tier escalation seems wrong

**Symptom:** A tiny edit landed at T3 because of failure escalation, but I just had one bad test run.

**Root cause:** Failure escalation counts test-failure / build-failure / undo / regret signals in a 10-minute window. 3+ → bump 1 tier, 5+ → force T3.

**Fix:** Wait 10 minutes for the window to expire, OR clear out unsynced sessions via `/vanta-sync`. The escalation is intentional — when a session is stuck, the next operation should be reviewed harder.

---

## When you don't know what failed

1. **Check `~/.vanta/hook.log`** — every hook logs errors here, rotated at 1000 lines.
2. **Run `node bin/vanta-status.js`** — single-screen health: shards, queues, hook errors, stuck locks.
3. **Run `bash scripts/prompt-loop-smoke.sh`** — confirms the rewriter loop is healthy.
4. **Run `npm test`** — confirms no regressions.

If none of those surface the issue, open an entry here with **symptom → diagnosis → fix** when you find it.
