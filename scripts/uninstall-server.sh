#!/bin/sh
set -eu

installation_owner="seashard-install-script-v1"

fail() {
  echo "SeaShard Server uninstall refused: $1" >&2
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

canonical_directory() {
  (cd -P "$1" && pwd)
}

require_exact_directory() {
  label="$1"
  value="$2"
  [ -d "$value" ] || fail "$label does not exist: $value"
  resolved="$(canonical_directory "$value")"
  [ "$resolved" = "$value" ] || fail "$label crosses a symbolic link: $value"
}

home_directory="${HOME:-}"
[ -n "$home_directory" ] || fail "HOME is empty"
case "$(uname -s)" in
  Linux)
    platform="linux"
    data_home="${XDG_DATA_HOME:-$home_directory/.local/share}"
    config_home="${XDG_CONFIG_HOME:-$home_directory/.config}"
    ;;
  Darwin)
    platform="macos"
    data_home="$home_directory/Library/Application Support"
    config_home="$home_directory/Library/Application Support"
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
[ -d "$data_home" ] || fail "data home does not exist: $data_home"
[ -d "$config_home" ] || fail "config home does not exist: $config_home"
home_directory="$(canonical_directory "$home_directory")"
data_home="$(canonical_directory "$data_home")"
config_home="$(canonical_directory "$config_home")"
if [ -d "$bin_home" ]; then
  bin_home="$(canonical_directory "$bin_home")"
fi

installation_root="$data_home/SeaShard/server"
runtime_root="$installation_root/runtime"
runtime_command="$runtime_root/seashard-server"
ownership_file="$installation_root/.install-source"
launcher="$bin_home/seashard-server"
shared_data_root="$config_home/SeaShard"
controller_data_root="$shared_data_root/server-controller"
host_data_root="$shared_data_root/core"

if [ ! -e "$installation_root" ]; then
  echo "SeaShard Server script installation was not found: $installation_root"
  exit 0
fi

# 所有递归删除目标都必须是规范化后的固定子目录，任何中间符号链接都会中止卸载。
require_exact_directory "installation root" "$installation_root"
require_exact_directory "runtime root" "$runtime_root"
require_exact_directory "Controller data root" "$controller_data_root"
if [ "$platform" = "linux" ]; then
  service_directory="$config_home/systemd/user"
else
  service_directory="$home_directory/Library/LaunchAgents"
fi
if [ -e "$service_directory" ]; then
  require_exact_directory "service directory" "$service_directory"
fi

[ -f "$runtime_command" ] || fail "runtime command is not a regular file: $runtime_command"
[ ! -L "$runtime_command" ] || fail "runtime command cannot be a symbolic link: $runtime_command"
[ -x "$runtime_command" ] || fail "runtime command is not executable: $runtime_command"

owned_installation=false
if [ -f "$ownership_file" ] &&
  [ ! -L "$ownership_file" ] &&
  [ "$(cat "$ownership_file")" = "$installation_owner" ]; then
  owned_installation=true
elif [ -L "$launcher" ] && [ "$(readlink "$launcher")" = "$runtime_command" ]; then
  # v0.8.0 首批安装没有归属文件，只接受安装脚本创建的精确绝对符号链接作为兼容凭据。
  owned_installation=true
fi
[ "$owned_installation" = true ] || fail "installation ownership could not be proven"

# 显式传入并固定所有会参与服务文件删除的数据目录，隔离调用者注入的 SeaShard 路径变量。
env \
  -u SEASHARD_SHARED_DATA_DIR \
  -u SEASHARD_HOST_DATA_DIR \
  -u SEASHARD_DATA_DIR \
  -u SEASHARD_CONTROLLER_DATA_DIR \
  -u SEASHARD_SERVER_DATA_DIR \
  HOME="$home_directory" \
  XDG_CONFIG_HOME="$config_home" \
  XDG_DATA_HOME="$data_home" \
  "$runtime_command" service uninstall \
  "--shared-data-root=$shared_data_root" \
  "--data-root=$controller_data_root" \
  "--host-data-root=$host_data_root"

# 后台程序已经执行过一次；删除前重新确认父目录没有在此期间被替换。
require_exact_directory "installation root" "$installation_root"
require_exact_directory "runtime root" "$runtime_root"

# 只删除安装脚本仍然拥有的入口、归属文件与 Runtime；安装根目录仅在为空时移除。
if [ -L "$launcher" ] && [ "$(readlink "$launcher")" = "$runtime_command" ]; then
  rm -f -- "$launcher"
fi
rm -rf -- "$runtime_root"
if [ -f "$ownership_file" ] && [ ! -L "$ownership_file" ]; then
  rm -f -- "$ownership_file"
fi
rmdir "$installation_root" 2>/dev/null || true

printf 'SeaShard Server uninstalled. Host, server instances, and user data were preserved.\n'
