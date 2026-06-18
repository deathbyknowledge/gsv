#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PARENT_DIR="$(cd "$ROOT_DIR/.." && pwd)"
WORKTREE_PATH=""

usage() {
  cat <<'EOF'
Usage: scripts/agent-workspace.sh [branch-name]

Create or reuse a GSV git worktree, then open a tmux window for agent work.

With no branch name, the script prompts interactively.

Behavior:
  - Worktree path defaults to ../gsv-<branch-name>, with slashes converted to dashes.
  - Existing worktrees for the branch are reused.
  - New worktrees run scripts/setup-deps.sh and web/npm run build.
  - A tmux window named "GSV workspace N" is created with:
      pane 0: codex --yolo
      pane 1: npm run dev
      pane 2: shell at the worktree root
EOF
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

require_command() {
  local command_name="$1"
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required but was not found in PATH."
}

sanitize_branch_for_path() {
  local branch_name="$1"
  local slug

  slug="$(printf '%s' "$branch_name" | sed -E 's#[^A-Za-z0-9._-]+#-#g; s#^-+##; s#-+$##')"
  [[ -n "$slug" ]] || fail "could not derive a worktree folder name from branch '$branch_name'."

  printf '%s' "$slug"
}

find_worktree_for_branch() {
  local branch_name="$1"
  local branch_ref="refs/heads/$branch_name"

  git -C "$ROOT_DIR" worktree list --porcelain |
    awk -v branch="$branch_ref" '
      /^worktree / {
        path = substr($0, 10)
      }
      /^branch / && substr($0, 8) == branch {
        print path
        exit
      }
    '
}

next_workspace_number() {
  tmux list-windows -F '#{window_name}' |
    awk '
      $0 ~ /^GSV workspace [0-9]+$/ {
        n = $0
        sub(/^GSV workspace /, "", n)
        if ((n + 0) > max) {
          max = n + 0
        }
      }
      END {
        print max + 1
      }
    '
}

create_or_select_worktree() {
  local branch_name="$1"
  local slug="$2"
  local default_path="$PARENT_DIR/gsv-$slug"
  local existing_path
  local existing_branch

  existing_path="$(find_worktree_for_branch "$branch_name")"
  if [[ -n "$existing_path" ]]; then
    echo "==> Reusing existing worktree for $branch_name"
    WORKTREE_PATH="$existing_path"
    return 0
  fi

  if [[ -e "$default_path" ]]; then
    git -C "$default_path" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
      fail "$default_path exists but is not a git worktree."

    existing_branch="$(git -C "$default_path" branch --show-current)"
    [[ "$existing_branch" == "$branch_name" ]] ||
      fail "$default_path exists on branch '$existing_branch', not '$branch_name'."

    echo "==> Reusing existing worktree at $default_path"
    WORKTREE_PATH="$default_path"
    return 0
  fi

  echo "==> Creating worktree at $default_path"
  if git -C "$ROOT_DIR" show-ref --verify --quiet "refs/heads/$branch_name"; then
    git -C "$ROOT_DIR" worktree add "$default_path" "$branch_name"
  elif git -C "$ROOT_DIR" show-ref --verify --quiet "refs/remotes/origin/$branch_name"; then
    git -C "$ROOT_DIR" worktree add --track -b "$branch_name" "$default_path" "origin/$branch_name"
  else
    git -C "$ROOT_DIR" worktree add -b "$branch_name" "$default_path"
  fi

  echo ""
  echo "==> Bootstrapping new worktree"
  "$default_path/scripts/setup-deps.sh"

  echo ""
  echo "==> Building web shell"
  (
    cd "$default_path/web"
    npm run build
  )

  WORKTREE_PATH="$default_path"
}

create_tmux_workspace() {
  local worktree_path="$1"
  local workspace_number
  local window_name
  local window_id
  local pane0
  local pane1
  local pane2

  workspace_number="$(next_workspace_number)"
  window_name="GSV workspace $workspace_number"

  read -r window_id pane0 < <(
    tmux new-window -d -n "$window_name" -c "$worktree_path" -P -F '#{window_id} #{pane_id}'
  )

  # tmux -h creates the left/right split; -v then splits the right pane top/bottom.
  pane1="$(tmux split-window -h -p 50 -t "$pane0" -c "$worktree_path" -P -F '#{pane_id}')"
  pane2="$(tmux split-window -v -p 50 -t "$pane1" -c "$worktree_path" -P -F '#{pane_id}')"

  tmux select-pane -t "$pane0" -T "0"
  tmux select-pane -t "$pane1" -T "1"
  tmux select-pane -t "$pane2" -T "2"

  tmux send-keys -t "$pane0" "codex --yolo" C-m
  tmux send-keys -t "$pane1" "npm run dev" C-m

  tmux select-window -t "$window_id"
  tmux select-pane -t "$pane2"

  echo "==> Opened $window_name at $worktree_path"
}

main() {
  local branch_name="${1:-}"
  local slug

  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi

  [[ $# -le 1 ]] || fail "expected at most one branch name."

  require_command git
  require_command tmux
  require_command sed
  require_command awk

  [[ -n "${TMUX:-}" ]] || fail "run this from inside a tmux session."

  if [[ -z "$branch_name" ]]; then
    read -r -p "Branch name: " branch_name
  fi

  [[ -n "$branch_name" ]] || fail "branch name is required."
  git -C "$ROOT_DIR" check-ref-format --branch "$branch_name" >/dev/null ||
    fail "'$branch_name' is not a valid branch name."

  slug="$(sanitize_branch_for_path "$branch_name")"
  create_or_select_worktree "$branch_name" "$slug"

  create_tmux_workspace "$WORKTREE_PATH"
}

main "$@"
