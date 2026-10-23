#!/bin/sh
# End-to-end verification: builds yarnstatic from source, spins up a
# throwaway Yarn Berry project pinned to scripts/e2e-fixture/'s lockfile,
# and runs `yarn install --immutable` through the real plugin + daemon
# against a real S3 bucket. Confirms the tarball actually comes from S3
# (global cache disabled, local cache cleared first) and that the process
# exits promptly instead of hanging (see the daemon-unref fix in
# plugins/yarn-plugin-yarnstatic/sources/index.js).
#
# This is a manual/CI-optional integration check, not part of `go test
# ./...`: it needs real AWS credentials and a real bucket, which unit
# tests must not depend on.
#
# Usage:
#   YARNSTATIC_BUCKET=my-verdaccio-bucket ./scripts/e2e-test.sh
#   YARNSTATIC_BUCKET=my-verdaccio-bucket AWS_PROFILE=my-profile ./scripts/e2e-test.sh
#
# Any other YARNSTATIC_* / AWS_* env vars (YARNSTATIC_KEY_PREFIX,
# AWS_REGION, etc.) are passed through untouched - see docs/cli.md.
#
# Env vars specific to this script:
#   E2E_KEEP_WORKDIR=1  don't delete the temp project dir on exit (for
#                        inspecting .yarn/cache or debugging a failure)

set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
FIXTURE_DIR="$REPO_ROOT/scripts/e2e-fixture"

say() { printf '%s\n' "$*"; }
die() { printf 'e2e-test: %s\n' "$*" >&2; exit 1; }

[ -n "${YARNSTATIC_BUCKET:-}" ] || die "YARNSTATIC_BUCKET must be set (see usage in this script's header)"
command -v corepack >/dev/null 2>&1 || die "corepack is required (ships with Node 16.9+)"

WORKDIR=$(mktemp -d)
cleanup() {
  if [ "${E2E_KEEP_WORKDIR:-}" = "1" ]; then
    say "E2E_KEEP_WORKDIR=1 set - leaving workdir at $WORKDIR"
  else
    rm -rf "$WORKDIR"
  fi
}
trap cleanup EXIT

say "Building yarnstatic from $REPO_ROOT..."
( cd "$REPO_ROOT" && go build -o "$WORKDIR/yarnstatic" ./cmd/yarnstatic )

say "Setting up throwaway Yarn Berry project in $WORKDIR/project..."
PROJECT="$WORKDIR/project"
mkdir -p "$PROJECT"
cp "$FIXTURE_DIR/package.json" "$PROJECT/package.json"
cp "$FIXTURE_DIR/yarn.lock" "$PROJECT/yarn.lock"
cat > "$PROJECT/.yarnrc.yml" <<'EOF'
enableGlobalCache: false
EOF

# `yarn plugin import` installs the bundle `yarn build` writes, the same
# way install.sh installs the plugin in a Yarn project. A release ships
# that bundle as plugin-yarnstatic.cjs.
PLUGIN_DIR="$REPO_ROOT/plugins/yarn-plugin-yarnstatic"
say "Building the plugin bundle in $PLUGIN_DIR..."
( cd "$PLUGIN_DIR" && corepack yarn install --immutable && corepack yarn build )
say "Installing the plugin via 'yarn plugin import'..."
( cd "$PROJECT" && corepack yarn plugin import "$PLUGIN_DIR/bundles/@yarnpkg/plugin-yarnstatic.js" )

run_with_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 60 "$@"
  else
    "$@"
  fi
}

say "Running 'yarn install --immutable' against bucket '$YARNSTATIC_BUCKET'..."
cd "$PROJECT"
export YARNSTATIC_BIN="$WORKDIR/yarnstatic"

# Isolate from the real $HOME's .yarnrc.yml: Yarn merges plugins/config from
# ~/.yarnrc.yml into every project (see plugins/yarn-plugin-yarnstatic's
# README), so without this, a stale or just different globally-installed
# plugin.cjs on whoever's machine runs this script silently interferes with
# the fixture's own plugin - exactly what happened once already (a stale
# ~/.yarn/plugins/plugin-yarnstatic.cjs from manual testing shadowed this
# project's copy after the wire protocol changed).
#
# Overriding $HOME also moves every AWS SDK path (config, credentials, SSO
# token cache - there's no single env var that redirects all of those at
# once) and corepack's release cache, none of which should be isolated -
# symlinking the real ~/.aws and corepack cache dirs into the fake home
# keeps those working exactly as before while still hiding ~/.yarnrc.yml.
FAKE_HOME="$WORKDIR/home"
mkdir -p "$FAKE_HOME"
: "${COREPACK_HOME:=${XDG_CACHE_HOME:-$HOME/.cache}/node/corepack}"
if [ -d "$COREPACK_HOME" ]; then
  mkdir -p "$FAKE_HOME/.cache/node"
  ln -s "$COREPACK_HOME" "$FAKE_HOME/.cache/node/corepack"
fi
if [ -d "$HOME/.aws" ]; then
  ln -s "$HOME/.aws" "$FAKE_HOME/.aws"
fi
export HOME="$FAKE_HOME"

# The plugin makes one private socket directory per install under
# os.tmpdir(), which is $TMPDIR or /tmp, and removes it on exit. Other
# runs on the box can leave their own, a killed earlier run of this script
# among them, so snapshot first and flag only directories this run created.
SOCK_PARENT="${TMPDIR:-/tmp}"
SOCK_PARENT="${SOCK_PARENT%/}"
BEFORE_SOCKS=$(ls -d "$SOCK_PARENT"/yarnstatic-* 2>/dev/null || true)

START=$(date +%s)
if ! run_with_timeout corepack yarn install --immutable; then
  die "yarn install failed or timed out (possible hang - see daemon unref handling in the plugin)"
fi
END=$(date +%s)
say "yarn install completed in $((END - START))s"

ls "$PROJECT/.yarn/cache/lodash-npm-4.17.21-"*.zip >/dev/null 2>&1 \
  || die "expected .yarn/cache/lodash-npm-4.17.21-*.zip - install did not fetch through the daemon as expected"
say "PASS: lodash fetched via the yarnstatic daemon from S3, install exited cleanly"

AFTER_SOCKS=$(ls -d "$SOCK_PARENT"/yarnstatic-* 2>/dev/null || true)
printf '%s\n' "$BEFORE_SOCKS" | sort > "$WORKDIR/before-socks"
printf '%s\n' "$AFTER_SOCKS" | sort > "$WORKDIR/after-socks"
NEW_SOCKS=$(comm -13 "$WORKDIR/before-socks" "$WORKDIR/after-socks")
if [ -n "$NEW_SOCKS" ]; then
  die "leftover daemon socket dir(s) created by this run - the plugin did not clean up on exit: $NEW_SOCKS"
fi
say "PASS: no leftover daemon socket dir"
