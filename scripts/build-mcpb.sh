#!/bin/bash
# Build neuromcp as an MCP Bundle (.mcpb) for one-click install into Claude
# Desktop, Claude Code, Cursor, and other MCP-compatible clients.
#
# Input:  neuromcp source tree (src/, package.json, manifest.json)
# Output: release-artifacts/neuromcp-v<VERSION>.mcpb
#
# Why a bundle? Users should not have to `npm i -g neuromcp && edit
# claude_desktop_config.json manually`. A .mcpb is a signed, self-contained
# zip that Claude Desktop installs with a double-click.
#
# Why prune devDependencies + optional? The shipped bundle must be small,
# reproducible, and free of build-time cruft. We ship runtime deps only,
# then rely on the consumer's Node for execution. Native deps
# (better-sqlite3) ship as prebuilt binaries matching the bundle's Node
# ABI via npm's prebuilt binary protocol.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

VERSION="$(node -p "require('./package.json').version")"
OUT_DIR="${PROJECT_ROOT}/release-artifacts"
STAGING="${PROJECT_ROOT}/.mcpb-staging"
MCPB_NAME="neuromcp-v${VERSION}.mcpb"

echo "[build-mcpb] version=${VERSION}"

# 1. Fresh build of dist/
echo "[build-mcpb] npm run build..."
npm run build

# 2. Stage a clean copy. Skipping git worktree so we don't fight uncommitted
#    state; rsync the files we need and omit what we don't.
echo "[build-mcpb] staging at ${STAGING}..."
rm -rf "${STAGING}" "${OUT_DIR}"
mkdir -p "${STAGING}" "${OUT_DIR}"

rsync -a --delete \
  --include='dist/***' \
  --include='bin/***' \
  --include='scripts/***' \
  --include='templates/***' \
  --include='manifest.json' \
  --include='package.json' \
  --include='package-lock.json' \
  --include='README.md' \
  --include='LICENSE' \
  --include='LICENSE-EXAMPLES' \
  --include='CHANGELOG.md' \
  --exclude='*' \
  "${PROJECT_ROOT}/" "${STAGING}/"

# 3. Install runtime deps inside the staging dir. CRITICAL decisions:
#    - do NOT pass --ignore-scripts — better-sqlite3 relies on a
#      prebuild-install postinstall hook to download the native binary
#      matching the target Node ABI. Without that hook the .node file
#      is absent and Claude Desktop's bundled Node fails with
#      "Could not locate the bindings file". (ref 2026-04-24T19:13:11)
#    - do NOT pass --omit=optional — sqlite-vec distributes its native
#      binary via optionalDependencies pattern (sqlite-vec-darwin-arm64
#      etc.). Omitting optional drops them and the server fails with
#      ERR_MODULE_NOT_FOUND 'sqlite-vec-darwin-arm64'. (ref 19:14:56)
echo "[build-mcpb] installing runtime deps (omit dev only, scripts ON)..."
# CRITICAL: use the Homebrew Node so prebuild-install downloads the
# matching ABI. Claude Desktop's built-in Node is signed with Anthropic's
# Team ID and Hardened Runtime rejects differently-signed native modules,
# so the mcp_config spawns the consumer's Homebrew Node instead; the
# shipped better-sqlite3.node must therefore match that Node's ABI.
TARGET_NODE="${TARGET_NODE:-/opt/homebrew/bin/node}"
TARGET_NPM="${TARGET_NPM:-/opt/homebrew/bin/npm}"
echo "[build-mcpb] target node: $($TARGET_NODE --version) (modules=$($TARGET_NODE -p 'process.versions.modules'))"
(
  cd "${STAGING}"
  PATH="/opt/homebrew/bin:$PATH"
  export PATH
  "$TARGET_NPM" ci --omit=dev 2>&1 | tail -5 || \
    "$TARGET_NPM" install --omit=dev 2>&1 | tail -5
)

# 3b. Sanity check: both native deps must be present after install.
BS_BIN="${STAGING}/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
VEC_PKG="${STAGING}/node_modules/sqlite-vec-darwin-arm64/package.json"
if [ ! -f "$BS_BIN" ]; then
    echo "[build-mcpb] FATAL: better-sqlite3 native binary missing at $BS_BIN" >&2
    exit 1
fi
if [ ! -f "$VEC_PKG" ]; then
    echo "[build-mcpb] WARNING: sqlite-vec-darwin-arm64 optional dep missing (non-arm64 host?)" >&2
fi
echo "[build-mcpb] better-sqlite3 binary OK ($(file "$BS_BIN" | cut -d: -f2 | xargs))"
[ -f "$VEC_PKG" ] && echo "[build-mcpb] sqlite-vec-darwin-arm64 OK"

# 4. Pack via the official Anthropic mcpb CLI
echo "[build-mcpb] packing..."
npx -y @anthropic-ai/mcpb@latest pack "${STAGING}" "${OUT_DIR}/${MCPB_NAME}" 2>&1 | tail -5

# 5. SHA256 + size
SIZE=$(du -h "${OUT_DIR}/${MCPB_NAME}" | cut -f1)
SHA=$(shasum -a 256 "${OUT_DIR}/${MCPB_NAME}" | cut -d' ' -f1)
echo "[build-mcpb] produced ${MCPB_NAME} (${SIZE}, sha256=${SHA})"

# 6. Validate round-trip
npx -y @anthropic-ai/mcpb@latest info "${OUT_DIR}/${MCPB_NAME}" 2>&1 | head -15 || true

# 7. Clean staging
rm -rf "${STAGING}"

echo "[build-mcpb] done. Upload to GH release with:"
echo "  gh release upload v${VERSION} ${OUT_DIR}/${MCPB_NAME}"
