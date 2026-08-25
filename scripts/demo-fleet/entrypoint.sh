#!/usr/bin/env bash
set -euo pipefail

: "${DEVICE_ID:?DEVICE_ID is required}"
: "${GSV_URL:?GSV_URL is required}"
: "${GSV_USER:?GSV_USER is required}"
: "${GSV_TOKEN:?GSV_TOKEN is required}"

if [[ ! -d /fleet ]]; then
  echo "error: /fleet workspace is missing" >&2
  exit 1
fi

export GSV_DEVICE_CONSOLE_FORMAT="${GSV_DEVICE_CONSOLE_FORMAT:-json}"
device_token="$GSV_TOKEN"
unset GSV_TOKEN
printf '{"event":"device.start","deviceId":"%s"}\n' "$DEVICE_ID"
exec gsv --url "$GSV_URL" -u "$GSV_USER" -t "$device_token" device run \
  --id "$DEVICE_ID" \
  --workspace /fleet
