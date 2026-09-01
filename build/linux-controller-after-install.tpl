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
  host_installer='/opt/${sanitizedProductName}/resources/host-installer/SeaShardHostSetup.AppImage'

  # 只调用独立 Host AppImage；Host 自行复制到用户目录并登记启动项。
  if [ -z "${SUDO_USER:-}" ] || [ "$SUDO_USER" = "root" ]; then
    return 0
  fi

  user_home="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
  if [ -z "$user_home" ]; then
    return 0
  fi

  data_root="$user_home/.config/SeaShard/core"
  if [ -f "$data_root/host-installation/standalone" ]; then
    return 0
  fi
  if [ ! -f "$host_installer" ]; then
    echo "Bundled SeaShard Host installer is missing." >&2
    return 1
  fi

  install -d -o "$SUDO_USER" -g "$(id -gn "$SUDO_USER")" "$data_root"
  chmod 755 "$host_installer"
  runuser -u "$SUDO_USER" -- env \
    HOME="$user_home" \
    DISPLAY="${DISPLAY:-:0}" \
    XDG_RUNTIME_DIR="/run/user/$(id -u "$SUDO_USER")" \
    "$host_installer" >/dev/null 2>&1 &
}

install_bundled_host
