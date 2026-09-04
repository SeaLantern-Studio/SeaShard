#!/bin/sh
set -eu

repository="SeaLantern-Studio/SeaShard"
catalog_url="${SEASHARD_RELEASE_CATALOG_URL:-https://github.com/$repository/releases/latest/download/latest-release.json}"
case "$(uname -s)" in
  Linux)
    platform=linux
    config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
    data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
    ;;
  Darwin)
    platform=macos
    config_home="$HOME/Library/Application Support"
    data_home="$HOME/Library/Application Support"
    ;;
  *)
    echo "Unsupported operating system: $(uname -s)" >&2
    exit 1
    ;;
esac
bin_home="${XDG_BIN_HOME:-$HOME/.local/bin}"
installation_root="$data_home/SeaShard/server"
runtime_root="$installation_root/runtime"
staging_root="$installation_root/.runtime-install-$$"
backup_root="$installation_root/.runtime-backup-$$"
temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/seashard-server-install.XXXXXX")"

cleanup() {
  rm -rf -- "$temporary_root" "$staging_root"
}
trap cleanup EXIT HUP INT TERM

for command in curl python3 tar; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "SeaShard Server installation requires $command." >&2
    exit 1
  fi
done

case "$(uname -m)" in
  x86_64|amd64) architecture=x64 ;;
  aarch64|arm64) architecture=arm64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

catalog="$temporary_root/latest-release.json"
curl --fail --silent --show-error --location "$catalog_url" --output "$catalog"
asset_record="$(python3 - "$catalog" "$repository" "$platform" "$architecture" <<'PY'
import json
import re
import sys
from urllib.parse import urlparse

catalog_path, repository, platform, architecture = sys.argv[1:]
with open(catalog_path, "r", encoding="utf-8") as source:
    catalog = json.load(source)
version = catalog.get("version")
if catalog.get("schemaVersion") != 1 or catalog.get("tag") != f"v{version}" or not re.fullmatch(r"\d+\.\d+\.\d+", str(version)):
    raise SystemExit("Invalid SeaShard Release catalog")
name = f"SeaShard-Server-{version}-{platform}-{architecture}.tar.gz"
assets = [item for item in catalog.get("assets", []) if item.get("name") == name]
if len(assets) != 1:
    raise SystemExit(f"Release catalog does not contain exactly one {name}")
asset = assets[0]
url = urlparse(str(asset.get("downloadUrl", "")))
expected_path = f"/{repository}/releases/download/v{version}/{name}"
digest = str(asset.get("sha256", ""))
size = asset.get("size")
if url.scheme != "https" or url.netloc != "github.com" or url.path != expected_path or url.query or url.fragment:
    raise SystemExit("Release asset URL is not trusted")
if not re.fullmatch(r"[a-f0-9]{64}", digest) or not isinstance(size, int) or size < 0:
    raise SystemExit("Release asset integrity metadata is invalid")
print(f"{name}\t{url.geturl()}\t{digest}\t{size}")
PY
)"
IFS="	" read -r asset_name asset_url expected_sha256 expected_size <<EOF
$asset_record
EOF

archive="$temporary_root/$asset_name"
curl --fail --silent --show-error --location "$asset_url" --output "$archive"
actual_record="$(python3 - "$archive" <<'PY'
import hashlib
import os
import sys

path = sys.argv[1]
digest = hashlib.sha256()
with open(path, "rb") as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        digest.update(chunk)
print(f"{os.path.getsize(path)}\t{digest.hexdigest()}")
PY
)"
IFS="	" read -r actual_size actual_sha256 <<EOF
$actual_record
EOF
if [ "$actual_size" != "$expected_size" ] || [ "$actual_sha256" != "$expected_sha256" ]; then
  echo "SeaShard Server package integrity verification failed." >&2
  exit 1
fi

tar -xzf "$archive" -C "$temporary_root"
if [ ! -x "$temporary_root/SeaShardServer/seashard-server" ]; then
  echo "SeaShard Server package does not contain its launcher." >&2
  exit 1
fi

mkdir -p "$installation_root" "$bin_home" "$config_home/SeaShard/server-controller"
cp -R "$temporary_root/SeaShardServer" "$staging_root"
if [ -x "$runtime_root/seashard-server" ]; then
  "$runtime_root/seashard-server" service stop || true
fi
rm -rf -- "$backup_root"
if [ -e "$runtime_root" ]; then mv "$runtime_root" "$backup_root"; fi
if ! mv "$staging_root" "$runtime_root"; then
  if [ -e "$backup_root" ]; then mv "$backup_root" "$runtime_root"; fi
  echo "SeaShard Server Runtime replacement failed." >&2
  exit 1
fi
ln -sfn "$runtime_root/seashard-server" "$bin_home/seashard-server"
if ! "$runtime_root/seashard-server" service install; then
  rm -rf -- "$runtime_root"
  if [ -e "$backup_root" ]; then
    mv "$backup_root" "$runtime_root"
    ln -sfn "$runtime_root/seashard-server" "$bin_home/seashard-server"
    "$runtime_root/seashard-server" service install || true
  fi
  echo "SeaShard Server service installation failed; previous Runtime restored." >&2
  exit 1
fi
rm -rf -- "$backup_root"
trap - EXIT HUP INT TERM
rm -rf -- "$temporary_root"
printf 'SeaShard Server installed. Command: %s\n' "$bin_home/seashard-server"
