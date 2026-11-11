#!/usr/bin/env node
// PreToolUse hook for the Agent tool (installed by the fosh-routing skill). It
// enforces the model routing:
// Fable plans (fable-planner), Opus orchestrates (the main session) and Sonnet
// implements (sonnet-implementer, only from a plan under docs/plans/) and
// Haiku handles git (haiku-git).
// Read-only helper agents are allowed. Exit 2 blocks the spawn, and stderr
// tells the orchestrator why.

import { readFileSync } from "node:fs";

// Edit these two lines per project.
const PLAN_PATH = /docs\/plans\/[^\s'"]+\.md/;
const ALLOWED_HELPERS = new Set(["Explore", "claude-code-guide", "fork", "statusline-setup", "vision-reviewer"]);
const ROLES = {
  "fable-planner": { model: "fable" },
  "sonnet-implementer": { model: "sonnet", needsPlan: true },
  "haiku-git": { model: "haiku" },
};

function deny(reason) {
  process.stderr.write(`model-routing: ${reason}\n`);
  process.exit(2);
}

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0); // Malformed hook input: don't block the session.
}

const tool = input.tool_input ?? {};
const type = tool.subagent_type ?? "general-purpose";
const model = tool.model;
const prompt = String(tool.prompt ?? "");

if (ALLOWED_HELPERS.has(type)) process.exit(0);

const role = ROLES[type];
if (!role) {
  deny(
    `subagent_type '${type}' is not part of this project's routing. Use 'fable-planner' to brainstorm or plan, ` +
      `'sonnet-implementer' to build from a plan, 'haiku-git' for commits and pushes, or a read-only helper (${[...ALLOWED_HELPERS].join(", ")}).`,
  );
}
if (model && model !== role.model) {
  deny(`${type} runs on ${role.model}; drop the model override '${model}'.`);
}
if (role.needsPlan && !PLAN_PATH.test(prompt)) {
  deny("sonnet-implementer needs a plan: cite the plan file (docs/plans/<...>.md) and the unit in the prompt. Plan first with fable-planner.");
}
process.exit(0);
