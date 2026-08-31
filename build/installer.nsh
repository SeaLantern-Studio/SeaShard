!macro resolveSeaShardHostDataRoot output
  ReadEnvStr ${output} "SEASHARD_HOST_INSTALL_DATA_ROOT"
  ${if} ${output} == ""
    StrCpy ${output} "$APPDATA\SeaShard\core"
  ${endif}
!macroend

!macro customInstall
  ; 默认安装器始终安装 Controller；本机缺少独立 Host 时，再调用独立 Host 安装器。
  !insertmacro resolveSeaShardHostDataRoot $R9
  InitPluginsDir
  File /oname=$PLUGINSDIR\SeaShardHostSetup.exe "${BUILD_RESOURCES_DIR}\host-installer\SeaShardHostSetup.exe"
  ${ifNot} ${FileExists} "$R9\host-installation\standalone"
    ExecWait '"$PLUGINSDIR\SeaShardHostSetup.exe" /S' $R0
    ${if} $R0 != 0
      Abort "SeaShard Host installation failed."
    ${endif}
  ${endif}
!macroend
