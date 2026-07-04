# Verdaccio S3 key layout

`internal/verdaccio` computes S3 object keys matching the layout used by
the `verdaccio-aws-s3-storage` plugin (verified against its v12.1.1
source - `S3PackageManager.writeTarball`/`readTarball` and
`@verdaccio/core`'s `composeTarballFromPackage`). This has also been
confirmed directly against a real production bucket
(`fmdev-npmjs-storage`) via `aws s3 ls` - both the unscoped
(`lodash/lodash-4.18.1.tgz`) and scoped (`@babel/core/core-7.28.3.tgz`)
layouts, and a non-empty `keyPrefix` (`verdaccio/`) in active use - matched
`TarballKey`'s output exactly.

## Tarball keys

- Unscoped package `foo` version `1.2.3`:
  `<keyPrefix>foo/foo-1.2.3.tgz`
- Scoped package `@scope/foo` version `1.2.3`:
  `<keyPrefix>@scope/foo/foo-1.2.3.tgz`

Note that for scoped packages, the **directory** portion keeps the scope
(`@scope/foo/`) but the **basename** drops it (`foo-1.2.3.tgz`, not
`@scope/foo-1.2.3.tgz`) - this matches the real npm registry's own tarball
URL convention, which is why it also matches what Yarn's `NpmSemverFetcher`
requests (see [architecture.md](architecture.md) and
[protocol.md](protocol.md)).

`keyPrefix` (`YARNSTATIC_KEY_PREFIX` / `--key-prefix`) defaults to
`"verdaccio"`, matching our production bucket's layout - pass a different
value to override for a bucket that doesn't use that convention. Whatever
prefix is in effect is normalized to always end in `/` regardless of how
it was supplied.

## Scope storage overrides

Verdaccio's `packages['@scope/*'].storage` server-side config option
inserts an extra folder segment into the key layout for specific scopes -
confirmed directly against `verdaccio-aws-s3-storage` v12.1.1's
`S3PackageManager` constructor: when a package matches a `packages:` entry
with `storage` set, `packagePath = keyPrefix + storage + "/" + packageName`
(vs. just `keyPrefix + packageName` otherwise), so the tarball key becomes:

```
<keyPrefix><storage>/@scope/foo/foo-1.2.3.tgz
```

`TarballKey`'s `storageFolder` parameter reproduces this exactly (empty
string reproduces the plain layout above). There's no way to derive which
scopes need this from the package spec alone - it's admin-configured data
that only Verdaccio's own config knows - so it has to be supplied
separately: `yarnstatic check` reads it from `<path>/.yarnrc.yml`'s
`yarnstaticScopeStorage` key, and `yarnstatic serve` gets it per-request
from the plugin over the wire protocol. See [plugin.md](plugin.md)'s
"Scope storage overrides" section and [protocol.md](protocol.md) for the
full mechanism. `yarnstatic fetch` doesn't support it (no project
directory to read `.yarnrc.yml` from).

## What's *not* covered

- Verdaccio also stores a per-package metadata JSON packument at
  `<keyPrefix><name>/package.json`. This project doesn't use it - the
  `wrapNetworkRequest` hook only ever needs to intercept tarball GETs (see
  [architecture.md](architecture.md) for why), never packument GETs.
- Tarball bytes stored by Verdaccio are confirmed byte-identical to what
  was originally published (`writeTarball`/`readTarball` pipe bytes through
  unmodified - no gzip/tar/hashing anywhere in that plugin's source). This
  is what makes the checksum-matching reasoning in
  [architecture.md](architecture.md) hold.
