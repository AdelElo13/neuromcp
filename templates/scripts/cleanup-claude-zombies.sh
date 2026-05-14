#!/usr/bin/env bash
# cleanup-claude-zombies.sh
#
# Reap zombie sessions from the Claude desktop app's session storage.
# Triggered by ~/Library/LaunchAgents/com.adel.claude-zombie-cleanup.plist
# every CLEANUP_INTERVAL seconds (default 300).
#
# A "zombie" is a local_*.json metadata file where:
#   - lastActivityAt - createdAt < ZOMBIE_MAX_LIFETIME_MS  (default 30s)
#   - createdAt is older than ZOMBIE_MIN_AGE_MS            (default 1h)
#     (don't touch fresh sessions that might still be in progress)
#
# Action: mv to .trash-zombies-<YYYYMMDD>/  inside the same dir.
# .trash dirs older than ZOMBIE_TRASH_RETENTION_DAYS (default 7) are deleted.
#
# Env overrides:
#   ZOMBIE_MAX_LIFETIME_MS    (default 30000  = 30s)
#   ZOMBIE_MIN_AGE_MS         (default 3600000 = 1h)
#   ZOMBIE_TRASH_RETENTION_DAYS (default 7)
#   ZOMBIE_DRY_RUN=1          (don't move anything, just log)
#
# Logs to ~/.claude/logs/claude-zombie-cleanup.log

set -euo pipefail

MAX_LIFETIME="${ZOMBIE_MAX_LIFETIME_MS:-30000}"
MIN_AGE="${ZOMBIE_MIN_AGE_MS:-3600000}"
TRASH_RETENTION_DAYS="${ZOMBIE_TRASH_RETENTION_DAYS:-7}"
DRY_RUN="${ZOMBIE_DRY_RUN:-0}"

SESSIONS_ROOT="${HOME}/Library/Application Support/Claude/claude-code-sessions"
LOG_DIR="${HOME}/.claude/logs"
LOG_FILE="${LOG_DIR}/claude-zombie-cleanup.log"
TODAY=$(date +%Y%m%d-%H%M%S)
NOW_MS=$(($(date +%s) * 1000))

mkdir -p "$LOG_DIR"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG_FILE"; }

if [ ! -d "$SESSIONS_ROOT" ]; then
  log "Sessions root not found: $SESSIONS_ROOT — exiting"
  exit 0
fi

REAPED=0
SKIPPED=0
SCANNED=0

while IFS= read -r -d '' file; do
  SCANNED=$((SCANNED + 1))
  basename=$(basename "$file")

  # Parse with jq; if jq fails, skip
  created=$(jq -r '.createdAt // empty' "$file" 2>/dev/null || true)
  last_act=$(jq -r '.lastActivityAt // empty' "$file" 2>/dev/null || true)
  title=$(jq -r '.title // "(no title)"' "$file" 2>/dev/null || echo "(parse error)")

  if [ -z "$created" ] || [ -z "$last_act" ]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  lifetime=$((last_act - created))
  age=$((NOW_MS - created))

  if [ "$lifetime" -lt "$MAX_LIFETIME" ] && [ "$age" -gt "$MIN_AGE" ]; then
    parent=$(dirname "$file")
    trash="${parent}/.trash-zombies-${TODAY}"
    if [ "$DRY_RUN" = "1" ]; then
      log "DRY-RUN reap: ${basename}  lifetime=${lifetime}ms age=${age}ms title=\"${title}\""
    else
      mkdir -p "$trash"
      mv "$file" "$trash/"
      log "Reaped: ${basename}  lifetime=${lifetime}ms title=\"${title}\" → ${trash}"
    fi
    REAPED=$((REAPED + 1))
  fi
done < <(find "$SESSIONS_ROOT" -type f -name 'local_*.json' -print0 2>/dev/null)

# Garbage-collect old .trash-zombies-* directories
GC=0
if [ "$DRY_RUN" != "1" ]; then
  while IFS= read -r -d '' trash_dir; do
    rm -rf "$trash_dir"
    GC=$((GC + 1))
    log "GC: removed old trash dir ${trash_dir}"
  done < <(find "$SESSIONS_ROOT" -type d -name '.trash-zombies-*' -mtime "+${TRASH_RETENTION_DAYS}" -print0 2>/dev/null)
fi

log "Pass complete: scanned=${SCANNED} reaped=${REAPED} skipped=${SKIPPED} gc=${GC} (dry_run=${DRY_RUN})"
