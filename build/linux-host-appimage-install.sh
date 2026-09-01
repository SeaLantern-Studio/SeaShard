#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <SeaShardHost.AppImage>" >&2
  exit 2
fi

host_image="$1"
if [ ! -f "$host_image" ]; then
  echo "SeaShard Host AppImage is missing: $host_image" >&2
  exit 1
fi

config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
data_root="${SEASHARD_HOST_DATA_DIR:-$config_home/SeaShard/core}"
installation_root="$data_home/SeaShard/host"
runtime_root="$installation_root/runtime"
staging_root="$installation_root/.runtime-install-$$"
backup_root="$installation_root/.runtime-backup-$$"
control_file="$data_root/host-control.json"
shutdown_file="$data_root/host-shutdown.request"
log_file="$data_root/host-installation.log"

cleanup_staging() {
  rm -rf -- "$staging_root" "$backup_root"
}
trap cleanup_staging EXIT HUP INT TERM

mkdir -p "$installation_root" "$data_root"
mkdir -p "$staging_root"

# AppImage 的解包入口不依赖 FUSE。这里把完整 Host Runtime 永久安装到用户数据目录，
# 后续启动直接执行稳定的 AppRun，不会在每次启动时临时解包。
(
  cd "$staging_root"
  "$host_image" --appimage-extract >/dev/null
)
extracted_runtime="$staging_root/squashfs-root"
if [ ! -x "$extracted_runtime/AppRun" ]; then
  echo "SeaShard Host AppImage did not contain an executable AppRun." >&2
  exit 1
fi

# 替换已存在的 Runtime 前先请求旧 Host 安全退出，避免运行中二进制与资源被拆散。
if [ -f "$control_file" ]; then
  : > "$shutdown_file"
  attempts=0
  while [ -f "$control_file" ] && [ "$attempts" -lt 600 ]; do
    sleep 0.1
    attempts=$((attempts + 1))
  done
  if [ -f "$control_file" ]; then
    echo "SeaShard Host did not stop safely; installation cancelled." >&2
    exit 1
  fi
fi

if [ -e "$runtime_root" ]; then
  mv "$runtime_root" "$backup_root"
fi
if ! mv "$extracted_runtime" "$runtime_root"; then
  if [ -e "$backup_root" ]; then
    mv "$backup_root" "$runtime_root"
  fi
  echo "SeaShard Host Runtime could not be installed." >&2
  exit 1
fi
rm -rf -- "$backup_root" "$staging_root"
trap - EXIT HUP INT TERM

: > "$log_file"
env -u APPIMAGE \
  SEASHARD_HOST_INSTALLED_EXECUTABLE="$runtime_root/AppRun" \
  "$runtime_root/AppRun" "--data-root=$data_root" \
  >>"$log_file" 2>&1 </dev/null &
host_pid=$!

# 安装命令必须等到真实控制端点出现。这样 DEB 不会在 Host 启动失败时仍报告成功。
attempts=0
while [ ! -f "$control_file" ] && [ "$attempts" -lt 600 ]; do
  if ! kill -0 "$host_pid" 2>/dev/null; then
    wait "$host_pid" 2>/dev/null || true
    echo "SeaShard Host exited before becoming ready. Log: $log_file" >&2
    cat "$log_file" >&2 || true
    exit 1
  fi
  sleep 0.1
  attempts=$((attempts + 1))
done
if [ ! -f "$control_file" ]; then
  echo "SeaShard Host did not become ready. Log: $log_file" >&2
  exit 1
fi

exit 0
