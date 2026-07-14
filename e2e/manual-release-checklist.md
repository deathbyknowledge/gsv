  ## 1. Start from genuinely clean local state


  Build everything the local stack actually consumes:


  git switch cleanup-2
  git pull --ff-only


  rustup target add wasm32-unknown-unknown
  ./scripts/setup-deps.sh
  npm run build --workspace web
  cargo build --manifest-path cli/Cargo.toml
  npx wrangler whoami


  The gateway serves web/dist; npm run dev does not build or run Vite.


  Back up existing development state rather than deleting it:


  if [ -d .wrangler/dev-state ]; then
    mv .wrangler/dev-state ".wrangler/dev-state.pre-manual-$(date +%s)"
  fi


  mkdir -p .manual-test/xdg .manual-test/device-a .manual-test/device-b
  export XDG_CONFIG_HOME="$PWD/.manual-test/xdg"


  Use an incognito browser or clear site data for http://127.0.0.1:8787. Browser and CLI credentials otherwise survive a gateway reset.


  Start the stack:


  npm run dev


  Verify:


  curl http://127.0.0.1:8787/health


  Expected:


  {"status":"healthy"}


  The local stack starts gateway, assembler, Telegram, and ripgit. It does not start Discord or WhatsApp. Workers AI is remote in local development, so use
  authenticated Wrangler or configure a real BYO provider during setup.


  ## 2. First-run setup, login, and persistence


  Open http://127.0.0.1:8787.


  Test:


  1. Clean state shows first-run setup rather than login or desktop.
  2. Complete setup with:
      - a non-root username
      - password of at least eight characters
      - root password
      - timezone
      - a known-working AI provider


  3. Reach the desktop and start a normal chat.
  4. Reload the page.
  5. Lock the desktop.
  6. Try a wrong password, then the correct one.
  7. Log in through the CLI:



  GSV="$PWD/cli/target/debug/gsv"


  "$GSV" --url ws://127.0.0.1:8787/ws auth login --username YOUR_USER
  "$GSV" --url ws://127.0.0.1:8787/ws proc list
  "$GSV" version


  Expected:


  - Setup completes once and provisions the user, personal agent, home, and init process.
  - Reload reconnects without losing history.
  - Wrong credentials fail cleanly.
  - proc list shows the user’s process.
  - Version reports 0.4.0.
  - No reconnect loop or half-connected session appears.


  Later, restart npm run dev without moving state. Login, files, conversations, device registration, and schedules must persist.


  ## 3. Connect a real device driver


  Create test data:


  printf 'alpha\na.b[1]\nβeta\n' > .manual-test/device-a/lines.txt
  : > .manual-test/device-a/empty.bin
  printf '\377\000\376binary' > .manual-test/device-a/invalid.txt
  dd if=/dev/urandom of=.manual-test/device-a/probe.bin bs=1M count=40
  sha256sum .manual-test/device-a/probe.bin


  Create a device credential:


  "$GSV" --url ws://127.0.0.1:8787/ws \
    auth token create --kind device --device manual-a --label "Manual A"


  In another terminal, use the one-time token:


  export XDG_CONFIG_HOME="/path/to/repo/.manual-test/xdg"


  ./cli/target/debug/gsv \
    --url ws://127.0.0.1:8787/ws \
    --user YOUR_USER \
    --token "$DEVICE_TOKEN" \
    device run \
    --id manual-a \
    --workspace "/path/to/repo/.manual-test/device-a"


  Expected:


  - Driver reports connect.ok.
  - Machines and targets list show manual-a online.
  - It advertises filesystem, shell, and network capabilities.
  - Disconnecting and reconnecting does not leave duplicate devices or stale requests.


  A second device is worthwhile for device-to-device transfer testing.


  ## 4. Chat interruption and real cancellation — highest priority


  This is the combined centerpiece of both PRs.


  Ask the agent to run this on manual-a:


  trap "" TERM
  sh -c 'trap "" TERM; echo $$ > child.pid; exec sleep 300' &
  echo $$ > leader.pid
  wait


  While the tool is visibly running—and before its five-second foreground yield:


  1. Type a new message. The Stop button should become Send.
  2. Send: Reply exactly CONTROL RETURNED.
  3. Repeat with two rapid follow-up messages.
  4. Run the test again and use Stop with an empty composer.


  Expected:


  - The composer remains usable.
  - The replacement message starts promptly.
  - The old run becomes aborted/interrupted.
  - The device shell process group receives TERM and then KILL if needed.
  - Both recorded PIDs disappear.
  - No late tool output, provider output, speech, or completion mutates the new run.
  - Reloaded history remains structurally valid; no tool row spins forever.
  - A stale Stop or approval action cannot affect the successor run.


  Repeat against:


  - a slow device net.fetch
  - a large fs.search
  - CodeMode containing a slow nested shell or fetch
  - proc.reset
  - proc.kill
  - device disconnect during active work


  After each cancellation, issue a normal read or shell command. The same connection must remain usable.


  ### Background-session boundary


  Run a command long enough for shell.exec to return status: "running" with a sessionId, then abort the agent run.


  Expected:


  - The already-created background session survives.
  - Polling it later still works.
  - Cancelling a poll/write request does not kill the underlying session.


  That distinction is intentional: request.cancel cancels a request; it is not a recursive session/process kill operation.


  ## 5. HIL and stale-control safety


  Configure fs.read as Ask for the test agent.


  Test:


  1. Ask it to read a file.
  2. Deny the request.
  3. Ask again and approve.
  4. Ask again and use Approve always.
  5. Start another HIL request, then send a new user message instead of deciding.


  Expected:


  - Deny clears the banner and gives the agent a synthetic Tool execution denied by user result.
  - Approve executes the original call.
  - Approve always prevents the same target class from prompting again.
  - Supersession clears obsolete HIL state.
  - Clicking an old approval cannot approve a tool belonging to the newer run.

  ## 6. Filesystem consistency and binary integrity


  In gsv shell:


  printf 'é' > ~/append.txt
  printf '🙂' >> ~/append.txt
  stat ~/append.txt
  cat ~/append.txt
  printf '' > ~/context.d/empty.md


  Expected:


  - Content is exactly é🙂.
  - Size is six UTF-8 bytes.
  - Files and CodeMode see the same content.
  - Opening ~/context.d/empty.md succeeds as an empty file rather than throwing a byte-stream error.


  Check through CodeMode:


  codemode -e 'return await fs.read({path:"~/append.txt"})'
  codemode -e 'return await fs.read({path:"~/context.d/empty.md"})'
  codemode -e 'return await fs.read({path:"~/does-not-exist"})'


  Also verify:


  - Files opens empty, Unicode, and moderately large text files.
  - Library opens a Markdown page correctly.
  - Crew’s agent-context editor loads and saves context files.
  - Missing files report ENOENT, not an empty-directory result.
  - Invalid UTF-8 text fails cleanly instead of being corrupted.
  - An image read preserves exact image bytes and MIME type.
  - fs.search treats a.b[1] literally, not as a regex.
  - Offset/limit reads return the correct lines and numbering.


  ### Binary round trip


  From gsv shell:


  cp manual-a:probe.bin ~/probe.bin
  cp ~/probe.bin manual-a:roundtrip.bin
  cp manual-a:empty.bin ~/empty.bin
  cp ~/empty.bin manual-a:roundtrip-empty.bin


  On the host:


  sha256sum .manual-test/device-a/probe.bin
  sha256sum .manual-test/device-a/roundtrip.bin
  wc -c .manual-test/device-a/roundtrip-empty.bin


  Expected:


  - SHA-256 hashes match.
  - Empty copy has zero bytes.
  - No .gsv-transfer-* files remain.
  - Copying into a directory appends the basename.
  - Overwriting an existing destination is atomic.
  - Cancellation leaves no partial destination.


  Also run overwrite-existing on Windows before release; rename-over-existing semantics are a remaining platform-sensitive risk.


  ## 7. Network request and response bodies


  Run a controlled echo/slow HTTP server on the device. It should expose:


  - binary response
  - POST echo
  - empty/204 response
  - HEAD
  - chunked response without Content-Length
  - redirect
  - 404
  - slow response
  - response over 32 MiB


  From gsv shell:


  net fetch --target manual-a \
    -d 'frame-body-ok' \
    http://127.0.0.1:8123/echo


  net fetch --target manual-a \
    -o ~/net.bin \
    http://127.0.0.1:8123/probe.bin


  Expected:


  - POST bytes echo exactly.
  - Downloaded binary hash matches the server file.
  - 404 remains an HTTP result, not a protocol failure.
  - HEAD, 204, and other null-body responses do not invent a body.
  - Chunked responses work without Content-Length.
  - Follow/manual/error redirect modes behave distinctly.
  - GET or HEAD with a request body is rejected.
  - Request and response bodies above 32 MiB fail cleanly.
  - Cancelling a slow fetch closes the device-side request.
  - A subsequent fetch succeeds on the same device connection.


  Repeat one fetch with target=gsv, using an endpoint reachable from the Worker, to cover the native implementation too.


  ## 8. Chat media and AI media


  In Chat:


  1. Attach a PNG, an audio file, and a document below 25 MiB.
  2. Send an attachment-only message.
  3. Remove one attachment before sending.
  4. Paste an image from the clipboard.
  5. Reload and switch away from/back to the process.
  6. Ask the agent to describe the stored image.
  7. Try exactly 25 MiB and then 25 MiB plus one byte.


  Expected:


  - Upload is responsive and the message is admitted once.
  - Reloaded images, audio, video, and documents render or download correctly.
  - Stored history uses process media references, not giant data URLs.
  - The model can hydrate and inspect the image.
  - Exactly 25 MiB is accepted; one byte over is rejected before upload.
  - Failed multi-upload/send rolls back unreferenced uploaded media.
  - A media key from one process cannot be attached to or deleted through another process.


  With configured providers, also test:


  txt2img "a red square on white" -o qa-image.png --json
  img2txt qa-image.png --json
  tts "binary frame acceptance test" -o qa-speech.wav --json
  stt qa-speech.wav --json

  Then test browser dictation/ambient transcription and spoken replies.


  Expected:


  - Generated image/audio is non-empty and matches reported MIME type and size.
  - Speech plays without leaking an old reply into a successor run.
  - Empty/skipped speech produces no bogus player or error.
  - URL-only image providers still work.


  ## 9. Processes, subagents, IPC, and schedules


  Basic lifecycle:


  "$GSV" --url ws://127.0.0.1:8787/ws \
    proc spawn --label manual-child --prompt "Reply exactly child-ok"


  "$GSV" --url ws://127.0.0.1:8787/ws proc history --pid PID --tail
  "$GSV" --url ws://127.0.0.1:8787/ws proc send "second message" --pid PID
  "$GSV" --url ws://127.0.0.1:8787/ws proc reset --pid PID
  "$GSV" --url ws://127.0.0.1:8787/ws proc kill PID


  Expected:


  - Spawned process runs and keeps durable history.
  - Reset clears live history but leaves the process usable.
  - Kill removes it from proc list.
  - Archived conversations live under the run-as account’s ~/conversations/....
  - Reset/kill clears process media coherently.


  Ask the main agent to delegate a deliberately long task to a subagent, then send a new message.


  Expected:


  - Parent control returns immediately.
  - Late child results do not mutate the aborted parent run.
  - An already-spawned child may continue independently.
  - It remains visible in Crew/proc list and can be killed explicitly.
  - Cancellation is not implicitly recursive proc.kill.


  For schedules, install a simple crontab, inspect it, and force-run it:


  printf '* * * * * echo cron-ok > ~/cron-proof.txt\n' > /tmp/manual-crontab
  crontab /tmp/manual-crontab
  sched list
  sched run SCHEDULE_ID --force
  cat ~/cron-proof.txt
  crontab -r


  Expected:


  - It runs as the stored real identity.
  - A deleted/nonexistent run-as account causes a clear schedule error; it never falls back to root or a fabricated user.


  ## 10. CodeMode and MCP


  CodeMode should match direct tools:


  codemode -e 'return await fs.read({target:"manual-a",path:"lines.txt"})'
  codemode -e 'return await shell("pwd",{target:"manual-a"})'
  codemode -e 'const r=await fetch("https://example.com"); return {status:r.status,text:await r.text()}'


  Expected:


  - Target routing matches direct fs.*, shell.exec, and net.fetch.
  - The same capability and HIL policy applies.
  - Cancellation of the outer run cancels active nested calls.
  - MCP tools remain callable through generated names.
  - An MCP tool named fetch does not replace the built-in fetch global.


  Given the original branch history, run a real MCP login test:


  1. Open Integrations.
  2. Add a known OAuth MCP server.
  3. Continue through provider sign-in.
  4. Return through /oauth/callback.
  5. Wait for discovery/Ready.
  6. Reload.
  7. Inspect mcp list and mcp status in gsv shell.
  8. Ask an agent to call one tool.
  9. Refresh and remove the integration.


  Expected:


  - OAuth state survives the callback.
  - Tool discovery finishes once.
  - Reload preserves authorization.
  - The agent can call the tool.
  - Refresh/remove updates only the owning user.
  - No duplicate MCP server or reconnect loop appears.


  ## 11. Package app and SDK lane


  This needs a known QA package with a backend. It should:


  - echo an 8–40 MiB POST body
  - return a large/chunked response with custom headers and status
  - call fs.read through gsv.request()
  - attempt a syscall declared in its manifest but absent from the user’s account capabilities
  - close/reopen during an active transfer


  Expected:


  - Upload/download hashes match.
  - Status and headers survive the app RPC bridge.
  - gsv.request("fs.read", ...) returns metadata plus a body.
  - Data-only gsv.call("fs.read", ...) rejects and disposes of the body.
  - this.kernel.requestFrame() supports bodies.
  - this.kernel.request() rejects body-bearing responses.
  - Manifest declaration alone does not grant authority; the unauthorized call receives 403.
  - Closing the app cancels its streams, and reopening reconnects cleanly.


  If testing the browser extension, rebuild/load the current extension too. Mixed old/new protocol participants are not supported.


  ## 12. Multi-user and adapter security lane


  A clean UI setup only creates one human. For this lane, create a second human through root account.create, then use two isolated browser profiles.


  Run Alice and Bob concurrently:


  - chats and process runs
  - notifications
  - MCP add/remove
  - package install/update
  - adapter status/connect/disconnect
  - cross-process IPC attempts

  Expected:


  - No process output, presence, notification, MCP, package, or adapter invalidation crosses to the unrelated user.
  - Root/admin starting work for Alice still routes output to Alice.
  - Cross-owner process and IPC calls are denied.
  - Alice’s first adapter connect claims the account durably.
  - Bob cannot take it over or disconnect it.
  - Root can inspect/control it.
  - Owner and linked users receive status updates; unrelated users do not.


  A full Telegram test needs a real token and publicly reachable webhook. Discord must be started separately. WhatsApp is not bound in the current local dev
  stack, so these should not block the core local gate.


  ## One extra test a clean start cannot cover


  A clean dev server does not validate the 0.3 → 0.4 migration.


  For the actual release gate, also boot from a pre-0.4 state containing:


  - existing users/tokens
  - an active tool
  - pending HIL
  - pending IPC
  - legacy signal watches
  - existing adapter accounts


  Expected:


  - Existing login and tokens survive.
  - Pending tool/HIL state is terminalized with an explicit upgrade interruption.
  - Retired IPC replies never arrive later.
  - Legacy watch keys are removed.
  - Adapter ownership migrates deterministically.
  - No process remains permanently “running.”


