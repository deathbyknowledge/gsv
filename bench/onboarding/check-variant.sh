#!/usr/bin/env bash
# The existing gateway tests nearest the recommended variant's changes.
set -uo pipefail
cd "$(dirname "$0")/../../workers/gateway"
TMPDIR=$(mktemp -d /dev/shm/gsv-onboarding-check-XXXXXX)
export TMPDIR
trap 'rm -rf "$TMPDIR"' EXIT
mise exec node@24 -- npx tsc --noEmit 2>&1 | tail -15
echo "--- unit"
nice -n 10 mise exec node@24 -- npx vitest run src/kernel/responsibilit src/drivers/native/shell.test.ts src/process/do.send src/prompts 2>&1 | tail -30 | cut -c1-200
echo "--- integration"
nice -n 10 mise exec node@24 -- npx vitest run --config vitest.integration.config.ts test-integration/onboarding-welcome.test.ts test-integration/responsibility-review.test.ts 2>&1 | tail -30 | cut -c1-200
