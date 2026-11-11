# fosh-routing playbook

Lessons from running the loop for several feature rounds with 4-6 parallel
implementers. Read the section you need.

## Ownership

- The lead (main session) owns every shared file: the entry point that
  registers commands, registries and indexes, generated docs, README,
  package manifests and lockfiles, shared type files. Units never edit them;
  they return exact snippets for the lead to splice.
- A unit may own an existing file only if no other unit in the round touches
  it. Say so in the plan.
- One writer per worktree. Read-only research may run in parallel.

## Briefs that work

Planner brief:
- goal and product constraints; files to read; what already exists;
- lead-owned file list; safety rules; output paths;
- "every open item: recommend a default" when the user is away;
- "SendMessage main with units (owner files, dependencies, merge order),
  lead pre-steps, decisions, assumptions".

Implementer brief:
- `Implement unit <id> of docs/plans/<file>.md. Base commit: <sha>.`
- owned files; lead-owned files it must not touch; how to run tests in a
  worktree (dependencies may be missing; symlink them from the main checkout
  and remove the link after);
- the user decisions that affect this unit;
- safety rules for shared external resources;
- "Do not commit"; the exact report it must send.

Git brief:
- repo, branch, "do not push" (or the quoted user OK);
- per commit: exact paths and exact message, "no trailer";
- worktrees to remove and that main's copies are authoritative;
- what to report: `git log --oneline -3`, `git status --short`,
  `git worktree list`.

## Integration pitfalls

- **Tests that assume "not spliced yet".** A unit test asserting its symbols
  are absent from the combined registry fails the moment the lead splices.
  Tell implementers to write collision checks as "declared at most once".
- **Coverage tests over registries.** If a test derives command names from a
  docs table, new rows must use the same shape as existing ones.
- **Fixtures that build trees.** Nested output paths need parent folders
  created in test fixtures.
- **Tests with side effects.** A test that executes example commands can
  write into the repo (e.g. an `init` command). Find it by running each test
  file alone and checking `git status`; exclude side-effect examples.
- **Stray files.** After every merge run `git status`; anything untracked
  you did not expect gets traced before committing.
- **Parallel dependants.** If unit B calls unit A's function, freeze A's
  signature in the plan, let B test against a stub, merge A first, and run
  B's live check after A lands.

## Shared external resources

When units share one external app, database or device:
- address objects by ID, never "current";
- never run actions that can block on an interactive dialog;
- write live output inside the project, outside hidden folders if the app
  refuses hidden paths (worktrees live under `.claude/worktrees/`, so point
  live output at the main checkout);
- on a timeout, stop all live work, record it, continue only offline work.

## Unattended runs

- Ask every decision up front with AskUserQuestion, recommended option first,
  including release permission and what to cut first.
- Save the answers in a memory file and the project's handoff doc.
- Planners write recommended defaults as decisions.
- Keep the handoff updated after each merge: commits, verified facts,
  deviations, what still needs the user's hands.

## Push permission

- `haiku-git` pushes only when the brief quotes the user's confirmation.
- Auto-mode classifiers may block a push even with confirmation. Do not
  retry or work around it; leave the exact command for the user
  (`! <command>`), or, only if the user asks, add an allow rule for that exact
  command in `.claude/settings.local.json`.
