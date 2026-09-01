#!/bin/sh
set -eu

host_executable='/opt/${sanitizedProductName}/${executable}'
autostart_file='/etc/xdg/autostart/studio.sealantern.seashard.host.desktop'
install -d /etc/xdg/autostart
cat > "$autostart_file" <<EOF
[Desktop Entry]
Type=Application
Name=SeaShard Host
Comment=SeaShard background host runtime
Exec="$host_executable"
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF
chmod 644 "$autostart_file"

if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  user_home="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
  if [ -n "$user_home" ]; then
    data_root="$user_home/.config/SeaShard/core"
    install -d -o "$SUDO_USER" -g "$(id -gn "$SUDO_USER")" "$data_root"
    if [ -f "$data_root/host-control.json" ]; then
      : > "$data_root/host-shutdown.request"
      attempts=0
      while [ -f "$data_root/host-control.json" ] && [ "$attempts" -lt 600 ]; do
        sleep 0.1
        attempts=$((attempts + 1))
      done
      if [ -f "$data_root/host-control.json" ]; then
        echo "SeaShard Host did not stop safely; installation cancelled." >&2
        exit 1
      fi
    fi
    runuser -u "$SUDO_USER" -- env HOME="$user_home" DISPLAY="${DISPLAY:-:0}" \
      "$host_executable" "--data-root=$data_root" >/dev/null 2>&1 &
  fi
fi
