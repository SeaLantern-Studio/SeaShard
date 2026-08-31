!macro resolveSeaShardHostDataRoot output
  ReadEnvStr ${output} "SEASHARD_HOST_INSTALL_DATA_ROOT"
  ${if} ${output} == ""
    StrCpy ${output} "$APPDATA\SeaShard\core"
  ${endif}
!macroend

!ifdef BUILD_UNINSTALLER
  !include "MUI2.nsh"
  !include "nsDialogs.nsh"

  Var SeaShardRemoveHostCheckbox
  Var SeaShardRemoveHost
  Var SeaShardHostUninstaller

  ; 从 Windows 卸载注册表读取真实路径，兼容用户自定义 Host 安装目录。v0.4.0 的默认
  ; 安装目录作为兜底，让已发布版本也能被 Controller 连带卸载。
  Function un.FindSeaShardHostUninstaller
    StrCpy $SeaShardHostUninstaller ""
    StrCpy $R0 0

    seashardFindHostUninstaller:
      EnumRegKey $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $R0
      StrCmp $R1 "" seashardFindHostFallback
      ReadRegStr $R2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R1" "DisplayName"
      StrCpy $R3 $R2 13
      StrCmp $R3 "SeaShard Host" 0 seashardFindHostNext

      ReadRegStr $SeaShardHostUninstaller HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R1" "QuietUninstallString"
      StrCmp $SeaShardHostUninstaller "" 0 seashardFindHostDone
      ReadRegStr $SeaShardHostUninstaller HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R1" "UninstallString"
      StrCmp $SeaShardHostUninstaller "" seashardFindHostFallback
      StrCpy $SeaShardHostUninstaller "$SeaShardHostUninstaller /S"
      Goto seashardFindHostDone

    seashardFindHostNext:
      IntOp $R0 $R0 + 1
      Goto seashardFindHostUninstaller

    seashardFindHostFallback:
      ${if} ${FileExists} "$LOCALAPPDATA\Programs\SeaShardHost\Uninstall SeaShardHost.exe"
        StrCpy $SeaShardHostUninstaller '$\"$LOCALAPPDATA\Programs\SeaShardHost\Uninstall SeaShardHost.exe$\" /S'
      ${endif}

    seashardFindHostDone:
  FunctionEnd

  ; Controller 卸载器使用自己的原生选项页。Host 选项默认关闭；没有检测到 Host 时不显示
  ; 复选框，避免让用户误以为卸载器还会处理不存在的后台组件。
  Function un.SeaShardUninstallOptionsCreate
    StrCpy $SeaShardRemoveHost 0
    StrCpy $SeaShardRemoveHostCheckbox ""
    Call un.FindSeaShardHostUninstaller

    !insertmacro MUI_HEADER_TEXT "卸载 SeaShard" "选择要移除的本机组件"
    nsDialogs::Create 1018
    Pop $R0
    ${if} $R0 == error
      Abort
    ${endif}

    ${NSD_CreateLabel} 0 0 100% 28u "卸载 Controller 后，本机 Host 可以继续运行并管理服务器。"
    Pop $R0

    ${if} $SeaShardHostUninstaller != ""
      ${NSD_CreateCheckbox} 0 36u 100% 14u "同时卸载本机 SeaShard Host"
      Pop $SeaShardRemoveHostCheckbox
      ${NSD_Uncheck} $SeaShardRemoveHostCheckbox
      ${NSD_CreateLabel} 12u 56u 88% 24u "Minecraft 服务器实例和数据将继续保留。"
      Pop $R0
    ${else}
      ${NSD_CreateLabel} 0 36u 100% 24u "本机没有检测到独立 SeaShard Host。"
      Pop $R0
    ${endif}

    nsDialogs::Show
  FunctionEnd

  Function un.SeaShardUninstallOptionsLeave
    ${if} $SeaShardRemoveHostCheckbox != ""
      ${NSD_GetState} $SeaShardRemoveHostCheckbox $SeaShardRemoveHost
    ${endif}
  FunctionEnd

  Function un.RemoveSeaShardHost
    Call un.FindSeaShardHostUninstaller
    ${if} $SeaShardHostUninstaller == ""
      MessageBox MB_OK|MB_ICONEXCLAMATION "没有找到 SeaShard Host 卸载器，将继续卸载 Controller。"
      Return
    ${endif}

    DetailPrint "正在卸载本机 SeaShard Host..."
    ClearErrors
    ExecWait '$SeaShardHostUninstaller' $R0
    ${if} ${Errors}
      MessageBox MB_OK|MB_ICONEXCLAMATION "无法启动 SeaShard Host 卸载器。Host 已保留，Controller 将继续卸载。"
      Return
    ${endif}
    ${if} $R0 != 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "SeaShard Host 未能安全卸载。Host 和服务器数据已保留，Controller 将继续卸载。"
    ${endif}
  FunctionEnd

  !macro customUnWelcomePage
    UninstPage custom un.SeaShardUninstallOptionsCreate un.SeaShardUninstallOptionsLeave
  !macroend

  !macro customUnInstall
    ${if} $SeaShardRemoveHost == ${BST_CHECKED}
      Call un.RemoveSeaShardHost
    ${endif}
  !macroend
!endif

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
