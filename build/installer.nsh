!macro customInstall
  WriteRegStr SHCTX "Software\Classes\Directory\shell\EnsoCode" "" "Open with EnsoCode"
  WriteRegStr SHCTX "Software\Classes\Directory\shell\EnsoCode" "Icon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHCTX "Software\Classes\Directory\shell\EnsoCode\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--open-folder=%V"'
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\EnsoCode" "" "Open with EnsoCode"
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\EnsoCode" "Icon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\EnsoCode\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--open-folder=%V"'
!macroend

!macro customUnInstall
  DeleteRegKey SHCTX "Software\Classes\Directory\shell\EnsoCode"
  DeleteRegKey SHCTX "Software\Classes\Directory\Background\shell\EnsoCode"
!macroend
