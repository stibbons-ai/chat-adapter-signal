# Contributing

## Checks

```sh
npm ci
npm run check   # typecheck, tests, npm pack --dry-run
```

## Releasing

Pushing a `v*` tag runs [`.github/workflows/publish.yml`](.github/workflows/publish.yml): it checks that
the tag equals `v` + `package.json` `version` (and fails before publishing if not), then runs `npm ci`,
`npm run check` and `npm publish --provenance --access public`. It authenticates through npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC), so there is no `NPM_TOKEN` secret.

1. Bump the version on a branch (updates `package.json` and `package-lock.json`, no git tag):

   ```sh
   npm version 0.2.0 --no-git-tag-version
   git commit -am "chore: release 0.2.0"
   ```

   Merge that through a PR as usual.

2. Tag the merged commit on `main` and push the tag:

   ```sh
   git switch main && git pull
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. Watch the Publish run in the Actions tab; the package page on npmjs.com then shows the provenance badge.

A tag that doesn't match the version fails the run; delete it (`git push origin :refs/tags/vX.Y.Z`,
`git tag -d vX.Y.Z`), fix, and tag again.

### One-time setup on npmjs.com

Done once by a maintainer of `@stibbons/chat-adapter-signal` on npmjs.com:

1. Package page → **Settings** → **Trusted publishing** → **GitHub Actions**.
2. Fill in exactly (case-sensitive; npm doesn't validate until the first publish):
   - Organization or user: `stibbons-ai`
   - Repository: `chat-adapter-signal`
   - Workflow filename: `publish.yml`
   - Environment name: leave empty
   - Allowed actions: enable **`npm publish`** (only `npm stage publish` is allowed by default)
3. Save. A new trusted-publisher configuration expires unless it completes a publish within 2 days, so
   push the release tag soon after.

The npm docs only describe configuring this from an existing package's settings page. If
`@stibbons/chat-adapter-signal` isn't on npm yet and npmjs.com offers no way to add a trusted publisher
for it, publish the first version another way (e.g. `npm publish --access public` by a maintainer),
then configure trusted publishing for the following releases.

Requirements, per the npm docs ([trusted publishers](https://docs.npmjs.com/trusted-publishers),
[provenance](https://docs.npmjs.com/generating-provenance-statements)): npm CLI 11.5.1+, Node 22.14.0+,
a GitHub-hosted runner, `id-token: write`, and `repository.url` in `package.json` matching this
repository exactly. Provenance is only generated for a public repository.
