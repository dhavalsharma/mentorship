# Opening this in your IDE and pushing it to GitHub

This archive is a **complete git repository**, not loose files — the `.git`
directory is included, with one commit already on `main`. So nothing needs
re-initialising.

## 1. Extract and open

```bash
cd ~/Downloads
tar -xzf mentorship-repo.tar.gz
cd mentorship

git log --oneline     # should show one commit on main
```

Then open it however you like:

```bash
code .        # VS Code
cursor .      # Cursor
idea .        # IntelliJ / WebStorm
```

## 2. Check it runs

```bash
pnpm install    # or: npm install --legacy-peer-deps
pnpm test       # 78 tests, ~2s
pnpm demo       # the full session cycle, printed as a trace
pnpm typecheck
```

`pnpm` is what the workspace is set up for (`pnpm-workspace.yaml`). If you
don't have it: `corepack enable && corepack prepare pnpm@latest --activate`.

## 3. Push to GitHub

With the GitHub CLI, one command creates the repo and pushes:

```bash
gh repo create mentorship-kernel --private --source=. --remote=origin --push
```

Swap `--private` for `--public` when you're ready. Without `gh`, create the
empty repo in the GitHub UI first (no README, no .gitignore — this repo has
both), then:

```bash
git remote add origin git@github.com:<your-org>/mentorship-kernel.git
git push -u origin main
```

## Before you make it public

Two things are deliberately unfinished, both flagged in their own files:

1. **`LICENSE` is a header, not the full Apache-2.0 text.** Replace it with
   the text from <https://www.apache.org/licenses/LICENSE-2.0.txt>. GitHub
   won't detect the licence from the short notice, and the patent grant that
   makes Apache-2.0 the right choice for a project others build on lives in
   the full text.

2. **The README's status table is honest about what is and isn't built** —
   the Postgres schema has never had a migration applied, the Slack and Google
   adapters have never run against a live tenant, and session intelligence is
   a deterministic stub. Keep that table accurate as you go; it is the first
   thing a potential contributor reads.

## Suggested next commits

- Full licence text (above).
- CI: `.github/workflows/ci.yml` running `pnpm install --frozen-lockfile`,
  `pnpm typecheck`, `pnpm test`. Cheap, and it keeps the 78 tests meaningful.
- `dependency-cruiser` config enforcing the package boundary rule in the
  README — the rule is only real if CI fails when it is broken.
