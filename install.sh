#!/bin/sh
# Installs the yarnstatic binary into ~/.yarn/bin by default. That is one
# of the directories the Yarn plugin's resolveBinary() checks, listed in
# docs/plugin.md, so the plugin finds it without a PATH change. Run inside
# a project that has a .yarnrc.yml, or with that project's path as the
# first argument, the script also installs the Yarn plugin. A Yarn project
# with a yarn.lock gets it through `yarn plugin import`, which also adds it
# to .yarnrc.yml. Anywhere else, such as a home directory with no project
# for `yarn plugin import` to attach to, the script copies the plugin into
# .yarn/plugins/ and prints the lines to add to .yarnrc.yml.
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

# Temp files the cleanup trap removes. Each download lands in one of these
# and is moved into place only after its checksum matches.
BIN_TMP=""
PLUGIN_TMP=""
YARNRC_TMP=""

cleanup() {
  for f in "$CHECKSUMS_FILE" "$BIN_TMP" "$PLUGIN_TMP" "$YARNRC_TMP"; do
    if [ -n "$f" ]; then rm -f "$f"; fi
  done
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# mktemp creates files 0600. file_mode prints the mode a plain download
# would get under the current umask, so the installed file keeps it.
file_mode() {
  printf '%o' $(( $1 & ~0$(umask) ))
}

fetch_checksums() {
  [ -n "$CHECKSUMS_FILE" ] && return 0
  CHECKSUMS_FILE=$(mktemp)
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
  BIN_TMP=$(mktemp "$BIN_DIR/.yarnstatic.XXXXXX")
  curl -fsSL "$url" -o "$BIN_TMP" || die "could not download $asset"
  verify_checksum "$BIN_TMP" "$asset"
  chmod "$(file_mode 0777)" "$BIN_TMP"
  mv -f "$BIN_TMP" "$BIN_DIR/yarnstatic"
  BIN_TMP=""
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

# `yarn plugin import` of a local file records that file's path as the
# plugin's spec. Yarn re-downloads a missing plugin only from an http(s)
# spec, so this points the spec back at the release URL the verified file
# came from. Args: .yarnrc.yml path, spec Yarn wrote, release URL.
set_plugin_spec() {
  YARNRC_TMP=$(mktemp)
  if YS_OLD_SPEC="$2" YS_NEW_SPEC="$3" awk '
    { line = $0; sub(/^ +/, "", line) }
    line == ("spec: " ENVIRON["YS_OLD_SPEC"]) {
      sub(/spec: .*/, "")
      print $0 "spec: \"" ENVIRON["YS_NEW_SPEC"] "\""
      n++
      next
    }
    { print }
    END { exit (n == 1 ? 0 : 1) }
  ' "$1" > "$YARNRC_TMP"; then
    cat "$YARNRC_TMP" > "$1"
  fi
  rm -f "$YARNRC_TMP"
  YARNRC_TMP=""
  grep -qF "spec: \"$3\"" "$1" \
    || die "the plugin is installed and verified, but its spec in $1 still names a temp file - set it to \"$3\" by hand"
}

install_plugin() {
  yarnrc="$PROJECT_DIR/.yarnrc.yml"
  [ -f "$yarnrc" ] || return 0

  plugin_url="https://github.com/$REPO/releases/download/$VERSION/plugin-yarnstatic.cjs"

  # In a Yarn project (one with a yarn.lock), `yarn plugin import` names
  # the plugin file after the plugin's declared name and adds it to
  # .yarnrc.yml with Yarn's own config writer. The one line this script
  # edits afterwards is the spec, in set_plugin_spec. A home-directory or
  # machine-wide install has no project, so it can't use this path. Yarn's
  # Project.find() throws "No project found" without a yarn.lock-anchored
  # root, and corepack needs a package.json's packageManager field to know
  # which yarn to run. See docs/plugin.md.
  #
  # The script downloads and verifies the plugin before Yarn sees it,
  # because `yarn plugin import <url>` runs the plugin's code to read its
  # name before anything could check it.
  if [ -f "$PROJECT_DIR/yarn.lock" ] && command -v corepack >/dev/null 2>&1; then
    say "Found a Yarn project at $PROJECT_DIR - installing the plugin via 'yarn plugin import'..."
    mkdir -p "$PROJECT_DIR/.yarn"
    PLUGIN_TMP=$(mktemp "$PROJECT_DIR/.yarn/.plugin-yarnstatic.XXXXXX")
    curl -fsSL "$plugin_url" -o "$PLUGIN_TMP" || die "could not download plugin-yarnstatic.cjs"
    verify_checksum "$PLUGIN_TMP" "plugin-yarnstatic.cjs"
    import_spec=".yarn/${PLUGIN_TMP##*/}"
    if (cd "$PROJECT_DIR" && corepack yarn plugin import "./$import_spec"); then
      rm -f "$PLUGIN_TMP"
      PLUGIN_TMP=""
      set_plugin_spec "$yarnrc" "$import_spec" "$plugin_url"
      return 0
    fi
    rm -f "$PLUGIN_TMP"
    PLUGIN_TMP=""
    say "'yarn plugin import' failed - falling back to a manual install."
  fi

  plugin_dir="$PROJECT_DIR/.yarn/plugins"
  plugin_path="$plugin_dir/plugin-yarnstatic.cjs"

  say "Installing the plugin manually to $plugin_path..."
  mkdir -p "$plugin_dir"
  PLUGIN_TMP=$(mktemp "$plugin_dir/.plugin-yarnstatic.XXXXXX")
  curl -fsSL "$plugin_url" -o "$PLUGIN_TMP" || die "could not download plugin-yarnstatic.cjs"
  verify_checksum "$PLUGIN_TMP" "plugin-yarnstatic.cjs"
  chmod "$(file_mode 0666)" "$PLUGIN_TMP"
  mv -f "$PLUGIN_TMP" "$plugin_path"
  PLUGIN_TMP=""
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
