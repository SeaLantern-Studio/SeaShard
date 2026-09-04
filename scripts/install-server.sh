#!/bin/sh
set -eu

repository="SeaLantern-Studio/SeaShard"
catalog_url="${SEASHARD_RELEASE_CATALOG_URL:-https://github.com/$repository/releases/latest/download/latest-release.json}"
installation_owner="seashard-install-script-v1"

fail() {
  echo "SeaShard Server install refused: $1" >&2
  exit 1
}

require_safe_base() {
  label="$1"
  value="$2"
  case "$value" in
    /*) ;;
    *) fail "$label must be an absolute path" ;;
  esac
  [ "$value" != "/" ] || fail "$label cannot be the filesystem root"
}

home_directory="${HOME:-}"
[ -n "$home_directory" ] || fail "HOME is empty"
case "$(uname -s)" in
  Linux)
    platform=linux
    config_home="${XDG_CONFIG_HOME:-$home_directory/.config}"
    data_home="${XDG_DATA_HOME:-$home_directory/.local/share}"
    ;;
  Darwin)
    platform=macos
    config_home="$home_directory/Library/Application Support"
    data_home="$home_directory/Library/Application Support"
    ;;
  *)
    fail "unsupported operating system: $(uname -s)"
    ;;
esac
bin_home="${XDG_BIN_HOME:-$home_directory/.local/bin}"

require_safe_base "HOME" "$home_directory"
require_safe_base "data home" "$data_home"
require_safe_base "config home" "$config_home"
require_safe_base "binary home" "$bin_home"
[ -d "$home_directory" ] || fail "HOME does not exist: $home_directory"
mkdir -p "$data_home" "$config_home" "$bin_home"
home_directory="$(cd -P "$home_directory" && pwd)"
data_home="$(cd -P "$data_home" && pwd)"
config_home="$(cd -P "$config_home" && pwd)"
bin_home="$(cd -P "$bin_home" && pwd)"
[ ! -L "$data_home/SeaShard" ] || fail "data root cannot be a symbolic link"
[ ! -L "$data_home/SeaShard/server" ] || fail "installation root cannot be a symbolic link"
[ ! -L "$config_home/SeaShard" ] || fail "config root cannot be a symbolic link"

installation_root="$data_home/SeaShard/server"
runtime_root="$installation_root/runtime"
staging_root="$installation_root/.runtime-install-$$"
backup_root="$installation_root/.runtime-backup-$$"
ownership_file="$installation_root/.install-source"
[ ! -L "$ownership_file" ] || fail "installation ownership file cannot be a symbolic link"
shared_data_root="$config_home/SeaShard"
controller_data_root="$shared_data_root/server-controller"
host_data_root="$shared_data_root/core"
temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/seashard-server-install.XXXXXX")"

install_service() {
  env \
    -u SEASHARD_SHARED_DATA_DIR \
    -u SEASHARD_HOST_DATA_DIR \
    -u SEASHARD_DATA_DIR \
    -u SEASHARD_CONTROLLER_DATA_DIR \
    -u SEASHARD_SERVER_DATA_DIR \
    HOME="$home_directory" \
    XDG_CONFIG_HOME="$config_home" \
    XDG_DATA_HOME="$data_home" \
    "$1" service install \
    "--shared-data-root=$shared_data_root" \
    "--data-root=$controller_data_root" \
    "--host-data-root=$host_data_root"
}

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
if ! install_service "$runtime_root/seashard-server"; then
  rm -rf -- "$runtime_root"
  if [ -e "$backup_root" ]; then
    mv "$backup_root" "$runtime_root"
    ln -sfn "$runtime_root/seashard-server" "$bin_home/seashard-server"
    install_service "$runtime_root/seashard-server" || true
  fi
  echo "SeaShard Server service installation failed; previous Runtime restored." >&2
  exit 1
fi
printf '%s\n' "$installation_owner" > "$ownership_file"
rm -rf -- "$backup_root"
trap - EXIT HUP INT TERM
rm -rf -- "$temporary_root"
printf 'SeaShard Server installed. Command: %s\n' "$bin_home/seashard-server"
