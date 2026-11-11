<!-- fosh-routing:start -->
## Model routing (fosh-routing; takes precedence over any other routing table)

| Phase | Who | How |
|---|---|---|
| Brainstorm and plan | Fable | Spawn `subagent_type: "fable-planner"`. It writes `docs/brainstorms/...-requirements.md` and `docs/plans/...-plan.md`. |
| Orchestrate, integrate, review | Opus | The main session. Its model is pinned in `.claude/settings.local.json`. |
| Implement | Sonnet | Spawn `subagent_type: "sonnet-implementer"` with `isolation: "worktree"`. Name the plan file and the unit in the prompt. It does not commit. |
| Git: commit, merge, push, worktree cleanup | Haiku | Spawn `subagent_type: "haiku-git"` with exact paths, messages and branch. It pushes only when the brief says the user confirmed that push. |

- **Every feature gets a written plan first; Fable writes it unless the change is trivial** (1-2 files, no new or changed shared interface, no lead-owned file, no open design question). For a trivial change the lead writes a short one-unit `docs/plans/<date>-<topic>-plan.md` itself. When unsure, use `fable-planner`. Never brief an implementer from a design that isn't in a plan file.
- The agents pin the aliases `fable`, `opus`, `sonnet` and `haiku`, which resolve to the newest model of each family.
- Commit the plan before spawning implementers; worktrees only see committed files.
- The lead owns shared files (entry points, registries, generated docs, README, manifests, lockfiles); units return snippets for the lead to splice.
- The models are pinned by the agent definitions in `.claude/agents/`, so don't pass a `model` override.
- A PreToolUse hook (`.claude/hooks/agent-routing.mjs`) blocks any other agent type, a wrong model, and an implementer spawn whose prompt doesn't cite `docs/plans/*.md`. Read-only helpers (`Explore`, `claude-code-guide`, `fork`, `statusline-setup`) stay allowed.
<!-- fosh-routing:end -->
