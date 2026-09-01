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
    echo "Skipping unsupported SeaShard Host AppArmor profile"
  fi
fi

host_executable='/opt/${sanitizedProductName}/${executable}'
autostart_file='/etc/xdg/autostart/studio.sealantern.seashard.host.desktop'
install -d /etc/xdg/autostart
cat >"$autostart_file" <<EOF
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

target_user=''
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  target_user="$SUDO_USER"
else
  case "${PKEXEC_UID:-}" in
    ''|*[!0-9]*) ;;
    *)
      if [ "$PKEXEC_UID" -ne 0 ]; then
        target_user="$(getent passwd "$PKEXEC_UID" | cut -d: -f1)"
      fi
      ;;
  esac
fi

if [ -n "$target_user" ]; then
  user_home="$(getent passwd "$target_user" | cut -d: -f6)"
  if [ -n "$user_home" ]; then
    data_root="$user_home/.config/SeaShard/core"
    install -d -o "$target_user" -g "$(id -gn "$target_user")" "$data_root"
    if [ -f "$data_root/host-control.json" ]; then
      : >"$data_root/host-shutdown.request"
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
    runuser -u "$target_user" -- env HOME="$user_home" DISPLAY="${DISPLAY:-:0}" \
      "$host_executable" "--data-root=$data_root" >/dev/null 2>&1 &
  fi
fi
