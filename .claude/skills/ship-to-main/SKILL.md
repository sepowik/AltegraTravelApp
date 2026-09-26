---
name: ship-to-main
description: Finish a change to the Travel Expenses app and put it live. Use whenever a feature, fix or other change in this repo is done. It validates the change, pushes it to the working branch, fast-forwards main without asking the user, and confirms the GitHub Pages deploy. Also use when the user says "ship it", "update main", "publish" or "put it live".
---

# Ship to main

The user has asked for finished work to go live on `main` **without asking first**. Pushing to `main` triggers `.github/workflows/pages.yml`, which runs the tests and publishes the app to https://sepowik.github.io/AltegraTravelApp/ (the app on the user's phone updates from there).

Only ship work that is finished and validated. If a step below fails, fix it or stop and report; never push a red or half-done change to `main`.

## 1. Validate

1. `npm test`, and all tests must pass.
2. If app files changed, drive the real app in headless Chromium at phone size (Playwright, `devices['Pixel 7']`), served with `python3 -m http.server`. Exercise the changed flow and confirm there are no page or console errors. Look at a screenshot of any changed screen.
3. If you added, renamed or removed files under `index.html`, `css/`, `js/`, `icons/` or `manifest.webmanifest`, update `SHELL` in `sw.js`. Bump `VERSION` in `sw.js` whenever app-shell files change so phones pick up the update.
4. New UI text goes through `t()` in `js/i18n.js` with an entry for every language in `DICTIONARIES` (en, sv, de, es, hi, ta). `tests/i18n.test.js` fails if a language is missing a key.
5. If you added a new top-level folder that the site needs, add it to the `cp -r ...` line in `.github/workflows/pages.yml`.
6. Re-read the diff for anything that would break the deploy or leak data (for example, secrets or personal data in committed files).

## 2. Commit and push the working branch

Commit with a descriptive message plus the attribution lines from the session's system reminder. Then run `git push -u origin <working-branch>`. Retry up to 4 times with 2s/4s/8s/16s backoff only on network errors.

## 3. Fast-forward main (no confirmation needed)

```sh
git fetch origin main
git merge-base --is-ancestor origin/main HEAD && git push origin HEAD:main
```

If `main` has moved and is not an ancestor, merge `origin/main` into the working branch (never rebase or force-push `main`), re-run step 1, push the branch, then push `HEAD:main`.

## 4. Confirm the deploy

Wait about 90 s. Use a background `sleep`; a foreground sleep is blocked. Then read the latest workflow run with the GitHub MCP tool `mcp__github__actions_list` (`method: list_workflow_runs`, owner `sepowik`, repo `AltegraTravelApp`, `perPage: 1`). Check that its `head_sha` matches the pushed commit.

- `success`: tell the user it's live. To get the update, they open the app with internet; if they still see the old version, they close the app fully and reopen it.
- `failure`: read the logs (`mcp__github__get_job_logs` with `failed_only: true`), fix, and ship again. A deploy job that fails in about 2 s without logs usually means the `github-pages` environment's deployment-branch rule doesn't allow `main` (Settings → Environments → github-pages). The user has to fix that; tell them exactly where.

The container can't reach `*.github.io`, so check the run status rather than fetching the site.
