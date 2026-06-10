<!-- Thanks for contributing to free-code! Keep the diff focused. -->

## What & why

<!-- What does this PR do, and why? Link any related issue. -->

## Type

- [ ] `feat` — new feature / reconstructed flag
- [ ] `fix` — bug fix
- [ ] `docs` — documentation
- [ ] `chore` / `refactor`

## If you reconstructed a feature flag

- **Flag:** `FLAG_NAME`
- **Files created:**
- **Verified with:** `bun run ./scripts/build.ts --dev --feature=FLAG_NAME` → clean build
- [ ] Added to `fullExperimentalFeatures` in `scripts/build.ts`
- [ ] `bun run build:dev:full` is green and `./cli-dev --version` boots
- [ ] Updated `FEATURES.md` / `CHANGELOG.md`

## Verification

<!-- How did you confirm this works? Build output, smoke test, screenshot. -->

## Checklist

- [ ] Conventional Commit message (`feat:` / `fix:` / `docs:` …)
- [ ] No new dependencies (or justified below)
- [ ] No secrets, no reintroduced telemetry
- [ ] Surgical diff — no unrelated refactors
