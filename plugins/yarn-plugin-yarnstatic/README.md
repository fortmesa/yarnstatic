# yarn-plugin-yarnstatic

A Yarn Berry plugin that lets `yarn install --immutable` run with no
network access, by serving npm tarball downloads from a private S3 bucket
(via the `yarnstatic` Go binary) instead of the real registry. See
[`../../docs/plugin.md`](../../docs/plugin.md) for how it works internally.

## Build

```sh
yarn install
yarn build
```

Produces `bundles/@yarnpkg/plugin-yarnstatic.js` - a minified, comment-stripped
bundle (built via `@yarnpkg/builder`, same as
[`../yarn-plugin-yarnstatic-s3`](../yarn-plugin-yarnstatic-s3)). This has no
external dependency to inline (only Node built-ins and `@yarnpkg/core`,
both left external), so the build's only value is a smaller, comment-free
distributable - functionally identical to `sources/index.js`.

## Install

Per-project (most common), using either `yarn plugin import` against the
built bundle:

```sh
yarn plugin import /path/to/bundles/@yarnpkg/plugin-yarnstatic.js
```

or by hand:

1. Copy `bundles/@yarnpkg/plugin-yarnstatic.js` into your project as `.yarn/plugins/plugin-yarnstatic.cjs`.
2. Add it to your project's `.yarnrc.yml`:

   ```yaml
   plugins:
     - path: .yarn/plugins/plugin-yarnstatic.cjs
       spec: "https://internal.example.com/yarn-plugin-yarnstatic"
   ```

   (`spec` is just a description of where the file came from - it's not
   fetched at runtime.)

Machine-wide, for every project a user/CI image touches (e.g. baked into a
shared CI base image):

```yaml
# ~/.yarnrc.yml
plugins:
  - path: /opt/yarnstatic/plugin-yarnstatic.cjs
    spec: "yarnstatic (global install)"
```

Yarn reads `~/.yarnrc.yml` in addition to the project's own, and merges
`plugins:` entries from both rather than overriding - so a home-directory
install applies to every project without touching each repo's own
`.yarn/plugins/`. Since the plugin is a complete no-op unless
`YARNSTATIC_BUCKET` is set, this is safe to leave installed everywhere and
opt in per-build via the environment instead.

One caveat: a globally-installed plugin runs inside whichever
`.yarn/releases/yarn-X.Y.Z.cjs` each individual project has pinned. This
plugin only uses the documented, stable `wrapNetworkRequest` hook (not
internal APIs), so it should be broadly compatible across Yarn Berry
versions, but if you maintain a fleet of repos on very different Yarn
versions, spot-check this on each.

## Requirements

- The `yarnstatic` binary must be reachable. The plugin looks for it, in
  order: the `YARNSTATIC_BIN` env var, `<project>/node_modules/.bin/yarnstatic`,
  `$GOBIN`/`$GOPATH/bin`/`~/go/bin`, `~/.yarn/bin/yarnstatic`,
  `~/.local/bin/yarnstatic`, then falls back to `yarnstatic` on `PATH`.
- AWS credentials must be resolvable by the standard AWS SDK credential
  chain (env vars, shared config/profile, IAM role) wherever `yarn install`
  runs - the plugin's daemon does not accept credentials directly.

## Enable

Export `YARNSTATIC_BUCKET` (and optionally `YARNSTATIC_KEY_PREFIX`,
`YARNSTATIC_REGION`, `YARNSTATIC_ENDPOINT`, `YARNSTATIC_PROFILE`) before
running `yarn install`:

```sh
export YARNSTATIC_BUCKET=my-verdaccio-bucket
yarn install --immutable
```

Leaving `YARNSTATIC_BUCKET` unset makes the plugin a complete no-op - normal
online installs are unaffected.

See [`../../docs/cli.md`](../../docs/cli.md) for the full environment
variable / flag reference, and run `yarnstatic check --bucket <bucket>`
first to verify every package your lockfile needs is actually present in
the bucket before relying on this for an offline install.

## Scope storage overrides

If your Verdaccio has a `packages['@scope/*'].storage` override configured
for any scope, add a matching entry to your project's `.yarnrc.yml`:

```yaml
yarnstaticScopeStorage:
  myscope: myscope-storage-folder
```

Key by the scope name without the leading `@`; the value is whatever
`storage:` value that scope has in Verdaccio's own config - only your
Verdaccio admin config knows this, so it can't be inferred automatically.
`yarnstatic check` reads this same key straight out of `.yarnrc.yml`, so
one entry covers both. See
[`../../docs/plugin.md`](../../docs/plugin.md#scope-storage-overrides-yarnstaticscopestorage)
for the full mechanism. If no scope you use has this override (the common
case), you don't need this setting at all.
