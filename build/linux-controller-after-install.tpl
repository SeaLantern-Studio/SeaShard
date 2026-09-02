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

prepare_bundled_host() {
  host_image='/opt/${sanitizedProductName}/resources/host-installer/SeaShardHostSetup.AppImage'
  host_install_script='/opt/${sanitizedProductName}/resources/host-installer/install.sh'

  if [ ! -f "$host_image" ] || [ ! -f "$host_install_script" ]; then
    echo "Bundled SeaShard Host installer is incomplete." >&2
    return 1
  fi
  # DEB 只负责准备系统级随包资源。Host 的用户级 Runtime、数据目录和自动启动项
  # 全部延迟到 Controller 首次以真实用户身份启动时创建。
  chmod 755 "$host_image"
}

prepare_bundled_host
