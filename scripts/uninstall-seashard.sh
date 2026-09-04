#!/bin/sh
set -eu

umask 077
installation_owner="seashard-component-uninstaller-v1"

fail() {
  echo "SeaShard 卸载器已停止：$1" >&2
  exit 1
}

require_absolute_path() {
  label="$1"
  value="$2"
  case "$value" in
    /*) ;;
    *) fail "$label 必须是绝对路径：$value" ;;
  esac
  [ "$value" != "/" ] || fail "$label 不能是文件系统根目录"
}

canonical_directory() {
  (cd -P "$1" && pwd)
}

require_exact_directory() {
  label="$1"
  value="$2"
  [ -d "$value" ] || fail "$label 不存在：$value"
  resolved="$(canonical_directory "$value")"
  [ "$resolved" = "$value" ] || fail "$label 经过了符号链接：$value"
}

canonical_file() {
  file_path="$1"
  file_parent="$(dirname "$file_path")"
  printf '%s/%s\n' "$(canonical_directory "$file_parent")" "$(basename "$file_path")"
}

read_owned_state() {
  state_file="$1"
  [ -f "$state_file" ] || return 1
  [ ! -L "$state_file" ] || fail "状态文件不能是符号链接：$state_file"
  IFS= read -r state_value <"$state_file" || [ -n "${state_value:-}" ]
  printf '%s\n' "$state_value"
}

home_directory="${HOME:-}"
[ -n "$home_directory" ] || fail "HOME 为空"
require_absolute_path "HOME" "$home_directory"
[ -d "$home_directory" ] || fail "HOME 不存在：$home_directory"
home_directory="$(canonical_directory "$home_directory")"

case "$(uname -s)" in
  Linux)
    platform="linux"
    config_home="${XDG_CONFIG_HOME:-$home_directory/.config}"
    data_home="${XDG_DATA_HOME:-$home_directory/.local/share}"
    bin_home="${XDG_BIN_HOME:-$home_directory/.local/bin}"
    ;;
  Darwin)
    platform="macos"
    config_home="$home_directory/Library/Application Support"
    data_home="$home_directory/Library/Application Support"
    bin_home="$home_directory/.local/bin"
    ;;
  *)
    fail "当前系统不受此卸载器支持：$(uname -s)"
    ;;
esac

require_absolute_path "配置目录" "$config_home"
require_absolute_path "数据目录" "$data_home"
require_absolute_path "命令目录" "$bin_home"
mkdir -p "$config_home" "$data_home"
config_home="$(canonical_directory "$config_home")"
data_home="$(canonical_directory "$data_home")"

uninstaller_root="$data_home/SeaShard/uninstaller"
uninstaller_program="$uninstaller_root/uninstall-seashard.sh"
uninstaller_owner_file="$uninstaller_root/.install-source"
controller_type_file="$uninstaller_root/controller-package-type"
controller_appimage_file="$uninstaller_root/controller-appimage.path"
controller_data_root_file="$uninstaller_root/controller-data-root.path"
launcher="$bin_home/seashard-uninstall"
linux_desktop_entry="$data_home/applications/studio.sealantern.seashard.uninstaller.desktop"
host_data_root="$config_home/SeaShard/core"
host_installation_root="$data_home/SeaShard/host"
linux_host_autostart="$config_home/autostart/studio.sealantern.seashard.host.desktop"
macos_host_agent="$home_directory/Library/LaunchAgents/studio.sealantern.seashard.host.plist"
macos_controller_app="/Applications/SeaShard.app"
macos_host_app="/Applications/SeaShardHost.app"
local_host_disabled_default="$config_home/SeaShard/desktop-controller/local-host-auto-install.disabled"

install_linux_uninstaller() {
  [ "$platform" = "linux" ] || fail "卸载器登记只支持 Linux"
  source_script="$0"
  [ -f "$source_script" ] || fail "卸载器源文件不存在：$source_script"
  mkdir -p "$uninstaller_root" "$bin_home" "$(dirname "$linux_desktop_entry")"
  require_exact_directory "卸载器目录" "$uninstaller_root"

  temporary_program="$uninstaller_root/.uninstall-seashard.$$"
  cp "$source_script" "$temporary_program"
  chmod 755 "$temporary_program"
  mv -f "$temporary_program" "$uninstaller_program"
  printf '%s\n' "$installation_owner" >"$uninstaller_owner_file"

  if [ -e "$launcher" ] || [ -L "$launcher" ]; then
    if [ ! -L "$launcher" ] || [ "$(readlink "$launcher")" != "$uninstaller_program" ]; then
      fail "命令入口已被其他程序占用：$launcher"
    fi
    rm -f -- "$launcher"
  fi
  ln -s "$uninstaller_program" "$launcher"

  desktop_exec="$(printf '%s' "$uninstaller_program" | sed 's/\\/\\\\/g; s/"/\\"/g; s/`/\\`/g; s/\$/\\$/g')"
  cat >"$linux_desktop_entry" <<EOF
[Desktop Entry]
Type=Application
Name=卸载 SeaShard
Comment=选择卸载 Desktop Controller、Host 或两者
Exec="$desktop_exec"
Terminal=true
NoDisplay=false
Categories=Utility;
X-SeaShard-Uninstaller=true
EOF
  chmod 644 "$linux_desktop_entry"
}

register_linux_controller() {
  package_type="${1:-}"
  appimage_path="${2:-}"
  controller_data_root="${3:-}"
  case "$package_type" in
    appimage | deb) ;;
    *) fail "未知的 Linux Controller 包类型：$package_type" ;;
  esac
  require_absolute_path "Controller 数据目录" "$controller_data_root"

  if [ "$package_type" = "appimage" ]; then
    require_absolute_path "Controller AppImage" "$appimage_path"
    [ -f "$appimage_path" ] || fail "Controller AppImage 不存在：$appimage_path"
    [ ! -L "$appimage_path" ] || fail "Controller AppImage 不能是符号链接"
    appimage_path="$(canonical_file "$appimage_path")"
  fi

  install_linux_uninstaller
  printf '%s\n' "$package_type" >"$controller_type_file"
  printf '%s\n' "$controller_data_root" >"$controller_data_root_file"
  if [ "$package_type" = "appimage" ]; then
    printf '%s\n' "$appimage_path" >"$controller_appimage_file"
  else
    rm -f -- "$controller_appimage_file"
  fi
  exit 0
}

register_linux_host() {
  install_linux_uninstaller
  exit 0
}

case "${1:-}" in
  --register-controller)
    shift
    register_linux_controller "$@"
    ;;
  --register-host)
    register_linux_host
    ;;
esac

# 卸载器可能位于即将删除的 AppImage、DEB 或 .app 内。先复制到临时目录，后续删除程序
# 文件时不会截断仍在执行的脚本。
if [ "${SEASHARD_UNINSTALL_RELOCATED:-0}" != "1" ]; then
  temporary_script="$(mktemp "${TMPDIR:-/tmp}/seashard-uninstall.XXXXXX")"
  cp "$0" "$temporary_script"
  chmod 700 "$temporary_script"
  export SEASHARD_UNINSTALL_RELOCATED=1
  exec "$temporary_script" "$@"
fi
temporary_script="$0"
trap 'rm -f -- "$temporary_script"' EXIT HUP INT TERM

package_is_installed() {
  package_name="$1"
  command -v dpkg-query >/dev/null 2>&1 || return 1
  package_status="$(dpkg-query -W -f='${Status}' "$package_name" 2>/dev/null || true)"
  [ "$package_status" = "install ok installed" ]
}

controller_package_type=""
controller_appimage_path=""
if [ "$platform" = "linux" ]; then
  if package_is_installed seashard; then
    controller_package_type="deb"
  elif [ -f "$uninstaller_owner_file" ] &&
    [ "$(cat "$uninstaller_owner_file")" = "$installation_owner" ] &&
    [ "$(read_owned_state "$controller_type_file" 2>/dev/null || true)" = "appimage" ]; then
    controller_appimage_path="$(read_owned_state "$controller_appimage_file" 2>/dev/null || true)"
    if [ -n "$controller_appimage_path" ] && [ -f "$controller_appimage_path" ]; then
      controller_package_type="appimage"
    fi
  fi
else
  if [ -d "$macos_controller_app" ]; then
    controller_package_type="pkg"
  fi
fi

host_package_type=""
if [ "$platform" = "linux" ]; then
  if package_is_installed seashard-host; then
    host_package_type="deb"
  elif [ -f "$host_data_root/host-installation/standalone" ] &&
    [ -d "$host_installation_root" ]; then
    host_package_type="appimage"
  fi
else
  if [ -d "$macos_host_app" ] || [ -f "$macos_host_agent" ] ||
    [ -f "$host_data_root/host-installation/standalone" ]; then
    host_package_type="pkg"
  fi
fi

controller_installed=false
host_installed=false
[ -n "$controller_package_type" ] && controller_installed=true
[ -n "$host_package_type" ] && host_installed=true

select_components_linux() {
  if [ "$controller_installed" = false ] && [ "$host_installed" = false ]; then
    echo "没有检测到 SeaShard Desktop Controller 或 Host。"
    exit 0
  fi
  [ -t 0 ] || fail "非交互执行请使用 --controller、--host 或 --all"

  echo "选择要卸载的 SeaShard 组件："
  if [ "$controller_installed" = true ] && [ "$host_installed" = true ]; then
    echo "  1) Desktop Controller"
    echo "  2) Host"
    echo "  3) Desktop Controller 和 Host"
    printf "请输入 1、2 或 3："
    IFS= read -r selection
    case "$selection" in
      1) remove_controller=true ;;
      2) remove_host=true ;;
      3)
        remove_controller=true
        remove_host=true
        ;;
      *) fail "没有选择有效的卸载项目" ;;
    esac
  elif [ "$controller_installed" = true ]; then
    printf "仅检测到 Desktop Controller，是否卸载？[y/N] "
    IFS= read -r selection
    case "$selection" in y | Y) remove_controller=true ;; *) exit 0 ;; esac
  else
    printf "仅检测到 Host，是否卸载？[y/N] "
    IFS= read -r selection
    case "$selection" in y | Y) remove_host=true ;; *) exit 0 ;; esac
  fi
}

select_components_macos() {
  selection="$(/usr/bin/osascript - "$controller_installed" "$host_installed" <<'APPLESCRIPT'
on run argv
  set availableActions to {}
  if item 1 of argv is "true" and item 2 of argv is "true" then
    set availableActions to {"仅卸载 Desktop Controller", "仅卸载 SeaShard Host", "同时卸载 Controller 和 Host"}
  else if item 1 of argv is "true" then
    set availableActions to {"卸载 Desktop Controller"}
  else if item 2 of argv is "true" then
    set availableActions to {"卸载 SeaShard Host"}
  else
    display dialog "没有检测到 SeaShard Desktop Controller 或 Host。" buttons {"确定"} default button "确定"
    return "cancel"
  end if
  set selectedAction to choose from list availableActions with title "卸载 SeaShard" with prompt "选择要卸载的组件。服务器实例和用户数据将继续保留。" default items {item 1 of availableActions}
  if selectedAction is false then return "cancel"
  return item 1 of selectedAction
end run
APPLESCRIPT
)"
  [ "$selection" != "cancel" ] || exit 0
  case "$selection" in
    "仅卸载 Desktop Controller" | "卸载 Desktop Controller")
      remove_controller=true
      ;;
    "仅卸载 SeaShard Host" | "卸载 SeaShard Host")
      remove_host=true
      ;;
    "同时卸载 Controller 和 Host")
      remove_controller=true
      remove_host=true
      ;;
    *)
      fail "没有选择有效的卸载项目"
      ;;
  esac
}

remove_controller=false
remove_host=false
case "${1:-}" in
  "")
    if [ "$platform" = "macos" ]; then
      select_components_macos
    else
      select_components_linux
    fi
    ;;
  --controller)
    remove_controller=true
    ;;
  --host)
    remove_host=true
    ;;
  --all)
    remove_controller=true
    remove_host=true
    ;;
  *)
    fail "未知参数：$1"
    ;;
esac

if [ "$remove_controller" = true ] && [ "$controller_installed" = false ]; then
  echo "Desktop Controller 未安装，将跳过。"
  remove_controller=false
fi
if [ "$remove_host" = true ] && [ "$host_installed" = false ]; then
  echo "Host 未安装，将跳过。"
  remove_host=false
fi
if [ "$remove_controller" = false ] && [ "$remove_host" = false ]; then
  exit 0
fi

host_has_other_bundled_owners() {
  [ -f "$host_data_root/host-installation/bundled" ] || return 1
  owner_root="$host_data_root/host-installation/owners"
  [ -d "$owner_root" ] || return 1
  for owner_path in "$owner_root"/*; do
    [ -f "$owner_path" ] || continue
    [ "$(basename "$owner_path")" = "desktop" ] || return 0
  done
  return 1
}

stop_host() {
  [ -d "$host_data_root" ] || return 0
  require_exact_directory "Host 数据目录" "$host_data_root"
  control_file="$host_data_root/host-control.json"
  shutdown_file="$host_data_root/host-shutdown.request"
  [ ! -L "$control_file" ] || fail "Host 控制文件不能是符号链接"
  [ ! -L "$shutdown_file" ] || fail "Host 关闭请求不能是符号链接"

  if [ "$platform" = "linux" ]; then
    rm -f -- "$linux_host_autostart"
  else
    rm -f -- "$macos_host_agent"
    /bin/launchctl bootout "gui/$(id -u)/studio.sealantern.seashard.host" >/dev/null 2>&1 || true
  fi

  if [ -f "$control_file" ]; then
    : >"$shutdown_file"
    attempts=0
    while [ -f "$control_file" ] && [ "$attempts" -lt 600 ]; do
      sleep 0.1
      attempts=$((attempts + 1))
    done
    if [ -f "$control_file" ]; then
      echo "Host 未能在 60 秒内安全停止，Host 程序和数据均已保留。" >&2
      return 1
    fi
  fi
  return 0
}
prepare_controller_removal() {
  if [ "$platform" = "linux" ]; then
    if command -v pgrep >/dev/null 2>&1 && pgrep -x seashard >/dev/null 2>&1; then
      echo "请先关闭 SeaShard Desktop，再重新运行卸载器。" >&2
      return 1
    fi
    return 0
  fi

  /usr/bin/osascript -e 'tell application id "studio.sealantern.seashard" to quit' \
    >/dev/null 2>&1 || true
  attempts=0
  while /usr/bin/pgrep -x SeaShard >/dev/null 2>&1 && [ "$attempts" -lt 100 ]; do
    sleep 0.1
    attempts=$((attempts + 1))
  done
  if /usr/bin/pgrep -x SeaShard >/dev/null 2>&1; then
    echo "SeaShard Desktop 未能安全退出，Controller 程序已保留。" >&2
    return 1
  fi
  return 0
}


cleanup_host_state() {
  [ -d "$host_data_root" ] || return 0
  require_exact_directory "Host 数据目录" "$host_data_root"
  rm -rf -- "$host_data_root/host-installation"
  rm -f -- \
    "$host_data_root/host-installation.json" \
    "$host_data_root/host-installation.log" \
    "$host_data_root/host-shutdown.request" \
    "$host_data_root/host-control.json"
}

mark_host_auto_install_disabled() {
  [ "$platform" = "linux" ] || return 0
  marker="$local_host_disabled_default"
  if [ -f "$uninstaller_owner_file" ] &&
    [ "$(cat "$uninstaller_owner_file")" = "$installation_owner" ]; then
    recorded_root="$(read_owned_state "$controller_data_root_file" 2>/dev/null || true)"
    if [ -n "$recorded_root" ]; then
      require_absolute_path "Controller 数据目录" "$recorded_root"
      marker="$recorded_root/local-host-auto-install.disabled"
    fi
  fi
  mkdir -p "$(dirname "$marker")"
  : >"$marker"
}

run_linux_package_removal() {
  if [ "$(id -u)" -eq 0 ]; then
    apt-get purge -y "$@"
    return
  fi
  if command -v pkexec >/dev/null 2>&1; then
    pkexec apt-get purge -y "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1 && [ -t 0 ]; then
    sudo apt-get purge -y "$@"
    return
  fi
  fail "卸载 DEB 需要 pkexec，或在终端中使用 sudo"
}

controller_result="保留"
host_result="保留"
failed=false
controller_ready=false
if [ "$remove_controller" = true ]; then
  if prepare_controller_removal; then
    controller_ready=true
  else
    controller_result="安全退出失败"
    failed=true
  fi
fi


if [ "$platform" = "linux" ]; then
  host_ready=false
  if [ "$remove_host" = true ]; then
    if host_has_other_bundled_owners; then
      echo "Host 仍被其他 Controller 使用，本次保留 Host。" >&2
      host_result="仍被其他 Controller 使用"
      failed=true
    elif stop_host; then
      host_ready=true
    else
      host_result="安全停止失败"
      failed=true
    fi
  fi

  deb_packages=""
  if [ "$remove_host" = true ] && [ "$host_ready" = true ]; then
    if [ "$host_package_type" = "deb" ]; then
      deb_packages="seashard-host"
    else
      require_exact_directory "Host 安装目录" "$host_installation_root"
      [ -f "$host_data_root/host-installation/standalone" ] ||
        fail "无法证明用户级 Host 的安装归属"
      rm -rf -- "$host_installation_root"
      cleanup_host_state
      host_result="已卸载"
    fi
  fi

  if [ "$remove_controller" = true ] && [ "$controller_ready" = true ]; then
    if [ "$controller_package_type" = "deb" ]; then
      if [ -n "$deb_packages" ]; then
        deb_packages="$deb_packages seashard"
      else
        deb_packages="seashard"
      fi
    else
      [ -f "$uninstaller_owner_file" ] || fail "缺少 Controller AppImage 卸载器归属记录"
      [ "$(cat "$uninstaller_owner_file")" = "$installation_owner" ] ||
        fail "Controller AppImage 卸载器归属记录无效"
      require_absolute_path "Controller AppImage" "$controller_appimage_path"
      [ -f "$controller_appimage_path" ] || fail "Controller AppImage 已不存在"
      [ ! -L "$controller_appimage_path" ] || fail "Controller AppImage 不能是符号链接"
      [ "$(canonical_file "$controller_appimage_path")" = "$controller_appimage_path" ] ||
        fail "Controller AppImage 路径经过了符号链接"
      rm -f -- "$controller_appimage_path"
      rm -f -- "$controller_type_file" "$controller_appimage_file" "$controller_data_root_file"
      controller_result="已卸载"
    fi
  fi

  if [ -n "$deb_packages" ]; then
    # 包名由上方固定分支生成，不接受用户输入；一次授权完成所选 DEB 的卸载。
    if run_linux_package_removal $deb_packages; then
      if [ "$remove_host" = true ] && [ "$host_ready" = true ] &&
        [ "$host_package_type" = "deb" ]; then
        cleanup_host_state
        host_result="已卸载"
      fi
      if [ "$remove_controller" = true ] && [ "$controller_package_type" = "deb" ]; then
        rm -f -- "$controller_type_file" "$controller_appimage_file" "$controller_data_root_file"
        controller_result="已卸载"
      fi
    else
      [ "$remove_host" = true ] && [ "$host_package_type" = "deb" ] && host_result="APT 卸载失败"
      [ "$remove_controller" = true ] && [ "$controller_package_type" = "deb" ] && controller_result="APT 卸载失败"
      failed=true
    fi
  fi
else
  host_ready=false
  if [ "$remove_host" = true ]; then
    if host_has_other_bundled_owners; then
      host_result="仍被其他 Controller 使用"
      failed=true
    elif stop_host; then
      host_ready=true
    else
      host_result="安全停止失败"
      failed=true
    fi
  fi

  if { [ "$remove_host" = true ] && [ "$host_ready" = true ]; } ||
    { [ "$remove_controller" = true ] && [ "$controller_ready" = true ]; }; then
  privileged_script="$(mktemp "${TMPDIR:-/tmp}/seashard-uninstall-privileged.XXXXXX")"
  {
    echo '#!/bin/sh'
    echo 'set -eu'
    if [ "$remove_host" = true ] && [ "$host_ready" = true ]; then
      echo "/bin/rm -rf -- '/Applications/SeaShardHost.app'"
      echo "/usr/sbin/pkgutil --forget studio.sealantern.seashard.host >/dev/null 2>&1 || true"
    fi
    if [ "$remove_controller" = true ] && [ "$controller_ready" = true ]; then
      echo "/bin/rm -rf -- '/Applications/SeaShard.app'"
      echo "/usr/sbin/pkgutil --forget studio.sealantern.seashard >/dev/null 2>&1 || true"
    fi
    if { [ "$controller_installed" = false ] ||
      { [ "$remove_controller" = true ] && [ "$controller_ready" = true ]; }; } &&
      { [ "$host_installed" = false ] ||
        { [ "$remove_host" = true ] && [ "$host_ready" = true ]; }; }; then
      echo "/bin/rm -rf -- '/Applications/SeaShard Uninstaller.app'"
    fi
  } >"$privileged_script"
  chmod 700 "$privileged_script"

  if /usr/bin/osascript - "$privileged_script" <<'APPLESCRIPT'
on run argv
  do shell script "/bin/sh " & quoted form of (item 1 of argv) with administrator privileges
end run
APPLESCRIPT
  then
    if [ "$remove_host" = true ] && [ "$host_ready" = true ]; then
      cleanup_host_state
      host_result="已卸载"
    fi
    if [ "$remove_controller" = true ] && [ "$controller_ready" = true ]; then
      controller_result="已卸载"
    fi
  else
    [ "$remove_host" = true ] && [ "$host_ready" = true ] && host_result="授权或删除失败"
    [ "$remove_controller" = true ] && [ "$controller_ready" = true ] &&
      controller_result="授权或删除失败"
    failed=true
  fi
  rm -f -- "$privileged_script"
  fi
fi
if [ "$platform" = "linux" ] && [ "$host_result" = "已卸载" ] &&
  [ "$controller_result" != "已卸载" ]; then
  mark_host_auto_install_disabled
fi


cleanup_uninstaller_registration() {
  [ -f "$uninstaller_owner_file" ] || return 0
  [ ! -L "$uninstaller_owner_file" ] || return 0
  [ "$(cat "$uninstaller_owner_file")" = "$installation_owner" ] || return 0
  if [ -L "$launcher" ] && [ "$(readlink "$launcher")" = "$uninstaller_program" ]; then
    rm -f -- "$launcher"
  fi
  rm -f -- "$linux_desktop_entry"
  require_exact_directory "卸载器目录" "$uninstaller_root"
  rm -rf -- "$uninstaller_root"
}

if [ "$platform" = "linux" ]; then
  remaining_controller=false
  remaining_host=false
  package_is_installed seashard && remaining_controller=true
  package_is_installed seashard-host && remaining_host=true
  [ -n "$controller_appimage_path" ] && [ -f "$controller_appimage_path" ] && remaining_controller=true
  [ -d "$host_installation_root" ] && remaining_host=true
  if [ "$remaining_controller" = false ] && [ "$remaining_host" = false ]; then
    cleanup_uninstaller_registration
  fi
fi

printf 'Desktop Controller：%s\n' "$controller_result"
printf 'Host：%s\n' "$host_result"
printf '服务器实例、世界存档、插件、数据库和用户配置均已保留。\n'

if [ "$platform" = "macos" ]; then
  /usr/bin/osascript - "$controller_result" "$host_result" <<'APPLESCRIPT' >/dev/null
on run argv
  display dialog "Desktop Controller：" & item 1 of argv & return & "Host：" & item 2 of argv & return & return & "服务器实例和用户数据均已保留。" with title "SeaShard 卸载结果" buttons {"确定"} default button "确定"
end run
APPLESCRIPT
fi

[ "$failed" = false ] || exit 1
