#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="gsv-computer-smoke:$$"
container_id=""
target="instance:computer-smoke"

cleanup() {
  local status=$?
  if [[ -n "$container_id" ]]; then
    if (( status != 0 )); then docker logs "$container_id" >&2 || true; fi
    docker rm --force "$container_id" >/dev/null || true
  fi
  docker image rm "$image" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker build --file "$repository_root/workers/instances/computer/Dockerfile" \
  --tag "$image" "$repository_root"
export GSV_INSTANCE_SECRET
GSV_INSTANCE_SECRET="$(openssl rand -hex 32)"
# Keep the image's entrypoint and workspace defaults; the provider supplies its target.
container_id="$(docker run --detach --network none --env GSV_INSTANCE_SECRET "$image" --id "$target")"

docker exec --interactive "$container_id" node --input-type=module - "$target" <<'JS'
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";

const url = "http://127.0.0.1:8788/health";
const headers = { Authorization: `Bearer ${process.env.GSV_INSTANCE_SECRET}` };
let health;
for (let attempt = 0; ; attempt++) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 200);
    health = await response.json();
    break;
  } catch (error) {
    if (attempt === 49) throw error;
    await setTimeout(200);
  }
}
assert.equal((await fetch(url)).status, 401);
assert.equal((await fetch(url, { headers: { Authorization: "Bearer invalid" } })).status, 401);
assert.equal(health.targetId, process.argv[2]);
assert.equal(health.protocol, 4);
assert.match(health.version, /^\d+\.\d+\.\d+/);
assert.match(health.bootId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
assert.equal((await (await fetch(url, { headers })).json()).bootId, health.bootId);
console.log("Container entrypoint, authenticated health and boot identity passed.");
JS

docker exec --interactive "$container_id" bash -eu <<'SH'
test "$PWD" = /workspace
npm --version
python3 -m pip --version
python3 -c 'from pathlib import Path; Path("smoke.c").write_text("#include <stdio.h>\nint main(void) { puts(\"image-smoke\"); return 0; }\n")'
printf 'all:\n\t$(CC) smoke.c -o smoke\n' > Makefile
make
test "$(./smoke)" = image-smoke
c++ -x c++ smoke.c -o smoke-cxx
test "$(./smoke-cxx)" = image-smoke
git init --quiet
git add smoke.c Makefile
git -c user.name=Smoke -c user.email=smoke@example.invalid commit --quiet -m smoke
test "$(git log -1 --format=%s)" = smoke
pkg-config --version
curl --version >/dev/null
unzip -v >/dev/null
SH

docker stop --timeout 5 "$container_id" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$container_id")" = 0
printf 'Cloud computer image smoke passed.\n'
