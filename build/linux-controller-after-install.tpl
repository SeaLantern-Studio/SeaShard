#!/bin/bash

# 与 app-builder-lib 26.15.3 templates/linux/after-install.tpl 同步；自定义钩子会替换默认脚本。
if type update-alternatives >/dev/null 2>&1; then
  if [ -L '/usr/bin/${executable}' ] &&
    [ -e '/usr/bin/${executable}' ] &&
    [ "$(readlink '/usr/bin/${executable}')" != '/etc/alternatives/${executable}' ]; then
    rm -f '/usr/bin/${executable}'
  fi
  update-alternatives \
    --install '/usr/bin/${executable}' '${executable}' \
    '/opt/${sanitizedProductName}/${executable}' 100 ||
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
  ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

if ! { [ -L /proc/self/ns/user ] && unshare --user true; }; then
  chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
  chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
  update-mime-database /usr/share/mime || true
fi
if hash update-desktop-database 2>/dev/null; then
  update-desktop-database /usr/share/applications || true
fi

if command -v apparmor_status >/dev/null 2>&1 &&
  apparmor_status --enabled >/dev/null 2>&1; then
  apparmor_source='/opt/${sanitizedProductName}/resources/apparmor-profile'
  apparmor_target='/etc/apparmor.d/${executable}'
  if command -v apparmor_parser >/dev/null 2>&1 &&
    apparmor_parser --skip-kernel-load --debug "$apparmor_source" >/dev/null 2>&1; then
    cp -f "$apparmor_source" "$apparmor_target"
    if ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; }; then
      apparmor_parser --replace --write-cache --skip-read-cache "$apparmor_target"
    fi
  else
    echo "Skipping unsupported SeaShard AppArmor profile"
  fi
fi

install_bundled_host() {
  host_image='/opt/${sanitizedProductName}/resources/host-installer/SeaShardHostSetup.AppImage'
  host_install_script='/opt/${sanitizedProductName}/resources/host-installer/install.sh'
  install_user=''

  # sudo 与 electron-updater 的 pkexec 路径分别提供 SUDO_USER、PKEXEC_UID。无人值守的
  # root 安装没有明确桌面用户，保持 Controller 安装成功且不猜测 Host 数据归属。
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    install_user="$SUDO_USER"
  else
    case "${PKEXEC_UID:-}" in
      ''|*[!0-9]*) ;;
      *)
        if [ "$PKEXEC_UID" -ne 0 ]; then
          install_user="$(getent passwd "$PKEXEC_UID" | cut -d: -f1)"
        fi
        ;;
    esac
  fi
  if [ -z "$install_user" ]; then
    return 0
  fi

  user_home="$(getent passwd "$install_user" | cut -d: -f6)"
  if [ -z "$user_home" ]; then
    return 0
  fi

  data_root="$user_home/.config/SeaShard/core"
  # Controller 内的随包制品只引导首次安装；已安装 Host 必须走自己的 Release 安装包。
  if [ -f "$data_root/host-installation.json" ]; then
    return 0
  fi

  if [ ! -f "$host_image" ] || [ ! -f "$host_install_script" ]; then
    echo "Bundled SeaShard Host installer is incomplete." >&2
    return 1
  fi

  # 首次安装把无 FUSE 的稳定 Runtime 写入用户目录并注册自动启动。后续 Controller
  # 安装会因上方标记直接跳过，绝不会顺带升级或降级 Host。
  install -d -o "$install_user" -g "$(id -gn "$install_user")" "$data_root"
  chmod 755 "$host_image"
  runuser -u "$install_user" -- env \
    HOME="$user_home" \
    DISPLAY="${DISPLAY:-:0}" \
    XDG_RUNTIME_DIR="/run/user/$(id -u "$install_user")" \
    SEASHARD_HOST_DATA_DIR="$data_root" \
    /bin/sh "$host_install_script" "$host_image"
}

install_bundled_host
