#!/usr/bin/env bash
# neuromcp — consolidation runner (portable)
#
# Triggered by launchd/cron or manually. Skips the run when fewer than
# $PENDING_THRESHOLD sessions are unprocessed, to keep cost bounded.
#
# Exit codes:
#   0 = ran (or threshold not met — nothing to do)
#   non-zero = script or Python error bubbling up

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="${NEUROMCP_LOG:-$HOME/.neuromcp/consolidation.log}"
LEDGER="${NEUROMCP_LEDGER:-$HOME/.neuromcp/consolidation-ledger.json}"
SESSIONS_DIR="${NEUROMCP_SESSIONS_DIR:-$HOME/.neuromcp/raw/sessions}"
PENDING_THRESHOLD="${NEUROMCP_PENDING_THRESHOLD:-5}"
WINDOW_DAYS="${NEUROMCP_WINDOW_DAYS:-7}"
PYTHON_BIN="${NEUROMCP_PYTHON:-python3}"

mkdir -p "$(dirname "$LOG")"
printf '[%s] start\n' "$(date '+%Y-%m-%d %H:%M:%S')" >>"$LOG"

if [ ! -d "$SESSIONS_DIR" ]; then
    printf '[%s] no sessions dir (%s), skip\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$SESSIONS_DIR" >>"$LOG"
    exit 0
fi

# Count sessions (portable: avoid glob failures + excludes checkpoints)
TOTAL=$(find "$SESSIONS_DIR" -maxdepth 1 -type f -name '*.md' ! -name '*checkpoint*' 2>/dev/null | wc -l | tr -d ' ')
DONE=0
if [ -f "$LEDGER" ]; then
    DONE=$("$PYTHON_BIN" -c "import json,sys; d=json.load(open('$LEDGER')); print(len(d.get('processed',[])))" 2>/dev/null || printf '0')
fi
PENDING=$((TOTAL - DONE))
printf '[%s] pending=%s total=%s done=%s threshold=%s\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$PENDING" "$TOTAL" "$DONE" "$PENDING_THRESHOLD" >>"$LOG"

if [ "$PENDING" -lt "$PENDING_THRESHOLD" ]; then
    printf '[%s] below threshold, skip\n' "$(date '+%Y-%m-%d %H:%M:%S')" >>"$LOG"
    exit 0
fi

# Compute <today - WINDOW_DAYS> in a POSIX-portable way (works on macOS + Linux)
SINCE=$("$PYTHON_BIN" -c "from datetime import date, timedelta; print((date.today()-timedelta(days=$WINDOW_DAYS)).isoformat())")

"$PYTHON_BIN" "$SCRIPT_DIR/consolidate-sessions.py" --since "$SINCE" 2>&1 | tee -a "$LOG"

printf '[%s] done\n' "$(date '+%Y-%m-%d %H:%M:%S')" >>"$LOG"
