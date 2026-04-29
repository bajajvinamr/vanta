# Vanta v3.3 — Shipped while you slept

Resumed your "use codex and gemini to the fullest, build the version of Vanta we can't even foresee" directive. 4 commits pushed to master.

## What shipped

| Commit | Tier | Headline |
|---|---|---|
| `7f4ec32` | v3.2 | Constraint-pack hook, episodes, vanta-patterns governance, decision metadata |
| `8da5f0d` | v3.3 T1 | **Install bug fix** (only Stop hook was registered; 3 of 4 hooks silently dead on fresh installs), expiry/supersession parser, dedup, race fix |
| `7708f7f` | v3.3 T2 | **`bin/vanta-resolve.js`** canonical knowledge index, **Shadow Council** via `plan-watcher.js` |
| `6d5f83b` | v3.3 polish | Stricter decision extractor (rejects skill-doc patterns), Shadow + stale-decision in session brief |

## The two big architectural shifts

1. **One canonical resolver, not five separate greps.** Both Codex and Gemini independently flagged this gap. `bin/vanta-resolve.js` queries invariants + decisions + gotchas + episodes + memory through a single ranked pipeline. Drops expired decisions and superseded entries. Used by `/recall` and by `council-advisory.js` — same ranking everywhere.

2. **Shadow Council (pre-emptive governance).** When you write a sensitive plan to `.planning/*.md`, `plan-watcher.js` detects auth/payment/migration/security keywords and flags it in `~/.gstack/projects/<slug>/.shadow_pending.md`. The flag surfaces in the constraint pack on the very first code edit AND in the session-start brief. You can't accidentally implement a sensitive plan that hasn't been council-reviewed.

## End-to-end smoke tests passed

- Editing `/auth/jwt.ts` → constraint pack surfaces ES256 JWT invariant + Baileys auth state invariant + project gotcha. Zero noise.
- Plan-watcher → flag write → council-advisory pickup chain works.
- Stop hook deduped: same session_id fired twice = 1 entry kept.
- Resolver: `--topic jwt` returns 2 ranked results with confidence + recency scoring.

## What I deliberately deferred (open in v3.4)

- **Real async Shadow Council fire** (Gemini's full proposal) — spawning detached Codex/Gemini CLI from a hook is risky without auth-check infrastructure. v3.3 ships flag-only; the verdict-cache step lands when we know the false-positive rate.
- **Route manifest** (Codex's P2) — `vanta-patterns` still edits the deployed SKILL.md directly. Routes get wiped on `setup.sh` reinstall. Move routing table to JSON manifest in repo, regenerate SKILL.md from it.
- **Promoted-invariants metric** — sync coverage measures queue clearing, not actual knowledge promotion. Track which invariants got added by which session.
- **Read-blind anticipatory memory** — constraint pack only fires on Write/Edit. Should also fire when Claude reads sensitive files or on plan-mode entry.

## State of `~/.vanta/` after cleanup

- `episodes.jsonl`: 0 entries (purged poisoned data; new sessions populate cleanly with stricter extractor)
- `sync-queue.jsonl`: 3 unsynced sessions (vanta, sales-agent-publisher, priyaa-audit) — would benefit from `/vanta-sync` runs

## Next concrete action when you wake up

1. `/vanta-sync` in any of the 3 unsynced project dirs to extract their learnings (will use the new stricter extractor, no markdown poisoning).
2. Restart Claude Code so the new `plan-watcher.js` hook registers and `council-advisory.js` picks up the resolver.
3. Test cross-project recall: `/vanta what do I know about pixijs` should now hit invariants + memory in one ranked block.
