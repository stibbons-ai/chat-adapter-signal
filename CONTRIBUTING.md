# Contributing

## Releasing

Pushing a `v*` tag runs [`.github/workflows/publish.yml`](.github/workflows/publish.yml): it fails unless
the tag equals `v` + `package.json` `version`, then runs `npm ci`, `npm run check` and
`npm publish --provenance --access public`, authenticated through npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, no `NPM_TOKEN` secret).

1. Bump the version on a branch (updates `package.json` and `package-lock.json`, no git tag), and merge
   it through a PR as usual:

   ```sh
   npm version 0.2.0 --no-git-tag-version
   git commit -am "chore: release 0.2.0"
   ```

2. Tag the merged commit on `main` and push the tag:

   ```sh
   git switch main && git pull
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. Watch the Publish run in the Actions tab; the npm package page then shows the provenance badge.

A tag that doesn't match the version fails the run; delete it (`git push origin :refs/tags/vX.Y.Z`,
`git tag -d vX.Y.Z`), fix, and tag again. Stable versions only: a prerelease such as `0.2.0-beta.1`
fails at `npm publish`, which would need a `--tag` that the workflow doesn't pass.

Any `v*` tag on any commit publishes, so consider a GitHub tag ruleset that restricts who may create
`v*` tags.

### One-time setup on npmjs.com

A trusted publisher can only be added to a package that already exists on npm
([`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust)). Before the first tag-push release, a
maintainer of the `@stibbons` scope:

1. Publishes a placeholder `0.0.0` by hand, never the version about to be tagged (the tag-push publish
   of that version would then fail, and the hand-published one has no provenance). From a checkout of
   `main` with `version` still at `0.0.0`, or after `npm version 0.0.0 --no-git-tag-version` in a
   scratch copy:

   ```sh
   npm publish --access public
   npm deprecate @stibbons/chat-adapter-signal@0.0.0 "Placeholder, use 0.1.0 or later"
   ```

2. Adds the trusted publisher: package page → **Settings** → **Trusted publishing** → **GitHub Actions**,
   filled in exactly (case-sensitive; npm doesn't validate until the first publish):
   - Organization or user: `stibbons-ai`
   - Repository: `chat-adapter-signal`
   - Workflow filename: `publish.yml`
   - Environment name: leave empty
   - Allowed actions: enable **`npm publish`** (only `npm stage publish` is allowed by default)

   Or, with npm 11.15.0+:

   ```sh
   npm trust github @stibbons/chat-adapter-signal --repo stibbons-ai/chat-adapter-signal --file publish.yml --allow-publish
   ```

3. Pushes the release tag within 2 days: a new trusted-publisher configuration expires unless it
   completes a publish by then.

Requirements, per the npm docs ([trusted publishers](https://docs.npmjs.com/trusted-publishers),
[provenance](https://docs.npmjs.com/generating-provenance-statements)): npm CLI 11.5.1+, Node 22.14.0+,
a GitHub-hosted runner, `id-token: write`, and `repository.url` in `package.json` matching this
repository exactly. Provenance is only generated for a public repository.
