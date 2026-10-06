Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "${STAGE}\setup-bootstrap.nsh"
Name "GSV"
OutFile "${OUTPUT}\gsv-desktop-windows-x64-setup.exe"
InstallDir "$LOCALAPPDATA\Programs\gsv\bin"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GSV" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "GSV"
VIAddVersionKey /LANG=1033 "FileDescription" "GSV host installer"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "GSV contributors"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "GSV requires Windows 10 x64 or newer."
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "GSV requires Windows 10 or newer."
    Abort
  ${EndIf}
  ${DisableX64FSRedirection}
FunctionEnd

Function un.onInit
  ${DisableX64FSRedirection}
FunctionEnd

Section "GSV"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\payload"
  File /x setup-bootstrap.nsh "${STAGE}\*"
  System::Call 'kernel32::SetEnvironmentVariableW(w "GSV_SETUP_SOURCE", w "$PLUGINSDIR\payload")'
  System::Call 'kernel32::SetEnvironmentVariableW(w "GSV_SETUP_DESTINATION", w "$INSTDIR")'
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${GSV_SETUP_CODE}"`
  Pop $0
  System::Call 'kernel32::SetEnvironmentVariableW(w "GSV_SETUP_SOURCE", p 0)'
  System::Call 'kernel32::SetEnvironmentVariableW(w "GSV_SETUP_DESTINATION", p 0)'
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Installation failed. Close GSV Desktop and retry. See the installer details for the error."
    SetErrorLevel 1
    Abort
  ${EndIf}
  SetOutPath "$INSTDIR"
  File "uninstall.ps1"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GSV" "DisplayName" "GSV"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GSV" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GSV" "UninstallString" '$\"$INSTDIR\uninstall.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GSV" "InstallLocation" "$INSTDIR"
SectionEnd

Section "Uninstall"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\uninstall.ps1"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Stop and uninstall the GSV service as its enrolling user before removing the applications."
    Abort
  ${EndIf}
  Delete "$INSTDIR\gsv.exe"
  Delete "$INSTDIR\gsvd.exe"
  Delete "$INSTDIR\gsv-desktop.exe"
  Delete "$INSTDIR\gsv-transcribe.exe"
  RMDir /r "$INSTDIR\gsv-transcribe-runtime"
  Delete "$INSTDIR\gsv-vision.exe"
  Delete "$INSTDIR\gsv-transcribe-THIRD_PARTY.md"
  Delete "$INSTDIR\gsv-vision-THIRD_PARTY.md"
  Delete "$INSTDIR\gsv-vision-LICENSE.apache-2.0"
  Delete "$INSTDIR\gsv-vision-PROVENANCE.md"
  Delete "$INSTDIR\uninstall.ps1"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\GSV.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GSV"
SectionEnd
