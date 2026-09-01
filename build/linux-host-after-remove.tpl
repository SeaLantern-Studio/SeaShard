#!/bin/sh
set -eu

case "${1:-}" in
  upgrade|failed-upgrade|abort-install|abort-upgrade|disappear)
    exit 0
    ;;
esac

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
