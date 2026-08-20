# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues in **`jennofrie/fexor-code`**. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

`gh` infers the repo from `git remote -v` when run inside this clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** This is a personal fork; external PRs are not a feature-request channel.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`. `gh issue create --label wayfinder:map`.
- **Child ticket**: linked to the map as a GitHub sub-issue; label `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`).
- **Blocking**: GitHub native issue dependencies (`gh api --method POST repos/jennofrie/fexor-code/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`).
- **Claim**: `gh issue edit <n> --add-assignee @me`.
- **Resolve**: comment the answer, close, append a pointer to the map's Decisions-so-far.
