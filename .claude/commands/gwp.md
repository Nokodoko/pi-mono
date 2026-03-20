---
description: "Git workflow + push (fork sync) — fetch upstream, merge, commit, and push to fork"
allowed_flags: ["merge", "pr"]
---

> **Project-specific override** for `pi-mono`. This replaces the global `/gwp`
> when invoked inside this repository. The global `/gwp` remains unchanged for
> all other projects.

Spawn a **git-agent** subagent to handle the fork-sync + push workflow.

## Remote Layout

| Remote   | URL                                           | Role           |
|----------|-----------------------------------------------|----------------|
| `origin` | `https://github.com/badlogic/pi-mono.git`    | Upstream source |
| `fork`   | `git@github.com:Nokodoko/pi-mono.git`        | User's fork     |

## Flags

- `--merge`: After pushing to `fork`, merge the current branch into main (or the base branch) **on the fork**. The subagent checks out the base branch, runs `git merge --no-ff <source-branch>`, pushes to `fork`, then checks the source branch back out.
- `--pr`: After pushing to `fork`, create a pull request for the current branch using `gh pr create`. The subagent auto-fills the PR title from the latest commit subject and generates a summary body from the branch's commits.

These flags are mutually exclusive — only one post-push action at a time.

## Procedure

1. Use the **Task** tool with the following parameters:
   - `description`: "git-agent: fork-sync — fetch upstream, merge, commit, push to fork"
   - `prompt`: Include the full git-agent role from `/home/n0ko/.claude/plugins/git-agent/agents/git-agent.md`, then instruct it to execute the fork-sync workflow below. If `$ARGUMENTS` is non-empty (excluding flags), tell the agent to only stage/commit files matching that scope.

### Fork-Sync Workflow

The git-agent subagent executes these steps in order:

1. **Stage and commit local changes** — Run the standard "Workflow: Creating Commits" to capture any uncommitted work before syncing.
2. **Fetch upstream** — `git fetch origin` to pull the latest refs from the upstream repository.
3. **Merge upstream into current branch** — `git merge origin/main` (or the appropriate upstream branch).
   - If merge conflicts occur, **stop and report the conflicts to the user**. List the conflicting files and await resolution. Do NOT auto-resolve or force-complete the merge.
4. **Push to fork** — `git push fork` to push the merged state to the user's fork remote.
   - If the push is rejected (e.g., diverged history), report the issue. Do NOT force-push without explicit user approval.
5. **Post-push action** (if flagged):
   - If `--merge` flag is set: determine the base branch (default: `main`), check it out, merge the current branch with `git merge --no-ff`, push the base branch to `fork`, then check the source branch back out.
   - If `--pr` flag is set: create a pull request via `gh pr create`. Use the latest commit subject as the PR title. Generate a summary body from `git log main..HEAD --oneline`. Include the PR URL in the final summary.

2. Wait for the subagent to return.
3. Relay its summary to the user, including:
   - Commits pulled from upstream (count + range)
   - Any conflicts encountered and their resolution status
   - Push result (success / rejected)
   - Post-push action result (if applicable)

## Git Commit Discipline

Each work track, feature, or task MUST produce its own independent, scoped git commit.
- Do NOT bundle multiple tracks/features into a single commit
- Each commit message should reference only the specific track/task it implements
- Stage only files relevant to the specific track being committed

## Rules

- The git-agent subagent does all git operations — the orchestrator does NOT run git commands directly.
- One layer of nesting: orchestrator -> git-agent subagent.
- The subagent inherits hooks, so `git-commit-prompt.py` fires on completion.
- `--merge` and `--pr` are mutually exclusive. If both are passed, prefer `--pr` and warn the user.
- Always push to `fork`, never to `origin`. The upstream repo is read-only for this workflow.
- Always fetch from `origin` to get upstream changes.
