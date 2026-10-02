param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
if (-not $env:GSV_WINDOWS_SIGNING_THUMBPRINT) {
  Write-Host 'No signing certificate configured; Windows artifacts are unsigned.'
  return
}
foreach ($file in Get-ChildItem -LiteralPath $Directory -Filter '*.exe' -File) {
  & signtool.exe sign /sha1 $env:GSV_WINDOWS_SIGNING_THUMBPRINT /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 $file.FullName
  if ($LASTEXITCODE) { throw "Signing failed for $($file.Name)" }
  if ((Get-AuthenticodeSignature $file.FullName).Status -ne 'Valid') { throw "Invalid signature on $($file.Name)" }
}
