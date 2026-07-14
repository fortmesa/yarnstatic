#!/bin/sh
# Installs the yarnstatic binary into a per-user directory that the Yarn
# plugin's resolveBinary() already checks by convention (see
# docs/plugin.md), so no PATH changes are required for the plugin to find
# it. If run inside (or pointed at) a project that has a .yarnrc.yml, also
# installs the Yarn plugin - via `yarn plugin import` for a real Yarn
# project (yarn.lock present), or by writing .yarn/plugins/ and .yarnrc.yml
# directly otherwise (the only option for a pure home-directory/machine-wide
# install, which has no project for `yarn plugin import` to attach to).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/fortmesa/yarnstatic/main/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- /path/to/project
#
# Env vars:
#   YARNSTATIC_VERSION     release tag to install, e.g. v1.1.1 (default: latest)
#   YARNSTATIC_INSTALL_DIR base install dir (default: $HOME/.yarn)
#   YARNSTATIC_FORCE=1     reinstall the binary even if one is already on PATH

set -eu

REPO="fortmesa/yarnstatic"
INSTALL_DIR="${YARNSTATIC_INSTALL_DIR:-$HOME/.yarn}"
BIN_DIR="$INSTALL_DIR/bin"
VERSION="${YARNSTATIC_VERSION:-latest}"
PROJECT_DIR="${1:-$PWD}"

say() { printf '%s\n' "$*"; }
die() { printf 'yarnstatic install: %s\n' "$*" >&2; exit 1; }

# checksums.txt is published alongside every release (see
# .github/workflows/release.yml's "Generate checksums" step -- `sha256sum *`
# run over the exact same dist/ dir whose contents become both the GitHub
# release assets and the S3 upload), so there's already a trust anchor here;
# this just wires downloads up to actually check against it, rather than
# trusting HTTPS + GitHub hosting alone.
CHECKSUMS_FILE=""

fetch_checksums() {
  [ -n "$CHECKSUMS_FILE" ] && return 0
  CHECKSUMS_FILE=$(mktemp)
  trap 'rm -f "$CHECKSUMS_FILE"' EXIT
  curl -fsSL "https://github.com/$REPO/releases/download/$VERSION/checksums.txt" \
    -o "$CHECKSUMS_FILE" \
    || die "could not fetch checksums.txt for $VERSION"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "no sha256sum/shasum available to verify downloaded file integrity"
  fi
}

# Verifies $file (already downloaded to disk) against its entry for $name in
# this release's checksums.txt. Fails loud on a mismatch or a missing entry
# -- a checksum file present but silent about the one file being installed
# is exactly as unsafe as no checksum file at all.
verify_checksum() {
  file="$1"
  name="$2"
  fetch_checksums
  expected=$(grep " $name\$" "$CHECKSUMS_FILE" | awk '{print $1}')
  [ -n "$expected" ] || die "no checksum entry for $name in checksums.txt"
  actual=$(sha256_of "$file")
  [ "$expected" = "$actual" ] \
    || die "checksum mismatch for $name (expected $expected, got $actual) -- refusing to install"
}

detect_platform() {
  case "$(uname -s)" in
    Linux) goos="linux" ;;
    Darwin) goos="darwin" ;;
    *) die "unsupported OS: $(uname -s)" ;;
  esac

  case "$(uname -m)" in
    x86_64 | amd64) goarch="amd64" ;;
    arm64 | aarch64) goarch="arm64" ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
}

resolve_version() {
  if [ "$VERSION" = "latest" ]; then
    VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
      | grep '"tag_name":' | head -n1 | sed -E 's/.*"([^"]+)".*/\1/')
    [ -n "$VERSION" ] || die "could not resolve the latest release version"
  fi
}

install_binary() {
  if command -v yarnstatic >/dev/null 2>&1 && [ "${YARNSTATIC_FORCE:-}" != "1" ]; then
    say "yarnstatic already on PATH at $(command -v yarnstatic) - skipping (set YARNSTATIC_FORCE=1 to reinstall)"
    return 0
  fi

  asset="yarnstatic-$goos-$goarch"
  url="https://github.com/$REPO/releases/download/$VERSION/$asset"

  mkdir -p "$BIN_DIR"
  say "Downloading $asset ($VERSION)..."
  curl -fsSL "$url" -o "$BIN_DIR/yarnstatic"
  verify_checksum "$BIN_DIR/yarnstatic" "$asset"
  chmod +x "$BIN_DIR/yarnstatic"
  say "Installed yarnstatic to $BIN_DIR/yarnstatic"

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      say "Note: $BIN_DIR is not on your PATH. The Yarn plugin finds it there"
      say "automatically; for direct CLI use (yarnstatic check/fetch) add:"
      say "  export PATH=\"$BIN_DIR:\$PATH\""
      ;;
  esac
}

install_plugin() {
  yarnrc="$PROJECT_DIR/.yarnrc.yml"
  [ -f "$yarnrc" ] || return 0

  plugin_url="https://github.com/$REPO/releases/download/$VERSION/plugin-yarnstatic.cjs"

  # A real Yarn project (yarn.lock-anchored) can install the plugin the
  # correct way: `yarn plugin import` derives the right filename from the
  # plugin's own declared name and updates .yarnrc.yml via Yarn's own
  # config-writing code, rather than us hand-editing YAML. This can't work
  # for a pure home-directory/machine-wide install with no project: Yarn's
  # Project.find() throws "No project found" without a yarn.lock-anchored
  # root, and corepack itself needs a package.json's packageManager field
  # just to know which yarn to run - see docs/plugin.md.
  if [ -f "$PROJECT_DIR/yarn.lock" ] && command -v corepack >/dev/null 2>&1; then
    say "Found a Yarn project at $PROJECT_DIR - installing the plugin via 'yarn plugin import'..."
    if (cd "$PROJECT_DIR" && corepack yarn plugin import "$plugin_url"); then
      return 0
    fi
    say "'yarn plugin import' failed - falling back to a manual install."
  fi

  plugin_dir="$PROJECT_DIR/.yarn/plugins"
  plugin_path="$plugin_dir/plugin-yarnstatic.cjs"

  say "Installing the plugin manually to $plugin_path..."
  mkdir -p "$plugin_dir"
  curl -fsSL "$plugin_url" -o "$plugin_path"
  verify_checksum "$plugin_path" "plugin-yarnstatic.cjs"
  say "Installed plugin to $plugin_path"

  if grep -q "plugin-yarnstatic.cjs" "$yarnrc" 2>/dev/null; then
    say "$yarnrc already references the plugin."
  else
    say "Add this to $yarnrc:"
    say "  plugins:"
    say "    - path: .yarn/plugins/plugin-yarnstatic.cjs"
    say "      spec: \"https://github.com/$REPO\""
  fi
}

detect_platform
resolve_version
install_binary
install_plugin

say "Done. Set YARNSTATIC_BUCKET and run 'yarn install --immutable' to use it."
