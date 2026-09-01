#!/bin/bash

case "${1:-}" in
upgrade | failed-upgrade | abort-install | abort-upgrade | disappear)
  exit 0
  ;;
esac

# 与 app-builder-lib 26.15.3 templates/linux/after-remove.tpl 同步；随后清理 Host 安装状态。
if type update-alternatives >/dev/null 2>&1; then
  update-alternatives \
    --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
  rm -f '/usr/bin/${executable}'
fi

apparmor_target='/etc/apparmor.d/${executable}'
if [ -f "$apparmor_target" ]; then
  if command -v apparmor_status >/dev/null 2>&1 &&
    apparmor_status --enabled >/dev/null 2>&1 &&
    command -v apparmor_parser >/dev/null 2>&1 &&
    ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; }; then
    apparmor_parser --remove "$apparmor_target" || true
  fi
  rm -f "$apparmor_target"
fi

rm -f /etc/xdg/autostart/studio.sealantern.seashard.host.desktop

for user_home in /root /home/*; do
  [ -d "$user_home" ] || continue
  data_root="$user_home/.config/SeaShard/core"
  [ -d "$data_root" ] || continue

  rm -f "$data_root/host-shutdown.request"
  rm -f "$data_root/host-control.json"
  rm -f "$data_root/host-installation/standalone"
  rmdir "$data_root/host-installation/owners" 2>/dev/null || true
  rmdir "$data_root/host-installation" 2>/dev/null || true
  rm -f "$data_root/host-installation.json"
done
