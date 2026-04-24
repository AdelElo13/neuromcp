#!/bin/sh
# neuromcp — cross-platform launcher for the .mcpb bundle.
#
# Why this exists:
#   Claude Desktop on macOS runs extensions under Hardened Runtime with
#   library validation. Its bundled Node is signed with Anthropic's Team
#   ID, and refuses to dlopen native .node / .dylib files that carry a
#   different Team ID (or ad-hoc signatures). neuromcp depends on
#   better-sqlite3 (NAN) and sqlite-vec (dylib) — both native.
#
#   Workaround: spawn the MCP server via the USER's Node instead of
#   Claude Desktop's bundled one. A user-installed Node is typically
#   ad-hoc signed or signed with the user's Team ID, so its child
#   process inherits relaxed library loading and our native deps load.
#
#   This script:
#     1. Finds Node on the user's system (any install path)
#     2. If native deps are ABI-incompatible with that Node, rebuilds
#        them once, then caches success via .native-abi marker
#     3. Execs the server
#
# Supported: macOS arm64/x86_64, Linux arm64/x86_64. A .cmd companion
# is needed for Windows — tracked separately.
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
PROJ_DIR=$(cd "$DIR/.." && pwd)
LOG_PREFIX="[neuromcp-launcher]"

log() { printf "%s %s\n" "$LOG_PREFIX" "$*" >&2; }

find_node() {
  # Priority order:
  #   1. NEUROMCP_NODE env override (power users / CI)
  #   2. PATH lookup
  #   3. Common macOS install locations
  #   4. Common Linux install locations
  for candidate in \
    "${NEUROMCP_NODE:-}" \
    "$(command -v node 2>/dev/null || true)" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.nvm/versions/node/$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin/node"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

find_npm_for() {
  node_bin=$1
  # npm is almost always next to node. Fallback to PATH search.
  candidate="$(dirname "$node_bin")/npm"
  if [ -x "$candidate" ]; then
    echo "$candidate"
    return 0
  fi
  command -v npm 2>/dev/null
}

native_ok() {
  node_bin=$1
  # ABI probe: better-sqlite3 dlopens lazily on first Database() call,
  # so `require()` alone doesn't surface ABI/Team-ID mismatches. Force
  # the native bindings to actually load by constructing an in-memory DB.
  "$node_bin" -e "const D=require('$PROJ_DIR/node_modules/better-sqlite3'); new D(':memory:').close()" >/dev/null 2>&1
}

rebuild_native() {
  node_bin=$1
  npm_bin=$(find_npm_for "$node_bin" || true)
  if [ -z "$npm_bin" ]; then
    log "cannot auto-rebuild: no npm next to $node_bin. Please install Node 20+ with npm."
    return 1
  fi
  node_ver=$("$node_bin" --version)
  modules_ver=$("$node_bin" -p 'process.versions.modules')
  log "rebuilding native modules for $node_ver (modules=$modules_ver)..."
  # npm install (not rebuild) so better-sqlite3's postinstall re-runs
  # prebuild-install and fetches the binary matching the target Node's
  # ABI from its release CDN. `--no-save` keeps package-lock.json clean.
  if ! ( cd "$PROJ_DIR" && "$npm_bin" install --no-save better-sqlite3 sqlite-vec 2>&1 | tail -8 >&2 ); then
    log "rebuild failed. Most common cause: build tools missing."
    log "  macOS: xcode-select --install"
    log "  Linux: apt install build-essential python3   (or distro equivalent)"
    log "Alternatively, run neuromcp with Node 24 or 25 which ship matching prebuilds."
    return 1
  fi
  # Drop a marker so future launches can skip the probe quickly.
  printf '%s %s\n' "$node_ver" "$modules_ver" > "$PROJ_DIR/.native-abi" 2>/dev/null || true
  log "rebuild OK."
}

main() {
  NODE=$(find_node) || {
    log "could not find Node.js on PATH. Install Node 20+ from https://nodejs.org and retry."
    exit 127
  }

  if ! native_ok "$NODE"; then
    rebuild_native "$NODE" || exit 1
    if ! native_ok "$NODE"; then
      log "native modules still failing after rebuild — aborting."
      exit 1
    fi
  fi

  exec "$NODE" "$PROJ_DIR/dist/index.js"
}

main "$@"
