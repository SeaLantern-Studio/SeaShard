#!/bin/sh
set -eu

host_installer='/opt/${sanitizedProductName}/resources/host-installer/SeaShardHostSetup.AppImage'

# DEB 安装阶段只调用独立 Host AppImage；Host 自行复制到用户目录并登记启动项。
if [ -z "${SUDO_USER:-}" ] || [ "$SUDO_USER" = "root" ]; then
  exit 0
fi

user_home="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
if [ -z "$user_home" ]; then
  exit 0
fi

data_root="$user_home/.config/SeaShard/core"
if [ -f "$data_root/host-installation/standalone" ]; then
  exit 0
fi
if [ ! -f "$host_installer" ]; then
  echo "Bundled SeaShard Host installer is missing." >&2
  exit 1
fi

install -d -o "$SUDO_USER" -g "$(id -gn "$SUDO_USER")" "$data_root"
chmod 755 "$host_installer"
runuser -u "$SUDO_USER" -- env \
  HOME="$user_home" \
  DISPLAY="${DISPLAY:-:0}" \
  XDG_RUNTIME_DIR="/run/user/$(id -u "$SUDO_USER")" \
  "$host_installer" >/dev/null 2>&1 &
