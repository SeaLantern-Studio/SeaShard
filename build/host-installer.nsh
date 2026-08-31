!macro resolveSeaShardHostDataRoot output
  ReadEnvStr ${output} "SEASHARD_HOST_INSTALL_DATA_ROOT"
  ${if} ${output} == ""
    StrCpy ${output} "$APPDATA\SeaShard\core"
  ${endif}
!macroend

!macro customInstall
  ; Host 拥有独立安装目录和登录启动项，Controller 只通过控制端点连接。
  !insertmacro resolveSeaShardHostDataRoot $R9
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_EXECUTABLE_FILENAME}" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"--data-root=$R9$\"'
  Exec '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"--data-root=$R9$\"'
!macroend

!macro customUnInstall
  !insertmacro resolveSeaShardHostDataRoot $R9
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 == 0
    ClearErrors
    FileOpen $R0 "$R9\host-shutdown.request" w
    ${if} ${Errors}
      Abort "Unable to request SeaShard Host shutdown."
    ${endif}
    FileWrite $R0 "uninstall"
    FileClose $R0

    ${For} $R0 1 100
      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R1
      ${if} $R1 != 0
        Goto seashardStandaloneHostStopped
      ${endif}
      Sleep 100
    ${Next}
    Abort "SeaShard Host is still running. Uninstall was cancelled to protect active servers."
  ${endif}

  seashardStandaloneHostStopped:
    Delete "$R9\host-shutdown.request"
    ${ifNot} ${isUpdated}
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_EXECUTABLE_FILENAME}"
    ${endif}
!macroend
