---
name: fosh-routing
description: "Install and run Fable-Opus-Sonnet-Haiku model routing in a Claude Code project: Fable plans and brainstorms (fable-planner agent), the Opus main session orchestrates, integrates and reviews, Sonnet implements one plan unit per git worktree (sonnet-implementer), and Haiku does all git (haiku-git). Ships the three agent files, a PreToolUse spawn hook that blocks off-route agents, wrong model overrides and implementers without a plan, a CLAUDE.md section and an idempotent installer. Use when the user wants to set up model routing, route work by phase to stretch a subscription, 'Fable plans, Sonnet implements', or run a plan-then-parallel-implement loop with worktrees; also when running that loop and deciding who does what next."
argument-hint: "[install [--project DIR] [--dry-run]] | [run]"
---

# fosh-routing: Fable plans, Opus orchestrates, Sonnet implements, Haiku does git

| Phase | Who | How |
|---|---|---|
| Brainstorm and plan | Fable | `subagent_type: "fable-planner"`; writes `docs/brainstorms/<date>-<topic>-requirements.md` and `docs/plans/<date>-<topic>-plan.md` |
| Orchestrate, integrate, review | Opus | the main session (pinned with `"model": "opus"` in `.claude/settings.local.json`) |
| Implement | Sonnet | `subagent_type: "sonnet-implementer"`, `isolation: "worktree"`, prompt cites `docs/plans/<file>.md` and the unit |
| Git: commit, merge, push, worktree cleanup | Haiku | `subagent_type: "haiku-git"`, exact paths and messages; pushes only on the user's recorded OK |

The models are pinned in the agent files, so never pass a `model` override.
The pins are the aliases `fable`, `opus`, `sonnet` and `haiku`, which Claude
Code resolves to the newest model of each family, so a new release needs no
edit here. On 2026-11-10 they meant Fable 5.2, Opus 5.5, Sonnet 5.5 and
Haiku 5.5 (API list prices per MTok in/out: $8/$40, $4/$20, $2/$10,
$0.10/$0.50). To check, ask a spawned agent which model it runs on.
Effort is pinned the same way: `fable-planner` and `sonnet-implementer` run
at `medium`, `haiku-git` at `low`. The frontmatter overrides per-model levels
saved in the user's settings (only `CLAUDE_CODE_EFFORT_LEVEL` beats it); the
lead runs at the session's own level. For a large or risky feature, ask for
one planner spawn at `high` (per-spawn effort, Claude Code 2.1.292+) instead
of raising the pin.
Read-only helpers (`Explore`, `claude-code-guide`, `fork`,
`statusline-setup`) stay allowed.

## Install

```
python <this-skill-folder>/scripts/install_routing.py --project <project-root> [--dry-run] [--force]
```

It is idempotent and only adds things:

- copies `assets/agents/*.md` to `<project>/.claude/agents/` and
  `assets/hooks/agent-routing.mjs` to `<project>/.claude/hooks/`
  (an existing file that differs is kept unless `--force`; the diff is printed);
- appends a PreToolUse hook with matcher `Agent` to `.claude/settings.json`
  if no hook already runs `agent-routing.mjs`;
- sets `"model": "opus"` in `.claude/settings.local.json` if no model is set,
  and adds that file to `.gitignore`;
- appends `assets/claude-md-section.md` to `CLAUDE.md` between
  `fosh-routing:start` / `fosh-routing:end` markers (replaced on re-run).

After installing, tell the user to open `/hooks` once or restart the session,
because the settings watcher may not see a new hook mid-session. Check it by
spawning `general-purpose` once: the hook must refuse it.

Adjust per project: the plan path regex and the helper allow-list sit at the
top of `agent-routing.mjs`; the agents' folders (`docs/plans/`,
`docs/brainstorms/`) are in the agent files.

## Run the loop

1. **Every feature gets a written plan first; Fable writes it unless the
   change is trivial.** Fable costs about twice Opus, so for a trivial change
   (1-2 files, no new or changed shared interface, no lead-owned file, no
   open design question) the lead writes a short
   `docs/plans/<date>-<topic>-plan.md` itself: one unit, owned files, test,
   live check. Anything bigger or unsure goes to `fable-planner`. Never brief
   an implementer from a design that isn't in a plan file.
2. **Brief the planner** with: goal, files to read, what already exists, the
   lead-owned files, safety rules, and how decisions are made. Ask for units
   with non-overlapping owner files, frozen shared interfaces, a merge order,
   tests and a live check per unit, and open questions.
3. **Relay open questions** with AskUserQuestion (recommended option first).
   Send the answers back to the planner (SendMessage) so the plan records
   them in a "Decisions" section. If the user will be away, save their
   standing answers in memory and tell planners to write their recommended
   defaults as decisions instead of leaving blocking questions.
4. **Commit the plan before spawning implementers.** Worktrees branch from a
   commit; an untracked plan is invisible to them.
5. **Lead pre-steps first.** Any edit to a shared file the plan lists as a
   pre-step (types, enums) is done, built, tested and committed by the lead
   before units branch.
6. **Spawn all independent units in one message**, each `isolation:
   "worktree"`, `run_in_background: true`, with a name like `impl-<unit>`.
   Each brief: plan path and unit, base commit, owned files only, the
   lead-owned files it must not touch, test command, safety rules, "do not
   commit", and "SendMessage main with worktree path, files, test counts,
   live results, deviations and exact splice snippets".
7. **Integrate in the plan's merge order** as reports arrive: copy the unit's
   files into the main checkout, splice its snippets into the lead-owned
   files, build, run the full test suite, look at real outputs yourself, then
   hand the commit to `haiku-git` with exact paths and message. Commit before
   copying the next unit's changes to tracked files, so one commit's
   "stage everything under X" can't sweep in the next unit.
8. **Clean up**: the same `haiku-git` brief removes the unit's worktree and
   branch. Tell it explicitly that main's copies are authoritative, or it
   will (correctly) stop on files that differ.
9. **Release**: `haiku-git` pushes only when its brief quotes the user's OK.
   If a permission prompt or classifier blocks the push, stop and leave it to
   the user; never route around it, and never ask another agent to do it.

Details, briefs and pitfalls: [references/playbook.md](references/playbook.md).
