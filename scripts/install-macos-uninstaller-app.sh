#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <uninstall-seashard.sh>" >&2
  exit 2
fi

source_script="$1"
uninstaller_app="/Applications/SeaShard Uninstaller.app"
contents="$uninstaller_app/Contents"
macos_directory="$contents/MacOS"
executable="$macos_directory/SeaShard Uninstaller"

case "$source_script" in
  /*) ;;
  *)
    echo "SeaShard uninstaller source must be an absolute path: $source_script" >&2
    exit 1
    ;;
esac
[ -f "$source_script" ] || {
  echo "SeaShard uninstaller source is missing: $source_script" >&2
  exit 1
}
[ ! -L "$source_script" ] || {
  echo "SeaShard uninstaller source cannot be a symbolic link: $source_script" >&2
  exit 1
}

install -d -o root -g wheel -m 755 "$macos_directory"
install -o root -g wheel -m 755 "$source_script" "$executable"
cat >"$contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>SeaShard Uninstaller</string>
  <key>CFBundleExecutable</key>
  <string>SeaShard Uninstaller</string>
  <key>CFBundleIdentifier</key>
  <string>studio.sealantern.seashard.uninstaller</string>
  <key>CFBundleName</key>
  <string>SeaShard Uninstaller</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
EOF
chown root:wheel "$contents/Info.plist"
chmod 644 "$contents/Info.plist"
