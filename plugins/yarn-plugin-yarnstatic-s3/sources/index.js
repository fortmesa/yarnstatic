/**
 * yarn-plugin-yarnstatic-s3
 *
 * Same job as ../yarn-plugin-yarnstatic (intercepts npm tarball downloads
 * and serves them from a private S3 bucket instead of the real network, so
 * `yarn install --immutable` can run fully offline) but calls
 * @aws-sdk/client-s3 directly instead of spawning a separate `yarnstatic
 * serve` daemon and talking to it over a Unix socket. No daemon lifecycle,
 * no wire protocol, no separate Go binary to resolve/install -- at the cost
 * of bundling the aws-sdk v3 S3 client (and its credential-provider
 * dependency) into this plugin instead of staying dependency-free like the
 * daemon-based one.
 *
 * The S3 key layout (internal/verdaccio/key.go's TarballKey) and config
 * resolution (cmd/yarnstatic/config.go's commonFlags.resolve()) are ported
 * here literally, field-for-field, from the real Go source those files
 * live in -- see docs/s3-layout.md for the layout itself. Anywhere this
 * file's behavior needs to change, check whether the Go source changed
 * first; the two are meant to stay byte-for-byte equivalent in what key
 * they compute for a given package/version/prefix/storageFolder.
 *
 * Enablement is driven by the same YARNSTATIC_BUCKET environment variable
 * as the daemon-based plugin (or the yarnstaticBucket .yarnrc.yml setting,
 * see below) -- leave both unset and this plugin is a complete no-op.
 *
 * Unlike ../yarn-plugin-yarnstatic (a raw, unbundled file loaded directly
 * via `yarn plugin import`, which is why THAT file has to hand-author its
 * own `module.exports = {name, factory: (require) => {...}}` wrapper and
 * do everything inside it -- see that file's own header comment), this
 * plugin is built via @yarnpkg/builder (`yarn build`, see package.json).
 * The builder's own bundler supplies that exact wrapper itself, around
 * whatever this file exports -- confirmed directly: authoring a second,
 * redundant factory/require wrapper IN this file (matching the unbundled
 * plugin's own style) breaks it in a way that's easy to miss, because it
 * still builds without error. The `require` identifier that wrapper
 * introduces shadows the real one for everything nested inside it, so
 * esbuild can't tell any of those require(...) calls apart from a call to
 * some arbitrary same-named local variable -- it leaves every one of them
 * as a literal, unresolved call instead of bundling what they ask for, and
 * the doubly-wrapped return value ends up being this file's OWN
 * {name, factory} object instead of the actual {default: {...}} hooks
 * payload Yarn expects back from calling the (builder-supplied) outer
 * factory. Both failures are silent at build time; the bundle size (a
 * suspiciously tiny few KB when it should hold the whole aws-sdk client)
 * is the tell. Plain top-level `require(...)` calls in this file, with no
 * wrapper of its own, are what the builder actually expects -- exactly
 * the shape ../../verdaccio-generic-oidc's own yarn-plugin-oidc-login
 * (also built via @yarnpkg/builder) uses, just CommonJS `require`/
 * `module.exports` here instead of that one's TypeScript `import`/
 * `export default`, to stay consistent with the daemon-based plugin's own
 * plain-JS style in this repo.
 */
'use strict';

const {SettingsType} = require('@yarnpkg/core');
const {S3Client, GetObjectCommand} = require('@aws-sdk/client-s3');
const {fromIni} = require('@aws-sdk/credential-providers');

// ---------------------------------------------------------------------------
// Config resolution -- ported from cmd/yarnstatic/config.go's commonFlags.
// Precedence is env var, then the matching .yarnrc.yml setting, then (for
// keyPrefix only) a hardcoded default -- same "explicit override always
// wins" spirit as the Go CLI's own "flag wins over env var" rule, just with
// the .yarnrc.yml setting standing in for "the flag" (a persisted,
// per-project value) and the env var standing in for an ad-hoc,
// invocation-time override.
// ---------------------------------------------------------------------------

// Matches cmd/yarnstatic/config.go's defaultKeyPrefix exactly -- the layout
// of the production Verdaccio S3 bucket (your-s3-bucket).
const DEFAULT_KEY_PREFIX = 'verdaccio';

function resolveSetting(configuration, envVar, settingKey) {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  const fromConfig = configuration.get(settingKey);
  return fromConfig || '';
}

function resolveS3Config(configuration) {
  const bucket = resolveSetting(configuration, 'YARNSTATIC_BUCKET', 'yarnstaticBucket');
  const keyPrefix =
    resolveSetting(configuration, 'YARNSTATIC_KEY_PREFIX', 'yarnstaticKeyPrefix') ||
    DEFAULT_KEY_PREFIX;
  const region = resolveSetting(configuration, 'YARNSTATIC_REGION', 'yarnstaticRegion');
  const endpoint = resolveSetting(configuration, 'YARNSTATIC_ENDPOINT', 'yarnstaticEndpoint');
  const profile = resolveSetting(configuration, 'YARNSTATIC_PROFILE', 'yarnstaticProfile');
  return {bucket, keyPrefix, region, endpoint, profile};
}

// ---------------------------------------------------------------------------
// S3 key computation -- ported from internal/verdaccio/key.go's
// TarballKey/normalizePrefix, literally.
// ---------------------------------------------------------------------------

function normalizePrefix(prefix) {
  if (!prefix) return '';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

/**
 * Computes the S3 object key verdaccio-aws-s3-storage uses for a package
 * tarball:
 *   unscoped: <prefix>name/name-version.tgz
 *   scoped:   <prefix>@scope/name/name-version.tgz
 *
 * storageFolder reproduces Verdaccio's packages['@scope/*'].storage option
 * (see docs/s3-layout.md): when a package matches a `packages:` entry with
 * a `storage:` value set, verdaccio-aws-s3-storage inserts that value as an
 * extra folder segment right after the key prefix. Pass "" (falsy) when the
 * package's scope has no such override.
 */
function tarballKey(prefix, spec, storageFolder) {
  let p = normalizePrefix(prefix);
  if (storageFolder) p += normalizePrefix(storageFolder);
  if (!spec.scope) {
    return `${p}${spec.name}/${spec.name}-${spec.version}.tgz`;
  }
  return `${p}@${spec.scope}/${spec.name}/${spec.name}-${spec.version}.tgz`;
}

// ---------------------------------------------------------------------------
// Tarball URL matching -- identical to ../yarn-plugin-yarnstatic's own
// parseTarballUrl, except it returns the {scope, name, version} object
// directly (this plugin needs the parts separately for tarballKey(), not
// rejoined into one "name@version" wire-protocol string).
// ---------------------------------------------------------------------------

/**
 * Parses a URL matching Yarn's npm tarball convention:
 *   {registry}/{identUrl}/-/{basename}-{version}.tgz
 * where identUrl is "/name" or "/@scope%2fname" (NpmSemverFetcher retries
 * with an unencoded "/@scope/name" on a first-attempt failure, so both
 * forms are accepted here). Returns {scope, name, version} (scope is null
 * for an unscoped package), or null if target isn't a recognized npm
 * tarball URL.
 */
function parseTarballUrl(target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return null;
  }

  const sepIndex = url.pathname.indexOf('/-/');
  if (sepIndex < 0) return null;

  const identSegment = url.pathname.slice(1, sepIndex);
  const basename = url.pathname.slice(sepIndex + 3);
  if (identSegment === '' || !basename.endsWith('.tgz') || basename.includes('/')) {
    return null;
  }

  let ident;
  try {
    ident = decodeURIComponent(identSegment);
  } catch {
    return null;
  }

  let scope = null;
  let name = ident;
  if (ident.startsWith('@')) {
    const slash = ident.indexOf('/');
    if (slash < 0) return null;
    scope = ident.slice(1, slash);
    name = ident.slice(slash + 1);
  } else if (ident.includes('/')) {
    return null;
  }

  const base = basename.slice(0, -4); // strip ".tgz"
  const prefix = `${name}-`;
  if (!base.startsWith(prefix)) return null;
  const version = base.slice(prefix.length);
  if (!version) return null;

  return {scope, name, version};
}

// ---------------------------------------------------------------------------
// S3 client -- built once per `yarn` process (mirrors the daemon-based
// plugin's "one daemon per process" lifecycle), not once per fetch.
// ---------------------------------------------------------------------------

let clientPromise = null;

async function ensureClient(config) {
  if (!clientPromise) {
    clientPromise = buildClient(config);
  }
  return clientPromise;
}

async function buildClient({region, endpoint, profile}) {
  const options = {};
  if (region) options.region = region;
  if (endpoint) {
    options.endpoint = endpoint;
    // Virtual-hosted-style addressing generally doesn't work against
    // non-AWS S3-compatible endpoints (MinIO, etc) -- same reasoning as
    // internal/s3client/client.go's UsePathStyle.
    options.forcePathStyle = true;
  }
  if (profile) {
    options.credentials = fromIni({profile});
  }
  // With no region/profile override, S3Client falls back to the SDK's own
  // default resolution (env vars, shared config/credentials files,
  // IMDS/IAM role) -- same as Go's config.LoadDefaultConfig with no
  // WithRegion/WithSharedConfigProfile options.

  return new S3Client(options);
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Reports whether err indicates the requested object doesn't exist --
 * ported from internal/s3client/client.go's IsNotFound.
 */
function isNotFound(err) {
  return (
    err?.name === 'NoSuchKey' ||
    err?.name === 'NotFound' ||
    err?.Code === 'NoSuchKey' ||
    err?.Code === 'NotFound' ||
    err?.$metadata?.httpStatusCode === 404
  );
}

/**
 * Reports whether err indicates a credentials/permissions failure -- ported
 * from internal/s3client/client.go's IsAccessDenied.
 */
function isAccessDenied(err) {
  const code = err?.name || err?.Code;
  return (
    code === 'AccessDenied' ||
    code === 'Forbidden' ||
    code === 'InvalidAccessKeyId' ||
    code === 'SignatureDoesNotMatch'
  );
}

function describeDownloadError(err, key) {
  if (isNotFound(err)) return `not found: ${key}`;
  if (isAccessDenied(err)) return `access denied: ${key}`;
  return `download failed: ${err.message || err}`;
}

async function downloadObject(client, bucket, key) {
  let response;
  try {
    response = await client.send(new GetObjectCommand({Bucket: bucket, Key: key}));
  } catch (err) {
    throw new Error(`yarnstatic-s3: ${describeDownloadError(err, key)}`);
  }
  return streamToBuffer(response.Body);
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

module.exports = {
  default: {
    configuration: {
      // Same setting as ../yarn-plugin-yarnstatic -- see that plugin's own
      // comment on this key for the full rationale.
      yarnstaticScopeStorage: {
        description: `Maps an npm scope (no leading "@") to a Verdaccio packages[...].storage folder override`,
        type: SettingsType.MAP,
        valueDefinition: {
          description: 'The Verdaccio storage folder value configured for this scope',
          type: SettingsType.STRING,
        },
      },
      // The five settings below are .yarnrc.yml equivalents of the
      // YARNSTATIC_BUCKET/YARNSTATIC_KEY_PREFIX/YARNSTATIC_REGION/
      // YARNSTATIC_ENDPOINT/YARNSTATIC_PROFILE environment variables --
      // either source works (see resolveSetting() above for precedence),
      // so a project can commit its bucket/prefix/region directly into
      // .yarnrc.yml instead of requiring every environment that runs
      // `yarn install` to set the matching env vars itself.
      yarnstaticBucket: {
        description: 'S3 bucket name (or set YARNSTATIC_BUCKET). Required for this plugin to activate.',
        type: SettingsType.STRING,
        default: '',
      },
      yarnstaticKeyPrefix: {
        description: `S3 key prefix (or set YARNSTATIC_KEY_PREFIX; default: "${DEFAULT_KEY_PREFIX}")`,
        type: SettingsType.STRING,
        default: '',
      },
      yarnstaticRegion: {
        description: 'AWS region (or set YARNSTATIC_REGION; default: AWS SDK default resolution)',
        type: SettingsType.STRING,
        default: '',
      },
      yarnstaticEndpoint: {
        description: 'Custom S3-compatible endpoint URL, e.g. for MinIO (or set YARNSTATIC_ENDPOINT; default: real AWS S3)',
        type: SettingsType.STRING,
        default: '',
      },
      yarnstaticProfile: {
        description: 'AWS shared config profile (or set YARNSTATIC_PROFILE; default: AWS SDK default credential chain)',
        type: SettingsType.STRING,
        default: '',
      },
    },
    hooks: {
      wrapNetworkRequest: async (executor, extra) => {
        const config = resolveS3Config(extra.configuration);
        if (!config.bucket) {
          return executor; // disabled - pure passthrough, real network proceeds
        }

        const spec = parseTarballUrl(extra.target);
        if (!spec) {
          // Enabled, but this isn't a recognized tarball request: block it
          // rather than letting it reach the real network. This is what
          // makes "yarnstatic-s3 enabled" a hard offline guarantee instead
          // of a best-effort one -- same reasoning as the daemon-based
          // plugin's own equivalent branch.
          return async () => {
            throw new Error(
              `yarnstatic-s3: blocked network request to ${extra.target} (YARNSTATIC_BUCKET/yarnstaticBucket is ` +
              `set, but this isn't a recognized npm tarball URL servable from S3). If this is unexpected during ` +
              `a locked "yarn install --immutable", check that your lockfile is fully resolved - see docs/architecture.md.`
            );
          };
        }

        // Always a Map, empty if yarnstaticScopeStorage was never set -- see
        // Configuration's getDefaultValue for SettingsType.MAP.
        const scopeStorage = extra.configuration.get('yarnstaticScopeStorage');
        const storageFolder = spec.scope ? scopeStorage.get(spec.scope) : undefined;
        const key = tarballKey(config.keyPrefix, spec, storageFolder);

        return async () => {
          const client = await ensureClient(config);
          const body = await downloadObject(client, config.bucket, key);
          return {body, statusCode: 200, headers: {}};
        };
      },
    },
  },
};

// Test-only: exposes the pure helper functions above for direct unit
// testing (see ../test/smoke.js) without needing to drive everything
// through the wrapNetworkRequest hook and a mocked S3Client. Yarn itself
// never reads this key -- only `.default` (configuration/hooks) is part of
// the real plugin contract.
module.exports._test = {
  resolveSetting,
  resolveS3Config,
  tarballKey,
  parseTarballUrl,
  isNotFound,
  isAccessDenied,
  DEFAULT_KEY_PREFIX,
};
