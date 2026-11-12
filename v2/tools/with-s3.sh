#!/usr/bin/env bash
# Runs a command with an S3-compatible server (versitygw in Docker) on a scratch directory,
# exporting GSV_TEST_S3_* for the blob contract suite. Usage: tools/with-s3.sh npm test --workspace runtime
set -euo pipefail
root=$(mktemp -d)
port=${GSV_TEST_S3_PORT:-17070}
mkdir -p "$root/gsv-test"
name="gsv-s3-$$"
docker run -d --rm --name "$name" -p "127.0.0.1:$port:7070" -v "$root:/data" \
  -e ROOT_ACCESS_KEY_ID=gsvtest -e ROOT_SECRET_ACCESS_KEY=gsvtestsecret versity/versitygw posix /data >/dev/null
cleanup() { docker stop "$name" >/dev/null 2>&1 || true; docker run --rm -v "$root:/data" busybox rm -rf /data/gsv-test >/dev/null 2>&1 || true; rm -rf "$root" 2>/dev/null || true; }
trap cleanup EXIT
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$port/" && break; sleep 0.2; done
export GSV_TEST_S3_ENDPOINT="http://127.0.0.1:$port" GSV_TEST_S3_BUCKET=gsv-test GSV_TEST_S3_ACCESS_KEY_ID=gsvtest GSV_TEST_S3_SECRET_ACCESS_KEY=gsvtestsecret
"$@"
