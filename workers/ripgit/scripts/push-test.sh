#!/usr/bin/env bash
#
# push-test.sh — End-to-end incremental push test for ripgit.
#
# Clones a repo (if needed), configures the ripgit remote, deletes the remote
# repo to start clean, enables bulk mode, pushes incrementally, rebuilds
# indexes, and verifies.
#
# Usage:
#   ./scripts/push-test.sh [options]
#
# Options:
#   -r, --repo PATH        Local repo path (default: ../openclaw)
#   -n, --name NAME        Repo name on ripgit (default: basename of repo path)
#   -u, --owner NAME       Owner name on ripgit (default: test)
#   -t, --token TOKEN      Access token (from /settings). Embeds in git URL, sent as Bearer for curl.
#   -o, --origin URL       Git clone URL (used if local repo doesn't exist)
#   -s, --step SIZE        First-parent commits per push (default: 200)
#   -w, --worker URL       Worker base URL (default: https://ripgit.stevej.workers.dev)
#   -b, --branch BRANCH    Branch to push (default: main)
#   --no-delete            Don't delete the remote repo first (resume mode)
#   --no-rebuild           Skip post-push index rebuilds
#   --skip-to N            Skip first N checkpoints (resume from checkpoint N+1)
#   -h, --help             Show this help
#
# Examples:
#   # Fresh push of openclaw with 200-commit steps
#   ./scripts/push-test.sh -r ../openclaw -s 200
#
#   # Resume from checkpoint 50 (e.g., after fixing a bug mid-push)
#   ./scripts/push-test.sh -r ../openclaw --no-delete --skip-to 50
#
#   # Push a different repo
#   ./scripts/push-test.sh -r /tmp/myrepo -o https://github.com/user/myrepo -s 100
#
set -euo pipefail

# --- Defaults ---
REPO_PATH="../curl"
REPO_NAME=""
OWNER="test"
TOKEN=""
ORIGIN_URL=""
STEP=200
WORKER_URL="https://git.theagents.company"
BRANCH="main"
DO_DELETE=false
DO_REBUILD=true
SKIP_TO=0

# --- Parse args ---
while [[ $# -gt 0 ]]; do
  case $1 in
    -r|--repo)     REPO_PATH="$2"; shift 2 ;;
    -n|--name)     REPO_NAME="$2"; shift 2 ;;
    -u|--owner)    OWNER="$2"; shift 2 ;;
    -t|--token)    TOKEN="$2"; shift 2 ;;
    -o|--origin)   ORIGIN_URL="$2"; shift 2 ;;
    -s|--step)     STEP="$2"; shift 2 ;;
    -w|--worker)   WORKER_URL="$2"; shift 2 ;;
    -b|--branch)   BRANCH="$2"; shift 2 ;;
    --no-tail)     shift ;;  # no-op, kept for backwards compat
    --no-delete)   DO_DELETE=false; shift ;;
    --no-rebuild)  DO_REBUILD=false; shift ;;
    --skip-to)     SKIP_TO="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,/^$/{ s/^# //; s/^#//; p }' "$0"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Resolve repo path to absolute
REPO_PATH="$(cd "$(dirname "$REPO_PATH")" && pwd)/$(basename "$REPO_PATH")"

# Default repo name from path
if [[ -z "$REPO_NAME" ]]; then
  REPO_NAME="$(basename "$REPO_PATH")"
fi

BASE_URL="${WORKER_URL}/${OWNER}/${REPO_NAME}"
REMOTE_NAME="ripgit"

# Git needs credentials embedded in the URL.
# curl uses a Bearer header so the token isn't logged in process lists.
if [[ -n "$TOKEN" ]]; then
  SCHEME="${WORKER_URL%%://*}"
  HOST="${WORKER_URL#*://}"
  GIT_URL="${SCHEME}://${OWNER}:${TOKEN}@${HOST}/${OWNER}/${REPO_NAME}"
  CURL_OPTS=(-H "Authorization: Bearer ${TOKEN}")
else
  GIT_URL="${BASE_URL}"
  CURL_OPTS=()
  warn "No --token provided. Push will fail if auth is required."
fi

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${CYAN}[ripgit]${NC} $*"; }
ok()   { echo -e "${GREEN}[  ok  ]${NC} $*"; }
warn() { echo -e "${YELLOW}[ warn ]${NC} $*"; }
fail() { echo -e "${RED}[FAIL  ]${NC} $*"; }

# --- Cleanup on exit ---
TAIL_PID=""
cleanup() {
  if [[ -n "$TAIL_PID" ]]; then
    kill "$TAIL_PID" 2>/dev/null || true
    wait "$TAIL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# --- 1. Ensure local repo exists ---
if [[ ! -d "$REPO_PATH/.git" ]]; then
  if [[ -z "$ORIGIN_URL" ]]; then
    fail "Local repo not found at $REPO_PATH and no --origin URL provided"
    exit 1
  fi
  log "Cloning $ORIGIN_URL -> $REPO_PATH ..."
  git clone "$ORIGIN_URL" "$REPO_PATH"
fi
ok "Local repo: $REPO_PATH"

# --- 3. Configure ripgit remote ---
cd "$REPO_PATH"

if git remote get-url "$REMOTE_NAME" &>/dev/null; then
  CURRENT_URL=$(git remote get-url "$REMOTE_NAME")
  if [[ "$CURRENT_URL" != "$GIT_URL" ]]; then
    git remote set-url "$REMOTE_NAME" "$GIT_URL"
    warn "Updated remote $REMOTE_NAME URL"
  fi
else
  git remote add "$REMOTE_NAME" "$GIT_URL"
fi
ok "Remote: $REMOTE_NAME -> ${BASE_URL}"  # log without token

# --- 4. Gather commit info ---
TOTAL_FP=$(git rev-list --first-parent --count "$BRANCH")
TOTAL_ALL=$(git rev-list --count "$BRANCH")
log "Branch $BRANCH: $TOTAL_FP first-parent commits ($TOTAL_ALL total), step size $STEP"

# Build checkpoint list
CHECKPOINTS_FILE=$(mktemp)
git log --first-parent --reverse --format='%H' "$BRANCH" \
  | awk "NR % $STEP == 0" > "$CHECKPOINTS_FILE"
NUM_CHECKPOINTS=$(wc -l < "$CHECKPOINTS_FILE" | tr -d ' ')
log "Generated $NUM_CHECKPOINTS checkpoints (every ${STEP} fp commits)"

# --- 5. Delete remote repo ---
if $DO_DELETE; then
  log "Deleting remote repo $REPO_NAME ..."
  RESULT=$(curl -s "${CURL_OPTS[@]}" -X DELETE "${BASE_URL}/")
  if [[ "$RESULT" == "deleted" ]]; then
    ok "Remote repo deleted"
  else
    warn "Delete response: $RESULT"
  fi
fi

# --- 6. Enable bulk mode ---
log "Setting skip_fts=1 (bulk mode) ..."
curl -s "${CURL_OPTS[@]}" -X PUT "${BASE_URL}/admin/config?key=skip_fts&value=1" > /dev/null
ok "Bulk mode enabled"

# Reset remote tracking
git fetch "$REMOTE_NAME" 2>/dev/null || true

# --- 7. Push checkpoints ---
MAX_PACK_BYTES=30000000  # 30 MB — keeps well within 128 MB DO memory limit

# push_sha: push a single SHA, return 0 on success
push_sha() {
  local target_sha="$1"
  local label="$2"
  RC=0
  OUTPUT=$(git push "$REMOTE_NAME" "${target_sha}:refs/heads/${BRANCH}" 2>&1) || RC=$?
  if [[ $RC -eq 0 ]]; then
    echo -e "${GREEN}OK${NC} ${label}"
    PUSH_OK=$((PUSH_OK+1))
    return 0
  else
    echo -e "${RED}FAILED${NC} ${label}"
    echo "$OUTPUT" | head -5
    return 1
  fi
}

# push_range: push from current remote HEAD to target_sha.
# If pack would exceed MAX_PACK_BYTES, recursively split in half.
push_range() {
  local target_sha="$1"
  local fp_start="$2"   # first-parent index of range start
  local fp_end="$3"     # first-parent index of target

  # Get current remote ref
  local current_ref
  current_ref=$(git rev-parse "refs/remotes/${REMOTE_NAME}/${BRANCH}" 2>/dev/null || echo "")
  if [[ -z "$current_ref" ]]; then
    # No remote ref yet (first push) — just push directly
    push_sha "$target_sha" ""
    return $?
  fi

  # Estimate pack size
  local pack_size
  pack_size=$(git pack-objects --revs --stdout --thin <<PACKEOF 2>/dev/null | wc -c
${target_sha}
^${current_ref}
PACKEOF
  )
  pack_size=$(echo "$pack_size" | tr -d ' ')

  if [[ "$pack_size" -le "$MAX_PACK_BYTES" ]]; then
    # Small enough — push directly
    push_sha "$target_sha" "(${pack_size} bytes)"
    return $?
  fi

  # Too large — split in half
  local range_size=$(( fp_end - fp_start ))
  if [[ "$range_size" -le 1 ]]; then
    # Can't split further — try anyway
    warn "Single commit with ${pack_size} byte pack, pushing anyway"
    push_sha "$target_sha" "(${pack_size} bytes, unsplittable)"
    return $?
  fi

  local mid=$(( fp_start + range_size / 2 ))
  local mid_sha
  mid_sha=$(sed -n "${mid}p" "$ALL_FP_FILE")

  warn "Pack too large ($(( pack_size / 1048576 )) MB) — splitting fp ${fp_start}..${fp_end} at fp ${mid}"

  push_range "$mid_sha" "$fp_start" "$mid" || return 1
  # Fetch to update remote tracking after the mid-point push
  git fetch "$REMOTE_NAME" 2>/dev/null || true
  push_range "$target_sha" "$mid" "$fp_end" || return 1
}

log "Starting incremental push (auto-split packs > $(( MAX_PACK_BYTES / 1000000 )) MB)..."
echo ""

PUSH_OK=0
PUSH_FAIL=0
START_TIME=$(date +%s)
i=0
PREV_FP=0

# Keep the full fp commit list for splitting
ALL_FP_FILE=/tmp/openclaw_fp_commits.txt
if [[ ! -f "$ALL_FP_FILE" ]]; then
  git log --first-parent --reverse --format='%H' "$BRANCH" > "$ALL_FP_FILE"
fi

while IFS= read -r sha; do
  i=$((i+1))

  if [[ $i -le $SKIP_TO ]]; then
    PREV_FP=$((i * STEP))
    continue
  fi

  FP_NUM=$((i * STEP))
  ELAPSED=$(( $(date +%s) - START_TIME ))
  if [[ $PUSH_OK -gt 0 ]]; then
    AVG=$(( ELAPSED / PUSH_OK ))
    ETA=$(( AVG * (NUM_CHECKPOINTS - i) ))
    ETA_MIN=$(( ETA / 60 ))
    PROGRESS="[${ELAPSED}s elapsed, ~${ETA_MIN}m remaining]"
  else
    PROGRESS=""
  fi

  printf "${BOLD}[%d/%d]${NC} fp %-6d %s " "$i" "$NUM_CHECKPOINTS" "$FP_NUM" "$PROGRESS"

  if ! push_range "$sha" "$PREV_FP" "$FP_NUM"; then
    PUSH_FAIL=$((PUSH_FAIL+1))
    REF_STATE=$(curl -s "${CURL_OPTS[@]}" "${BASE_URL}/refs" 2>/dev/null || echo "unreachable")
    fail "Push $i failed. Server refs: $REF_STATE"
    fail "Stopping. To resume: $0 --no-delete --skip-to $((i-1)) -r $REPO_PATH -s $STEP"
    break
  fi

  # Update remote tracking after each checkpoint
  git fetch "$REMOTE_NAME" 2>/dev/null || true
  PREV_FP=$FP_NUM
done < "$CHECKPOINTS_FILE"

rm -f "$CHECKPOINTS_FILE"
echo ""

# --- 8. Final push of HEAD ---
if [[ $PUSH_FAIL -eq 0 ]]; then
  log "Pushing HEAD ($BRANCH) ..."
  if git push "$REMOTE_NAME" "$BRANCH" 2>&1; then
    ok "HEAD pushed"
  else
    fail "HEAD push failed"
    PUSH_FAIL=1
  fi
fi

# --- 9. Rebuild indexes ---
if [[ $PUSH_FAIL -eq 0 ]] && $DO_REBUILD; then
  echo ""
  log "Disabling bulk mode ..."
  curl -s "${CURL_OPTS[@]}" -X PUT "${BASE_URL}/admin/config?key=skip_fts&value=0" > /dev/null
  ok "Bulk mode disabled"

  log "Rebuilding commit graph ..."
  RESULT=$(curl -s "${CURL_OPTS[@]}" -X PUT "${BASE_URL}/admin/rebuild-graph")
  ok "$RESULT"

  log "Rebuilding fts_commits ..."
  RESULT=$(curl -s "${CURL_OPTS[@]}" -X PUT "${BASE_URL}/admin/rebuild-fts-commits")
  ok "$RESULT"

  log "Rebuilding fts_head (code search) ..."
  RESULT=$(curl -s "${CURL_OPTS[@]}" -X PUT "${BASE_URL}/admin/rebuild-fts")
  ok "$RESULT"
fi

# --- 10. Stats ---
echo ""
ELAPSED=$(( $(date +%s) - START_TIME ))
STATS=$(curl -s "${CURL_OPTS[@]}" "${BASE_URL}/stats")
COMMITS=$(echo "$STATS" | grep -o '"commits":[0-9]*' | cut -d: -f2)
BLOBS=$(echo "$STATS" | grep -o '"blobs":[0-9]*' | cut -d: -f2)
RATIO=$(echo "$STATS" | grep -o '"compression_ratio":[0-9.]*' | cut -d: -f2)
DB_SIZE=$(echo "$STATS" | grep -o '"database_size_bytes":[0-9]*' | cut -d: -f2)
DB_MB=$(( DB_SIZE / 1048576 ))

log "Results:"
echo "  Pushes:      $PUSH_OK ok, $PUSH_FAIL failed"
echo "  Time:        ${ELAPSED}s"
echo "  Commits:     $COMMITS"
echo "  Blobs:       $BLOBS"
echo "  Compression: ${RATIO}x"
echo "  DB size:     ${DB_MB} MB"
echo ""

if [[ $PUSH_FAIL -gt 0 ]]; then
  exit 1
fi
