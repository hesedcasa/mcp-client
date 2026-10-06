#!/usr/bin/env bash
# Runs the end-to-end suite against two live MCP servers (GitHub, Context7) —
# twice: once through the built standalone CLI, then again through the latest
# sdkck host CLI with this build packed and installed as its @hesed/mcp-client
# plugin.
#
# The credentials come from Infisical: when they aren't already exported, the
# script re-runs itself under `infisical run`, signed in either by a one-time
# `infisical login` or, in a headless sandbox, by a machine identity's
# INFISICAL_UNIVERSAL_AUTH_CLIENT_ID and INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET.
#
#   npm run test:e2e
#   npm run test:e2e -- --grep "sweep"   # extra args go through to mocha
#
# There is no container to start: these are hosted MCP servers, so the live
# accounts play the role a disposable container plays elsewhere. The suite is
# read-only — it never writes to either account — so there is nothing to sweep
# afterwards.
set -euo pipefail

cd "$(dirname "$0")/.."

# E2E_VIA_INFISICAL stops a second re-exec when Infisical lacks a secret. The
# absolute path matters: $0 may be relative to the directory we just left.
if { [ -z "${GITHUB_TOKEN:-}" ] || [ -z "${CONTEXT7_API_KEY:-}" ]; } &&
  [ -z "${E2E_VIA_INFISICAL:-}" ] && command -v infisical >/dev/null; then
  infisical_args=(--silent)
  if [ -n "${INFISICAL_UNIVERSAL_AUTH_CLIENT_ID:-}" ]; then
    # The CLI reads the client id and secret from the environment; passing
    # them as flags would put the secret in the process list.
    INFISICAL_TOKEN="$(infisical login --method=universal-auth --silent --plain)"
    export INFISICAL_TOKEN
  fi
  # A machine identity token ignores .infisical.json, so pass its project ID.
  if [ -n "${INFISICAL_TOKEN:-}" ]; then
    infisical_args+=(--projectId "$(node -p "require('./.infisical.json').workspaceId")")
  fi
  E2E_VIA_INFISICAL=1 exec infisical run "${infisical_args[@]}" -- "$PWD/scripts/e2e.sh" "$@"
fi

# The GitHub and Context7 credentials are all the tests need; keep the
# Infisical ones out of their environment.
unset INFISICAL_TOKEN INFISICAL_UNIVERSAL_AUTH_CLIENT_ID INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET

MOCHA_ARGS=("$@")

missing=()
for var in GITHUB_TOKEN CONTEXT7_API_KEY; do
  if [ -z "${!var:-}" ]; then
    missing+=("$var")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "error: missing credentials: ${missing[*]}" >&2
  echo "Check they exist in Infisical's dev environment and that the" >&2
  echo "Infisical CLI is installed and logged in (infisical login), or set" >&2
  echo "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID and _CLIENT_SECRET." >&2
  exit 1
fi

# The throwaway sdkck home this script creates, if it got that far. Deliberately
# NOT named SDKCK_HOME: an inherited SDKCK_HOME could point at the developer's
# real sdkck setup, and the EXIT trap must never rm -rf that. This variable only
# ever holds a path this script itself mktemp'd.
SDKCK_E2E_HOME=""

# Runs on the way out, including after a failing leg. There are no fixtures to
# sweep: the suite only reads.
cleanup() {
  local status=$?
  # A setup step that aborts under `set -e` after a failed leg would otherwise
  # replace that leg's status; the first failure is the one to report.
  if [ "${EXIT_STATUS:-0}" -ne 0 ]; then
    status=$EXIT_STATUS
  fi

  if [ -n "$SDKCK_E2E_HOME" ]; then
    # `npm pack` can fail after `prepack` has already rewritten README.md, so
    # the restore lives here rather than only after the pack.
    if [ -f "$SDKCK_E2E_HOME/README.md.orig" ]; then
      cp "$SDKCK_E2E_HOME/README.md.orig" README.md
    fi
    rm -rf "$SDKCK_E2E_HOME"
  fi

  exit "$status"
}
trap cleanup EXIT

run_mocha() {
  # Delegates to the `e2e:mocha` script rather than calling mocha directly, so
  # both entry points share one glob and one timeout.
  # The +expansion guard keeps `set -u` happy with an empty array on bash 3.2.
  npm run --silent e2e:mocha -- ${MOCHA_ARGS[@]+"${MOCHA_ARGS[@]}"}
}

# Records the first failing leg's status. A later leg failing with a different
# status must not overwrite an earlier failure: the script's contract is to
# exit with the first failure it saw.
EXIT_STATUS=0
record_failure() {
  local leg_status=$?
  [ "$EXIT_STATUS" -ne 0 ] || EXIT_STATUS=$leg_status
}

echo "==> Building the CLI"
# Not `npm run build`: that is `shx rm -rf dist && tsc -b`, and with the
# composite tsbuildinfo living at the repo root, `tsc -b` considers a build
# whose dist/ was just deleted "up to date" and emits nothing — every
# subprocess then dies with MODULE_NOT_FOUND. --force rebuilds regardless of
# the buildinfo's view of the world.
# The build runs repository and dependency scripts that never need the
# credentials, so they are stripped there as for the sdkck installs.
rm -rf dist
env -u GITHUB_TOKEN -u CONTEXT7_API_KEY npx tsc -b --force

echo "==> Running end-to-end tests against GitHub and Context7"
# Both legs always run: a standalone-leg failure says nothing about the packed
# plugin, and vice versa. The `|| record_failure` form keeps `set -e` from
# aborting so the sdkck leg still executes; the first failure becomes the exit
# code.
run_mocha || record_failure

# Second leg: the same suite through the sdkck host CLI, with this build
# installed as its @hesed/mcp-client plugin.
echo "==> Downloading the latest sdkck"
# --no-save resolves "latest" from the registry on every run without touching
# package.json; the binary comes from node_modules/.bin. The install runs with
# the credentials stripped from the environment: a lifecycle script of the
# freshly fetched package is arbitrary code from a mutable release, and never
# needs them.
env -u GITHUB_TOKEN -u CONTEXT7_API_KEY npm install --silent --no-save sdkck
export PATH="$PWD/node_modules/.bin:$PATH"

# A throwaway sdkck home keeps the plugin install, its config and its caches
# out of the developer's real sdkck setup; the test side finds it via
# E2E_SDKCK_HOME.
SDKCK_E2E_HOME="$(mktemp -d)"
export E2E_SDKCK_HOME="$SDKCK_E2E_HOME"
SDKCK_DIRS=(
  SDKCK_CACHE_DIR="$SDKCK_E2E_HOME/cache"
  SDKCK_CONFIG_DIR="$SDKCK_E2E_HOME/config"
  SDKCK_DATA_DIR="$SDKCK_E2E_HOME/data"
)

# A fresh home cannot hold the plugin yet; if it does, the leg would test
# whatever is there rather than this build. `plugins inspect` is a host
# command, so the probe cannot itself trigger sdkck's first-use install.
if env -u GITHUB_TOKEN -u CONTEXT7_API_KEY \
  "${SDKCK_DIRS[@]}" sdkck plugins inspect @hesed/mcp-client --json >/dev/null 2>&1; then
  echo "error: @hesed/mcp-client is already installed in the throwaway sdkck home" >&2
  exit 1
fi

echo "==> Packing the current build and installing it as an sdkck plugin"
# npm pack runs `prepack`, regenerating oclif.manifest.json and the README —
# the same artifacts the publish workflow ships — so the sdkck leg exercises
# the real install artifact, not just the working tree. Packing straight into
# the throwaway home keeps the tarball out of the repo root; the EXIT trap
# removes it with the rest of the home.
# `oclif readme` stamps the local platform into README.md's usage block, so
# the committed README is backed up here and put back by the EXIT trap rather
# than left modified. `prepack` runs repository scripts and needs no
# credentials, so they are stripped here too.
cp README.md "$SDKCK_E2E_HOME/README.md.orig"
TGZ="$(env -u GITHUB_TOKEN -u CONTEXT7_API_KEY \
  npm pack --pack-destination "$SDKCK_E2E_HOME" | tail -n 1)"
# A move, not a copy: once README.md is back, the EXIT trap must have nothing
# left to restore, or it would overwrite edits made while the sdkck leg runs.
mv "$SDKCK_E2E_HOME/README.md.orig" README.md

# Installing here — before any `sdkck mcp` invocation — stops sdkck's JIT
# installer (@hesed/mcp-client is one of its jitPlugins) from pulling the
# published release over the build under test. The tarball must be passed as a `file:` URL:
# sdkck resolves any bare path containing a slash as a GitHub org/repo.
# Credentials are stripped here too: the install handles a local tarball and
# needs none, so the mocha legs are the only steps that hold them under sdkck.
env -u GITHUB_TOKEN -u CONTEXT7_API_KEY \
  "${SDKCK_DIRS[@]}" sdkck plugins install "file:$SDKCK_E2E_HOME/$TGZ"

# Prove dispatch resolves to the tarball this run packed, not a published
# release the auto-installer could have fetched: the install record sdkck
# writes under the data dir must carry our file: URL. The record is read from
# disk rather than via `sdkck plugins inspect`, which has been observed to die
# on an unsettled top-level await right after loading a freshly installed
# plugin.
grep -Fq "\"file:$SDKCK_E2E_HOME/$TGZ\"" "$SDKCK_E2E_HOME/data/package.json" || {
  echo "error: sdkck did not register the packed tarball as @hesed/mcp-client" >&2
  exit 1
}

echo "==> Running end-to-end tests via sdkck"
E2E_HOST_CLI=sdkck run_mocha || record_failure

exit "$EXIT_STATUS"
