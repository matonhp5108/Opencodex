#!/usr/bin/env bash
set -u

title="${1:-}"
body="${2:-}"
icon="${3:-}"
uri="${4:-vscode://}"
folder="${5:-}"

open_vscode() {
  local bin="code"
  case "$uri" in
    vscode-insiders://*) bin="code-insiders" ;;
  esac
  if command -v "$bin" >/dev/null 2>&1; then
    if [ -n "$folder" ]; then
      nohup "$bin" "$folder" >/dev/null 2>&1 &
    else
      nohup "$bin" >/dev/null 2>&1 &
    fi
    return 0
  fi
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$uri" >/dev/null 2>&1 || true
  fi
  return 0
}

if ! command -v gdbus >/dev/null 2>&1; then
  if command -v notify-send >/dev/null 2>&1; then
    notify-send --app-name=Opencodex --icon="$icon" "$title" "$body"
  fi
  exit 0
fi

out="$(gdbus call --session \
  --dest org.freedesktop.Notifications \
  --object-path /org/freedesktop/Notifications \
  --method org.freedesktop.Notifications.Notify \
  "Opencodex" "0" "$icon" "$title" "$body" \
  '["default", "Open VS Code"]' '{}' '10000' 2>/dev/null)" || {
  if command -v notify-send >/dev/null 2>&1; then
    notify-send --app-name=Opencodex --icon="$icon" "$title" "$body"
  fi
  exit 0
}

id="$(printf '%s' "$out" | sed -n 's/.*uint32 \([0-9][0-9]*\).*/\1/p')"
if [ -z "$id" ]; then
  exit 0
fi

timeout 12 gdbus monitor --session --dest org.freedesktop.Notifications 2>/dev/null | while IFS= read -r line; do
  case "$line" in
    *"ActionInvoked (uint32 $id, 'default')"*)
      open_vscode
      exit 0
      ;;
  esac
done || true

exit 0
