#!/usr/bin/env bash
# Benchmarks install wall-clock time across five ways to populate
# node_modules for the same real project ($PROJECT below -- point it at
# any real, private project's own checkout; a realistic-sized workload,
# not a toy one, is what makes this meaningful), against a real S3 bucket
# and the real npm registry:
#
#   1. npm-install        plain `npm install`, no yarn/yarnstatic at all
#   2. yarn-no-plugin      plain `yarn install`, no yarnstatic plugin
#   3. yarn-daemon         yarn-plugin-yarnstatic, WITH the yarnstatic
#                          binary on PATH (its primary, intended path)
#   4. yarn-aws-fallback   yarn-plugin-yarnstatic, WITHOUT the yarnstatic
#                          binary anywhere it looks (forces the AWS CLI
#                          fallback path added this session)
#   5. yarn-s3-plugin      yarn-plugin-yarnstatic-s3 (direct aws-sdk v3,
#                          no daemon/binary at all)
#
# Every run gets a fresh project directory (freshly copied package.json/
# yarn.lock, not reused across runs) and a fresh, random YARN_GLOBAL_FOLDER/
# npm cache dir -- so no run can ride on a previous run's warm cache. This
# is a real-infra benchmark (real S3, real npm registry), not a unit test:
# it needs real AWS credentials and takes real wall-clock minutes to run,
# which is why it's a separate opt-in script, same as scripts/e2e-test.sh.
#
# Usage:
#   PROJECT=/path/to/some/project YARNSTATIC_BUCKET=storage ./scripts/benchmark.sh
#
# Env vars:
#   PROJECT             required -- directory containing the package.json/
#                       yarn.lock/.yarnrc.yml to benchmark installing.
#                       No default on purpose: this always benchmarks
#                       someone's real, specific dependency set, so making
#                       that an explicit, visible choice beats silently
#                       defaulting to whatever happened to be around.
#   YARNSTATIC_BUCKET   required (no default -- unlike the CLI itself,
#                       getting this wrong silently benchmarks nothing
#                       real, so this script refuses to guess)
#   YARNSTATIC_KEY_PREFIX / YARNSTATIC_REGION    default: verdaccio / us-east-1
#   AWS_PROFILE          forwarded to YARNSTATIC_PROFILE for the three S3
#                        scenarios; required (same reasoning as the bucket)
#   BENCHMARK_RUNS       iterations per scenario, default 3
#   BENCHMARK_KEEP_WORKDIRS=1   don't delete temp project dirs on exit

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# No apostrophes in any ${VAR:?message} text below -- confirmed the hard
# way: bash parses a ${var:?word} expansion's word with its own quoting
# pass, independent of the surrounding double quotes, so a bare apostrophe
# in the message opens an unterminated single-quote context as far as the
# parser's concerned. This script briefly had three such lines (only two
# originally, which happened to cancel each other out) and broke outright
# on the third - don't reintroduce one.
: "${PROJECT:?PROJECT must be set -- see the header comment at the top of this file}"
WORKLOAD_PACKAGE_JSON="$PROJECT/package.json"
WORKLOAD_YARN_LOCK="$PROJECT/yarn.lock"
WORKLOAD_YARNRC="$PROJECT/.yarnrc.yml"

: "${YARNSTATIC_BUCKET:?YARNSTATIC_BUCKET must be set -- see the header comment at the top of this file}"
: "${AWS_PROFILE:?AWS_PROFILE must be set -- see the header comment at the top of this file}"
YARNSTATIC_KEY_PREFIX="${YARNSTATIC_KEY_PREFIX:-verdaccio}"
YARNSTATIC_REGION="${YARNSTATIC_REGION:-us-east-1}"
RUNS="${BENCHMARK_RUNS:-3}"

DAEMON_PLUGIN_BUNDLE="$REPO_ROOT/plugins/yarn-plugin-yarnstatic/bundles/@yarnpkg/plugin-yarnstatic.js"
S3_PLUGIN_BUNDLE="$REPO_ROOT/plugins/yarn-plugin-yarnstatic-s3/bundles/@yarnpkg/plugin-yarnstatic-s3.js"

for f in "$WORKLOAD_PACKAGE_JSON" "$WORKLOAD_YARN_LOCK" "$WORKLOAD_YARNRC" "$DAEMON_PLUGIN_BUNDLE" "$S3_PLUGIN_BUNDLE"; do
  [ -f "$f" ] || { echo "benchmark: missing required file: $f" >&2; exit 1; }
done
command -v corepack >/dev/null 2>&1 || { echo "benchmark: corepack is required" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "benchmark: npm is required" >&2; exit 1; }

# The PATH yarn-aws-fallback runs with: everything yarn-daemon's own PATH
# has, EXCEPT wherever `yarnstatic` itself resolves -- confirmed empirically
# this session that resolveBinary()'s final fallback is a bare PATH lookup,
# so removing it from PATH (with YARNSTATIC_BIN also left unset) is what
# actually forces ensureDaemon() to fail and fall through to the AWS CLI
# path, rather than something narrower like unsetting one env var.
NODE_BIN_DIR=$(dirname "$(command -v node)")
AWS_BIN_DIR=$(dirname "$(command -v aws)")
NO_YARNSTATIC_PATH="$NODE_BIN_DIR:$AWS_BIN_DIR:/usr/bin:/bin"
if command -v yarnstatic >/dev/null 2>&1; then
  REAL_YARNSTATIC_DIR=$(dirname "$(command -v yarnstatic)")
  case ":$NO_YARNSTATIC_PATH:" in
    *":$REAL_YARNSTATIC_DIR:"*)
      echo "benchmark: yarnstatic resolves from $REAL_YARNSTATIC_DIR, which is also where node/aws live -- can't isolate the AWS-fallback scenario by PATH alone on this machine" >&2
      exit 1
      ;;
  esac
fi

RESULTS_FILE=$(mktemp)
WORKDIRS=()

# Output of the timed command. mktemp keeps it out of a fixed,
# world-readable path in shared /tmp. The file stays after a failed run so
# the path in the error message still exists.
LOG_FILE=$(mktemp)

cleanup() {
  local status=$?
  if [ "$status" -eq 0 ]; then
    rm -f "$LOG_FILE"
  fi
  if [ "${BENCHMARK_KEEP_WORKDIRS:-}" = "1" ]; then
    echo "BENCHMARK_KEEP_WORKDIRS=1 set -- leaving ${#WORKDIRS[@]} workdir(s) in place"
  else
    for d in "${WORKDIRS[@]:-}"; do
      [ -n "$d" ] && rm -rf "$d"
    done
  fi
  rm -f "$RESULTS_FILE"
}
trap cleanup EXIT


# Deliberately does NOT append to WORKDIRS itself: called everywhere as
# `workdir=$(new_workdir)`, and bash runs command substitution in a
# subshell, so an append made inside this function would only ever mutate
# that subshell's own copy of the array and vanish the moment the
# substitution completes -- confirmed the hard way (a real benchmark run
# leaked ~18GB across 22 never-cleaned project dirs, one per scenario/round,
# before this was caught). Every call site below does its own
# `WORKDIRS+=("$workdir")` immediately after, in its own (non-subshell)
# context, the same way it already had to for cachedir/globalfolder.
new_workdir() {
  mktemp -d
}

# Copies the real project's own .yarnrc.yml rather than hand-rolling a
# minimal one -- confirmed the hard way: a from-scratch .yarnrc.yml missing
# some setting the real lockfile was generated under (compressionLevel
# affects the lockfile's own cacheKey metadata) makes `--immutable` reject
# the lockfile as "would have been modified", failing every yarn scenario
# identically before any of them get anywhere near S3/the registry. Strips
# yarnPath since this script drives yarn via corepack's own activation
# (matching packageManager in the copied package.json), not the committed
# release binary at .yarn/releases/ -- that file isn't copied in.
setup_project() {
  local dir="$1"
  mkdir -p "$dir/project"
  cp "$WORKLOAD_PACKAGE_JSON" "$dir/project/package.json"
  cp "$WORKLOAD_YARN_LOCK" "$dir/project/yarn.lock"
  grep -v '^yarnPath:' "$WORKLOAD_YARNRC" > "$dir/project/.yarnrc.yml"
}

time_it() {
  local start end
  start=$(date +%s.%N)
  "$@" > "$LOG_FILE" 2>&1
  local status=$?
  end=$(date +%s.%N)
  if [ "$status" -ne 0 ]; then
    echo "benchmark: command failed (see $LOG_FILE): $*" >&2
    tail -40 "$LOG_FILE" >&2
    return 1
  fi
  awk "BEGIN {printf \"%.2f\", $end - $start}"
}

record() {
  local scenario="$1" elapsed="$2"
  echo "$scenario $elapsed" >> "$RESULTS_FILE"
  echo "    -> ${elapsed}s"
}

run_npm_install() {
  local run="$1"
  local workdir; workdir=$(new_workdir)
  WORKDIRS+=("$workdir")
  local cachedir; cachedir=$(mktemp -d)
  WORKDIRS+=("$cachedir")
  setup_project "$workdir"
  echo "  [npm-install run $run]"
  local elapsed
  elapsed=$(time_it env --chdir="$workdir/project" NPM_CONFIG_CACHE="$cachedir" npm install)
  record "npm-install" "$elapsed"
}

run_yarn_no_plugin() {
  local run="$1"
  local workdir; workdir=$(new_workdir)
  WORKDIRS+=("$workdir")
  local globalfolder; globalfolder=$(mktemp -d)
  WORKDIRS+=("$globalfolder")
  setup_project "$workdir"
  echo "  [yarn-no-plugin run $run]"
  local elapsed
  elapsed=$(time_it env --chdir="$workdir/project" YARN_GLOBAL_FOLDER="$globalfolder" \
    corepack yarn install --immutable)
  record "yarn-no-plugin" "$elapsed"
}

run_yarn_daemon() {
  local run="$1"
  local workdir; workdir=$(new_workdir)
  WORKDIRS+=("$workdir")
  local globalfolder; globalfolder=$(mktemp -d)
  WORKDIRS+=("$globalfolder")
  setup_project "$workdir"
  ( cd "$workdir/project" && env YARN_GLOBAL_FOLDER="$globalfolder" corepack yarn plugin import "$DAEMON_PLUGIN_BUNDLE" >/dev/null )
  echo "  [yarn-daemon run $run]"
  local elapsed
  elapsed=$(time_it env --chdir="$workdir/project" YARN_GLOBAL_FOLDER="$globalfolder" \
    YARNSTATIC_BUCKET="$YARNSTATIC_BUCKET" YARNSTATIC_KEY_PREFIX="$YARNSTATIC_KEY_PREFIX" \
    YARNSTATIC_REGION="$YARNSTATIC_REGION" YARNSTATIC_PROFILE="$AWS_PROFILE" \
    corepack yarn install --immutable)
  record "yarn-daemon" "$elapsed"
}

run_yarn_aws_fallback() {
  local run="$1"
  local workdir; workdir=$(new_workdir)
  WORKDIRS+=("$workdir")
  local globalfolder; globalfolder=$(mktemp -d)
  WORKDIRS+=("$globalfolder")
  setup_project "$workdir"
  ( cd "$workdir/project" && env PATH="$NO_YARNSTATIC_PATH" YARN_GLOBAL_FOLDER="$globalfolder" corepack yarn plugin import "$DAEMON_PLUGIN_BUNDLE" >/dev/null )
  echo "  [yarn-aws-fallback run $run]"
  local elapsed
  elapsed=$(time_it env --chdir="$workdir/project" PATH="$NO_YARNSTATIC_PATH" YARN_GLOBAL_FOLDER="$globalfolder" \
    YARNSTATIC_BUCKET="$YARNSTATIC_BUCKET" YARNSTATIC_KEY_PREFIX="$YARNSTATIC_KEY_PREFIX" \
    YARNSTATIC_REGION="$YARNSTATIC_REGION" YARNSTATIC_PROFILE="$AWS_PROFILE" \
    corepack yarn install --immutable)
  record "yarn-aws-fallback" "$elapsed"
}

run_yarn_s3_plugin() {
  local run="$1"
  local workdir; workdir=$(new_workdir)
  WORKDIRS+=("$workdir")
  local globalfolder; globalfolder=$(mktemp -d)
  WORKDIRS+=("$globalfolder")
  setup_project "$workdir"
  ( cd "$workdir/project" && env YARN_GLOBAL_FOLDER="$globalfolder" corepack yarn plugin import "$S3_PLUGIN_BUNDLE" >/dev/null )
  echo "  [yarn-s3-plugin run $run]"
  local elapsed
  elapsed=$(time_it env --chdir="$workdir/project" YARN_GLOBAL_FOLDER="$globalfolder" \
    YARNSTATIC_BUCKET="$YARNSTATIC_BUCKET" YARNSTATIC_KEY_PREFIX="$YARNSTATIC_KEY_PREFIX" \
    YARNSTATIC_REGION="$YARNSTATIC_REGION" YARNSTATIC_PROFILE="$AWS_PROFILE" \
    corepack yarn install --immutable)
  record "yarn-s3-plugin" "$elapsed"
}

echo "Benchmarking $RUNS run(s) per scenario against:"
echo "  project:  $PROJECT"
echo "  bucket:   s3://$YARNSTATIC_BUCKET/$YARNSTATIC_KEY_PREFIX (region $YARNSTATIC_REGION, profile $AWS_PROFILE)"
echo

for i in $(seq 1 "$RUNS"); do
  echo "== round $i/$RUNS =="
  run_npm_install "$i"
  run_yarn_no_plugin "$i"
  run_yarn_daemon "$i"
  run_yarn_aws_fallback "$i"
  run_yarn_s3_plugin "$i"
done

echo
echo "=== Summary (seconds) ==="
# Fixed scenario order (not sorted -- alphabetical would separate
# yarn-daemon from yarn-aws-fallback from yarn-s3-plugin, when the whole
# point is comparing them side by side in a meaningful order).
awk -v order="npm-install yarn-no-plugin yarn-daemon yarn-aws-fallback yarn-s3-plugin" '
  { sum[$1]+=$2; count[$1]++; if (!($1 in min) || $2<min[$1]) min[$1]=$2; if ($2>max[$1]) max[$1]=$2; runs[$1] = runs[$1] " " $2 }
  END {
    printf "%-20s %8s %8s %8s %8s  %s\n", "scenario", "mean", "min", "max", "n", "runs"
    n = split(order, scenarios, " ")
    for (i = 1; i <= n; i++) {
      s = scenarios[i]
      if (s in sum) printf "%-20s %8.2f %8.2f %8.2f %8d %s\n", s, sum[s]/count[s], min[s], max[s], count[s], runs[s]
    }
  }
' "$RESULTS_FILE"
