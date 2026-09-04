#!/bin/sh
set -eu

case "$(uname -s)" in
  Linux)
    data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
    ;;
  Darwin)
    data_home="$HOME/Library/Application Support"
    ;;
  *)
    echo "Unsupported operating system: $(uname -s)" >&2
    exit 1
    ;;
esac

bin_home="${XDG_BIN_HOME:-$HOME/.local/bin}"
installation_root="$data_home/SeaShard/server"
runtime_command="$installation_root/runtime/seashard-server"
launcher="$bin_home/seashard-server"

if [ ! -x "$runtime_command" ]; then
  echo "SeaShard Server script installation was not found: $installation_root"
  exit 0
fi

# 先停止进程并移除当前用户的后台服务；失败时保留 Runtime，避免留下指向缺失程序的服务。
"$runtime_command" service uninstall

# 安装脚本只拥有自己创建且仍指向当前 Runtime 的符号链接，不能误删其他安装来源的命令。
if [ -L "$launcher" ] && [ "$(readlink "$launcher")" = "$runtime_command" ]; then
  rm -f -- "$launcher"
fi
rm -rf -- "$installation_root"

printf 'SeaShard Server uninstalled. Host, server instances, and user data were preserved.\n'
