# Gstack Reference

Vanta is built on top of two underlying frameworks. Understanding the distinction matters for knowing which command to reach for.

---

## garrytan/gstack — Role-Based Specialists

**Source:** https://github.com/garrytan/gstack  
**Installed at:** `~/.claude/skills/gstack/`  
**What it is:** Garry Tan's (YC CEO) virtual engineering team. Each skill activates a specialist persona. MIT licensed. ~50K stars.

### Full Skill List

**Sprint workflow (in order):**
| Skill | Persona | What it does |
|---|---|---|
| `/office-hours` | YC Office Hours | 6 forcing questions, reframes product, writes design doc |
| `/plan-ceo-review` | CEO/Founder | Challenges scope, 4 modes (Expansion/Selective/Hold/Reduction) |
| `/plan-eng-review` | Eng Manager | Architecture, data flow, ASCII diagrams, test matrix |
| `/plan-design-review` | Senior Designer | 0-10 scoring per design dimension |
| `/autoplan` | Pipeline | Runs CEO → design → eng review automatically |
| `/design-consultation` | Design Partner | Full design system from scratch, DESIGN.md |
| `/design-shotgun` | Design Explorer | 4-6 image variants, comparison board |
| `/design-html` | Design Engineer | Mockup → production HTML/CSS, zero-deps |
| `/review` | Staff Engineer | Multi-pass diff review, auto-fixes obvious issues |
| `/design-review` | Designer Who Codes | Live review + atomic fixes |
| `/investigate` | Debugger | Root-cause debugging, no fix without investigation |
| `/qa` | QA Lead | Real browser, clicks flows, fixes bugs |
| `/qa-only` | QA Reporter | Same as /qa, report-only |
| `/ship` | Release Engineer | Sync main, tests, coverage audit, push, open PR |
| `/land-and-deploy` | Release Engineer | Merge PR, wait for CI, verify production |
| `/canary` | SRE | Post-deploy monitoring loop |
| `/benchmark` | Perf Engineer | Core Web Vitals baseline + before/after |
| `/document-release` | Technical Writer | Updates all docs to match shipped diff |
| `/retro` | Eng Manager | Weekly retro, per-person breakdowns |
| `/health` | Staff Engineer | Code quality dashboard (tests, types, lint, dead code) |

**Safety tools:**
| Skill | What it does |
|---|---|
| `/careful` | PreToolUse advisory on destructive bash |
| `/freeze` | Locks edits to one directory |
| `/guard` | /careful + /freeze combined |
| `/unfreeze` | Remove /freeze |
| `/codex` | Second opinion from OpenAI Codex |
| `/cso` | OWASP Top 10 + STRIDE threat model |

**Browse:**
| Skill | What it does |
|---|---|
| `/browse` | Real Chromium browser |
| `/connect-chrome` | Connect to existing Chrome session |
| `/setup-browser-cookies` | Import cookies from real browser |

**Meta:**
| Skill | What it does |
|---|---|
| `/learn` | Session memory management |
| `/gstack-upgrade` | Self-updater |
| `/checkpoint` | Workflow state checkpointing |

### How to View gstack Files

```bash
# All gstack skills
ls ~/.claude/skills/gstack/

# Read a specific skill
cat ~/.claude/skills/gstack/ship/SKILL.md

# gstack CLAUDE.md (dev commands, contribution guide)
cat ~/.claude/skills/gstack/CLAUDE.md
```

### Upgrade

```bash
/gstack-upgrade
# or manually:
cd ~/.claude/skills/gstack && git pull && ./setup
```

---

## gsd-build/get-shit-done — Workflow & Context Engineering

**Source:** https://github.com/gsd-build/get-shit-done  
**Installed at:** `~/.claude/skills/gsd-*/` (each skill is a separate directory)  
**Hooks at:** `~/.claude/hooks/gsd-*.{js,sh}`  
**What it is:** Context engineering framework. Prevents context rot, enforces spec-driven workflow. ~35K stars.

### Key GSD Skills (that Vanta uses)
| Skill | What Vanta calls it for |
|---|---|
| `/gsd-new-project` | `/vanta` bootstrap path |
| `/gsd-plan-phase` | Phase planning in `/vanta` |
| `/gsd-extract_learnings` | Step 1 of `/vanta-sync` |
| `/gsd-ship` | Signal for Vanta to suggest `/vanta-sync` |
| `/gsd-resume-work` | Mid-session state recovery |

### GSD Hooks (running in this setup)
| Hook | When | Effect |
|---|---|---|
| `gsd-prompt-guard.js` | PreToolUse Write/Edit | Blocks writes during wrong phase |
| `gsd-read-guard.js` | PreToolUse Write/Edit | Read-before-write enforcement |
| `gsd-workflow-guard.js` | PreToolUse Write/Edit | Phase discipline |
| `gsd-validate-commit.sh` | PreToolUse Bash | Commit message format |
| `gsd-context-monitor.js` | PostToolUse | Context window usage |
| `gsd-read-injection-scanner.js` | PostToolUse Read | Prompt injection detection |
| `gsd-phase-boundary.sh` | PostToolUse Write/Edit | Phase transitions |
| `gsd-session-state.sh` | SessionStart | Loads session state |
| `gsd-statusline.js` | Status line | Shows current phase |

---

## obra/superpowers — TDD-First Process Enforcement

**Source:** https://github.com/obra/superpowers  
**Installed at:** `~/.claude/plugins/cache/claude-plugins-official/superpowers/` (plugin, not skills dir)  
**What it is:** Rigid TDD workflow. Brainstorm → spec → plan → subagent-driven execution. ~94K stars.

### Skills it adds
- `/brainstorm` — design through dialogue, writes spec doc
- `/write-plan` — detailed implementation plan
- `/execute-plan` — subagent-driven task execution

---

## How Vanta Maps to All Three

```
Vanta              →  Under the hood
─────────────────     ──────────────────────────────────────────────
/vanta bootstrap   →  GSD: /gsd-new-project + /gsd-plan-phase
/vanta resume      →  GSD: reads .planning/ directly
/vanta-sync        →  GSD: /gsd-extract_learnings → vinamr-invariants.md
/council           →  Multi-CLI MCP: mcp__Multi-CLI__Ask-Gemini + Ask-Codex
```

**gstack specialists you should invoke directly** (don't go through Vanta):
- `/ship` — when ready to merge and deploy
- `/qa` — browser-based flow testing
- `/review` — pre-merge diff review
- `/investigate` — root-cause debugging
- `/office-hours` — product direction reset
- `/health` — code quality dashboard
- `/cso` — security audit
