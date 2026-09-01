#!/bin/sh
set -eu

case "${1:-}" in
  upgrade|failed-upgrade|abort-install|abort-upgrade|disappear)
    exit 0
    ;;
esac

failed=0
for user_home in /root /home/*; do
  [ -d "$user_home" ] || continue
  data_root="$user_home/.config/SeaShard/core"
  [ -f "$data_root/host-control.json" ] || continue

  : > "$data_root/host-shutdown.request"
  attempts=0
  while [ -f "$data_root/host-control.json" ] && [ "$attempts" -lt 600 ]; do
    sleep 0.1
    attempts=$((attempts + 1))
  done
  if [ -f "$data_root/host-control.json" ]; then
    echo "SeaShard Host is still running for $user_home; removal cancelled." >&2
    failed=1
  fi
done

exit "$failed"
