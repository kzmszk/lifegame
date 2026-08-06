# Issue tracker: Beads

Issues and specs for this repository live in the local Beads database under `.beads/`. Use the `bd` CLI for all issue operations.

## Conventions

- Create an issue with `bd create --title="..." --description="..." --type=task|bug|feature --priority=2`.
- Read an issue with `bd show <id>`.
- List ready work with `bd ready`.
- List issues by state with `bd list --status=open` or `bd list --status=in_progress`.
- Claim an issue atomically with `bd update <id> --claim`.
- Add or remove triage labels with `bd label add <id> <label>` and `bd label remove <id> <label>`.
- Add blocking dependencies with `bd dep add <issue> <depends-on>`.
- Close completed work with `bd close <id> --reason="..."`.
- Use `bd remember "..."` for durable project knowledge.
- Do not edit `.beads/issues.jsonl` or treat it as the source of truth.
- Do not run `bd dolt push`, Git commits, or Git pushes without explicit authority.

## When a skill says "publish to the issue tracker"

Create a Beads issue with a complete title and description. Use `--parent=<id>` for child work and `--labels=<labels>` for workflow labels.

## When a skill says "fetch the relevant ticket"

Run `bd show <id>`.

## Wayfinding operations

Used by `/wayfinder`. The map is a parent Beads issue with child issues as tickets.

- **Map:** an epic labelled `wayfinder:map`, containing Notes, Decisions-so-far, and Fog in its description or notes.
- **Child ticket:** an issue created with `--parent=<map-id>` and labelled `wayfinder:<type>`, where type is `research`, `prototype`, `grilling`, or `task`.
- **Blocking:** use native Beads dependencies with `bd dep add <child> <blocker>`.
- **Frontier:** use `bd list --parent=<map-id> --ready` and select the first unclaimed issue.
- **Claim:** run `bd update <id> --claim` before beginning work.
- **Resolve:** append the answer with `bd update <id> --append-notes="..."`, close the issue, and record a concise context pointer in the map's notes.
