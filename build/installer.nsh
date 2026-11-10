!macro ensoUserPath OP
  System::Call 'Kernel32::SetEnvironmentVariable(t "ENSO_BIN", t "$INSTDIR\resources\bin")'
  Push $0
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); $$d=$$env:ENSO_BIN; $$p=@(([string]$$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)).Split(';') | Where-Object { $$_ -and $$_ -ne $$d }); if ('${OP}' -eq 'add') { $$p += $$d }; $$k.SetValue('Path', ($$p -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)"`
  Pop $0
  Pop $0
  SendMessage 0xFFFF 0x1A 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro customInstall
  Push $0
  Push $1
  System::Call 'kernel32::GetUserDefaultUILanguage() i .r0'
  IntOp $0 $0 & 0x3FF
  StrCpy $1 "Open with EnsoCode"
  IntCmp $0 4 0 +2 +2
  StrCpy $1 "用 EnsoCode 打开"
  WriteRegStr SHCTX "Software\Classes\Directory\shell\EnsoCode" "" "$1"
  WriteRegStr SHCTX "Software\Classes\Directory\shell\EnsoCode" "Icon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHCTX "Software\Classes\Directory\shell\EnsoCode\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--open-folder=%V"'
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\EnsoCode" "" "$1"
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\EnsoCode" "Icon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\EnsoCode\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--open-folder=%V"'
  Pop $1
  Pop $0
  !insertmacro ensoUserPath add
!macroend

!macro customUnInstall
  DeleteRegKey SHCTX "Software\Classes\Directory\shell\EnsoCode"
  DeleteRegKey SHCTX "Software\Classes\Directory\Background\shell\EnsoCode"
  !insertmacro ensoUserPath remove
!macroend
