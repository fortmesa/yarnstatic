'use strict';

// Computes S3 object keys matching the layout used by the
// verdaccio-aws-s3-storage plugin, and parses npm package identifiers.
// Ported literally from internal/verdaccio/key.go -- this and the two
// existing JS plugins' own copies of tarballKey/normalizePrefix must stay
// byte-for-byte equivalent in what key they compute for a given
// package/prefix/storageFolder; check whether key.go changed first if
// this file's behavior ever needs to change.

// packageSpecToString renders a {scope, name, version} spec back as
// "name@version" or "@scope/name@version". scope is '' (not null) for an
// unscoped package, matching this file's other functions.
function packageSpecToString(spec) {
  if (!spec.scope) return `${spec.name}@${spec.version}`;
  return `@${spec.scope}/${spec.name}@${spec.version}`;
}

function normalizePrefix(prefix) {
  if (!prefix) return '';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

// tarballKey computes the S3 object key verdaccio-aws-s3-storage uses for
// a package tarball:
//   unscoped: <prefix>name/name-version.tgz
//   scoped:   <prefix>@scope/name/name-version.tgz
//
// prefix may be '' and may or may not have a trailing '/' -- both are
// normalized to behave identically.
//
// storageFolder reproduces Verdaccio's packages['@scope/*'].storage option
// (see docs/s3-layout.md): when a package matches a `packages:` entry with
// a `storage:` value set, verdaccio-aws-s3-storage inserts that value as
// an extra folder segment right after the key prefix. Pass '' when the
// package's scope has no such override -- this reproduces the prior,
// unaffected behavior exactly.
function tarballKey(prefix, spec, storageFolder) {
  let p = normalizePrefix(prefix);
  if (storageFolder) p += normalizePrefix(storageFolder);
  if (!spec.scope) {
    return `${p}${spec.name}/${spec.name}-${spec.version}.tgz`;
  }
  return `${p}@${spec.scope}/${spec.name}/${spec.name}-${spec.version}.tgz`;
}

// splitIdent splits an npm ident ("name" or "@scope/name") into scope
// (without "@", "" if unscoped) and name. Throws if a leading "@" has no
// following "/".
function splitIdent(ident) {
  if (!ident.startsWith('@')) {
    if (ident === '') {
      throw new Error('empty package name');
    }
    return {scope: '', name: ident};
  }
  const slash = ident.indexOf('/');
  if (slash < 0) {
    throw new Error(`${JSON.stringify(ident)}: scoped package name missing '/'`);
  }
  const scope = ident.slice(1, slash);
  const name = ident.slice(slash + 1);
  if (!scope || !name) {
    throw new Error(`${JSON.stringify(ident)}: malformed scoped package name`);
  }
  return {scope, name};
}

// splitIdentAndSuffix splits "<ident>@<suffix>" at the correct "@" -- the
// one AFTER any leading "@scope/", not the first byte. Shared by
// parsePackageSpec ("name@version") and lockfile's resolution-field
// parsing ("name@npm:1.2.3").
function splitIdentAndSuffix(s) {
  const searchFrom = s.startsWith('@') ? 1 : 0;
  const at = s.indexOf('@', searchFrom);
  if (at < 0) {
    throw new Error(`${JSON.stringify(s)}: missing '@' separator after package name`);
  }
  return {ident: s.slice(0, at), suffix: s.slice(at + 1)};
}

// parsePackageSpec parses --package values of the form "name@version" or
// "@scope/name@version".
function parsePackageSpec(s) {
  let ident, suffix;
  try {
    ({ident, suffix} = splitIdentAndSuffix(s));
  } catch (err) {
    throw new Error(`invalid package spec ${JSON.stringify(s)}: ${err.message}`);
  }
  const version = suffix;
  if (version === '') {
    throw new Error(`invalid package spec ${JSON.stringify(s)}: missing version`);
  }
  let scope, name;
  try {
    ({scope, name} = splitIdent(ident));
  } catch (err) {
    throw new Error(`invalid package spec ${JSON.stringify(s)}: ${err.message}`);
  }
  return {scope, name, version};
}

module.exports = {
  packageSpecToString,
  normalizePrefix,
  tarballKey,
  splitIdent,
  splitIdentAndSuffix,
  parsePackageSpec,
};
