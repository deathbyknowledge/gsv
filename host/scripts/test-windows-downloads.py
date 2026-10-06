#!/usr/bin/env python3
"""Exercise the PowerShell installer's manifest and asset downloads over HTTP."""

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import subprocess
import tempfile
from threading import Thread
from urllib.parse import urlsplit


PAYLOAD = b"installer checksum fixture\n"
DIGEST = hashlib.sha256(PAYLOAD).hexdigest()
ASSET = "gsv-windows-x64.exe"


class ReleaseServer(BaseHTTPRequestHandler):
    def do_GET(self):
        kind, asset = urlsplit(self.path).path.strip("/").split("/")
        content_type = "application/octet-stream"
        if asset == "checksums.txt":
            name = "gsvd-windows-x64.exe" if kind == "missing" else ASSET
            body = f"{DIGEST}  {name}\n".encode()
            if kind == "text":
                content_type = "text/plain; charset=utf-8"
                body = body.replace(b"\n", b"\r\n")
        else:
            body = b"altered payload" if kind == "tampered" else PAYLOAD
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


TEST_SCRIPT = r"""
param([string]$Installer, [string]$BaseUrl, [string]$Directory)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  . ([scriptblock]::Create($definition.Extent.Text))
}
function Release-AssetUrl([string]$ReleaseRef, [string]$Asset) { return "$BaseUrl/$ReleaseRef/$Asset" }
$ExpectedChecksums = ''
$AssetDirectory = ''
$DevReleaseTag = 'dev'
$asset = 'gsv-windows-x64.exe'
$destination = Join-Path $Directory 'gsv.exe'
foreach ($kind in @('binary', 'text')) {
  $checksums = Get-ReleaseChecksums $kind
  Download-VerifiedAsset $kind $asset $destination $checksums
}
$failures = @{ missing = 'Release checksum is missing'; tampered = 'Checksum verification failed' }
foreach ($kind in $failures.Keys) {
  $checksums = Get-ReleaseChecksums $kind
  $rejected = $false
  try {
    Download-VerifiedAsset $kind $asset $destination $checksums
  } catch {
    if ($_.Exception.Message -notlike ($failures[$kind] + '*')) { throw }
    $rejected = $true
  }
  if (-not $rejected) { throw "Accepted $kind release content" }
}
Write-Host "Manifest downloads and checksum rejection passed on PowerShell $($PSVersionTable.PSVersion)"
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--powershell", default="pwsh")
    args = parser.parse_args()
    installer = Path(__file__).resolve().parents[2] / "install.ps1"
    with ThreadingHTTPServer(("127.0.0.1", 0), ReleaseServer) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix="gsv-download-test-") as directory:
                script = Path(directory) / "test.ps1"
                script.write_text(TEST_SCRIPT, encoding="utf-8")
                subprocess.run(
                    [args.powershell, "-NoLogo", "-NoProfile", "-NonInteractive",
                     "-ExecutionPolicy", "Bypass", "-File", str(script),
                     str(installer), f"http://127.0.0.1:{server.server_port}", directory],
                    check=True,
                    timeout=60,
                    # Let each PowerShell version select its own built-in modules.
                    env={key: value for key, value in os.environ.items()
                         if key.casefold() != "psmodulepath"},
                )
        finally:
            server.shutdown()
            thread.join()


if __name__ == "__main__":
    main()
