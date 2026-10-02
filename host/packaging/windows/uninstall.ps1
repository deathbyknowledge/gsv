$ErrorActionPreference = 'Stop'
if (Get-Service gsvd -ErrorAction SilentlyContinue) {
  & (Join-Path $PSScriptRoot 'gsv.exe') daemon uninstall
  if ($LASTEXITCODE) { throw 'Uninstall the daemon service as its enrolling user before removing GSV' }
}
if (Get-Process -Name gsv-desktop,gsv-transcribe,gsv-vision -ErrorAction SilentlyContinue) {
  throw 'Close GSV Desktop and its helpers before uninstalling'
}
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath) {
  $entries = @($userPath -split ';' | Where-Object { $_.TrimEnd('\') -ne $PSScriptRoot.TrimEnd('\') })
  [Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')
}
