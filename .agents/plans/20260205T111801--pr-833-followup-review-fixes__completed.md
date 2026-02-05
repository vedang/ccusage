# Plan: PR #833 Follow-up Review Fixes

**Created:** 2026-02-05
**State:** Completed

## Objective

Address the latest CodeRabbit review comments added after the recent PR updates.

## Tasks

1. Align apps/opencode command cache token field names to use `cacheCreationInputTokens`/`cacheReadInputTokens`.
2. Use `mergedOptions.jq` for empty and non-empty session JSON rendering in apps/ccusage/src/commands/session.ts.
3. Replace invalid "gpt-5" test fixtures with valid LiteLLM model names in Codex tests.
4. Compute `totalTokens` after the loop in apps/pi/src/commands/daily.ts.
5. (Optional) Extract shared empty-totals helper in apps/pi/src/commands/session.ts (and reuse in daily/monthly if adopted).
6. Switch Codex session table totals to `totalCost`.
7. Switch Codex daily table totals to `totalCost`.
8. Remove redundant `cachedInputTokens` redeclaration from apps/codex/src/\_types.ts.
9. Raise docstring coverage to >=80% by adding missing docstrings.
10. Run formatting, typecheck, and tests.
11. Run required make targets (expecting no rule) and capture failures.

## Notes

- Follow test-first changes where applicable.
- Commit each task separately with issue references.
