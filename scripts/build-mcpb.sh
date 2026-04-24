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

# 3. Install runtime deps only inside the staging dir. This rebuilds
#    better-sqlite3 for the host Node ABI. Consumers with the same major
#    Node version (>=20) will use these binaries; mismatched hosts will
#    npm-rebuild at install-time via the postinstall hook in package.json.
echo "[build-mcpb] installing runtime deps (omit dev+optional)..."
( cd "${STAGING}" && npm ci --omit=dev --omit=optional --ignore-scripts >/dev/null 2>&1 || \
  npm install --omit=dev --omit=optional --ignore-scripts >/dev/null 2>&1 )

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
