#!/usr/bin/env python3
"""Install fosh-routing (Fable plans, Opus orchestrates, Sonnet implements,
Haiku does git) into a Claude Code project.

Idempotent and additive:
  - copies assets/agents/*.md to <project>/.claude/agents/ and
    assets/hooks/agent-routing.mjs to <project>/.claude/hooks/
    (a differing existing file is kept and its diff printed, unless --force);
  - adds a PreToolUse hook (matcher "Agent") to .claude/settings.json if no
    hook already runs agent-routing.mjs;
  - sets "model": "opus" in .claude/settings.local.json if no model is set,
    and lists that file in .gitignore;
  - writes assets/claude-md-section.md into CLAUDE.md between
    fosh-routing:start / fosh-routing:end markers (replaced on re-run).

Usage: install_routing.py --project DIR [--dry-run] [--force]
Exit:  0 done (or nothing to do), 1 refused or failed, 2 usage error.
"""
from __future__ import annotations

import argparse
import difflib
import json
import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
ASSETS = SKILL / "assets"
HOOK_NAME = "agent-routing.mjs"
HOOK_CMD = 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/agent-routing.mjs"'
START, END = "<!-- fosh-routing:start -->", "<!-- fosh-routing:end -->"


class Plan:
    def __init__(self, dry: bool):
        self.dry = dry
        self.actions: list[str] = []

    def write(self, path: Path, text: str, why: str) -> None:
        self.actions.append(f"{'would write' if self.dry else 'wrote'} {path} ({why})")
        if not self.dry:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")


def copy_asset(plan: Plan, src: Path, dst: Path, force: bool) -> bool:
    new = src.read_text(encoding="utf-8")
    if dst.exists():
        old = dst.read_text(encoding="utf-8")
        if old == new:
            plan.actions.append(f"unchanged {dst}")
            return True
        diff = "".join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), str(dst), "fosh-routing"))
        if not force:
            print(f"kept {dst}: it differs from the skill's copy (re-run with --force to replace)\n{diff}")
            return False
        plan.write(dst, new, "replaced, --force")
        return True
    plan.write(dst, new, "new")
    return True


def load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8") or "{}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"error: {path} is not valid JSON ({exc}); fix it first")
    if not isinstance(data, dict):
        raise SystemExit(f"error: {path} must hold a JSON object")
    return data


def add_hook(plan: Plan, settings: Path) -> None:
    data = load_json(settings)
    pre = data.setdefault("hooks", {}).setdefault("PreToolUse", [])
    for entry in pre:
        for h in entry.get("hooks", []) if isinstance(entry, dict) else []:
            if HOOK_NAME in str(h.get("command", "")):
                plan.actions.append(f"unchanged {settings} (routing hook present)")
                return
    pre.append({"matcher": "Agent", "hooks": [{"type": "command", "command": HOOK_CMD, "timeout": 10}]})
    plan.write(settings, json.dumps(data, indent=2) + "\n", "PreToolUse Agent hook added")


def pin_model(plan: Plan, local: Path, root: Path) -> None:
    data = load_json(local)
    if "model" in data:
        plan.actions.append(f"unchanged {local} (model already '{data['model']}')")
    else:
        data["model"] = "opus"
        plan.write(local, json.dumps(data, indent=2) + "\n", "main session pinned to opus")
    ignore = root / ".gitignore"
    text = ignore.read_text(encoding="utf-8") if ignore.exists() else ""
    if ".claude/settings.local.json" not in text.split():
        sep = "" if text == "" or text.endswith("\n") else "\n"
        plan.write(ignore, text + sep + ".claude/settings.local.json\n", "local settings ignored")


def claude_md(plan: Plan, path: Path) -> None:
    block = f"{START}\n{(ASSETS / 'claude-md-section.md').read_text(encoding='utf-8').rstrip()}\n{END}\n"
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    if START in text and END in text:
        head, rest = text.split(START, 1)
        tail = rest.split(END, 1)[1].lstrip("\n")
        new = head + block + ("\n" + tail if tail else "")
    else:
        new = text + ("\n" if text and not text.endswith("\n\n") else "") + block
    if new == text:
        plan.actions.append(f"unchanged {path}")
    else:
        plan.write(path, new, "routing section")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", required=True, help="project root (the folder that holds .claude/)")
    ap.add_argument("--dry-run", action="store_true", help="print what would change, write nothing")
    ap.add_argument("--force", action="store_true", help="replace agent/hook files that differ")
    args = ap.parse_args(argv)

    root = Path(args.project).expanduser().resolve()
    if not root.is_dir():
        print(f"error: project folder not found: {root}", file=sys.stderr)
        return 2
    plan = Plan(args.dry_run)
    ok = True
    for src in sorted((ASSETS / "agents").glob("*.md")):
        ok &= copy_asset(plan, src, root / ".claude" / "agents" / src.name, args.force)
    ok &= copy_asset(plan, ASSETS / "hooks" / HOOK_NAME, root / ".claude" / "hooks" / HOOK_NAME, args.force)
    try:
        add_hook(plan, root / ".claude" / "settings.json")
        pin_model(plan, root / ".claude" / "settings.local.json", root)
        claude_md(plan, root / "CLAUDE.md")
    except SystemExit as exc:
        print(exc, file=sys.stderr)
        return 1
    print("\n".join(plan.actions))
    if not args.dry_run:
        print("next: open /hooks once (or restart) so the new hook loads, then check that spawning "
              "'general-purpose' is refused")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
