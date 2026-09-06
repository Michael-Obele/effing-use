# Releasing effing-use

Publishing is automated via GitHub Actions + npm **Trusted Publishing** (OIDC)
with **provenance** (sigstore) attestations — no long-lived npm tokens anywhere.

## One-time setup: npm Trusted Publisher

1. Go to the package settings: `https://www.npmjs.com/package/effing-use/access`
   (the "Trusted Publisher" section lives on the **package** settings page, not
   the account settings page).
2. Click **GitHub Actions** under "Select your publisher".
3. Fill in (all case-sensitive, npm does **not** verify on save):
   - Organization or user: `Michael-Obele`
   - Repository: `effing-use`
   - Workflow filename: `publish.yml`
   - Allowed actions: `npm publish`
4. (Recommended) set publishing access to the most restrictive option and
   require 2FA / disallow tokens.
5. If a publish later fails with an opaque 404 / `ENEEDAUTH`, re-check these
   exact values — npm only validates them at publish time.

## Release checklist — what to update on every new version

1. Bump `version` in `package.json` (semver).
2. Update the hardcoded `v0.x.y` install link in `README.md` (~line 11).
3. (Optional) add a `CHANGELOG.md` entry.
4. If you bumped the `playwright` dependency, users must re-run
   `bunx playwright install chromium --only-shell` (each Playwright version pins
   its own browser build).
5. Commit: `git commit -m "chore(release): bump to 0.1.2"`
6. Tag: `git tag -a v0.1.2 -m "0.1.2"`
7. Push: `git push origin master --tags`
8. `.github/workflows/publish.yml` (triggered by `v*` tags) runs
   `npm publish --provenance` via trusted publishing — no token needed.
9. Verify on npm: version is live, provenance badge is present, `repository`
   points at `Michael-Obele/effing-use` (not litepilot).
10. If `.vscode/mcp.json` (or the global `mcp.json`) pins `effing-use@<version>`,
    bump the pin to the new version.

## Manual trigger

The workflow also accepts `workflow_dispatch` — it publishes whatever version is
in `package.json` (no tag needed). On tag pushes it refuses to publish if the
tag doesn't match `package.json`'s version.

## How it works

- `permissions.id-token: write` lets GitHub mint an OIDC token.
- npm CLI ≥ 11.5.1 (we install `npm@latest` in the workflow) exchanges it for a
  short-lived npm token — this is what the Trusted Publisher authorizes.
- `publishConfig.provenance: true` + `--provenance` attach sigstore attestations.
- `repository.url` must exactly match the GitHub repo (it does:
  `git+https://github.com/Michael-Obele/effing-use.git`).
- GitHub-hosted runner + public repo + public package are required for
  provenance.