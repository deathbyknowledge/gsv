# The setup executable embeds this command and both hashes at build time. Read
# and verify owned snapshots before executing script text or trusting a manifest.
# Keep the command compact for the standard NSIS 1024-character string limit.
function Get-SetupBootstrap([string]$InstallerHash, [string]$ManifestHash) {
  if ($InstallerHash -notmatch '^[0-9a-fA-F]{64}$' -or $ManifestHash -notmatch '^[0-9a-fA-F]{64}$') {
    throw 'Setup requires pinned SHA-256 hashes'
  }
  $command = @'
$ErrorActionPreference='Stop';$env:PSModulePath=$PSHOME+'\Modules';$r={param($n,$h)$b=[IO.File]::ReadAllBytes([IO.Path]::Combine($env:GSV_SETUP_SOURCE,$n));if([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b)).Replace('-','')-ne$h){throw 'Setup content changed'};[Text.Encoding]::UTF8.GetString($b)};$s=&$r 'install.ps1' 'INSTALLER_HASH';$m=&$r 'checksums.txt' 'MANIFEST_HASH';&([scriptblock]::Create($s)) -Destination $env:GSV_SETUP_DESTINATION -AssetDirectory $env:GSV_SETUP_SOURCE -ExpectedChecksums $m
'@
  return $command.Replace('INSTALLER_HASH', $InstallerHash).Replace('MANIFEST_HASH', $ManifestHash)
}
