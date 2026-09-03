import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const version = requireArgument("--version");
const repository = readArgument("--repository") ?? "SeaLantern-Studio/SeaShard";
const assetsRoot = resolve(requireArgument("--assets"));
const output = resolve(requireArgument("--output"));
if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error(`无效 Homebrew 版本：${version}`);
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
  throw new Error(`无效 GitHub 仓库：${repository}`);
}

const targets = await Promise.all(
  ["x64", "arm64"].map(async (architecture) => {
    const name = `SeaShard-Server-${version}-linux-${architecture}.tar.gz`;
    const bytes = await readFile(join(assetsRoot, name));
    return {
      architecture,
      url: `https://github.com/${repository}/releases/download/v${version}/${name}`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }),
);
const intel = targets.find(({ architecture }) => architecture === "x64");
const arm = targets.find(({ architecture }) => architecture === "arm64");
if (!intel || !arm) throw new Error("Homebrew Formula 缺少 Linux 架构产物");

const formula = `class SeashardServer < Formula
  desc "Headless Minecraft Server Controller for SeaShard"
  homepage "https://github.com/${repository}"
  version "${version}"
  license :cannot_represent
  on_linux do
    on_intel do
      url "${intel.url}"
      sha256 "${intel.sha256}"
    end
    on_arm do
      url "${arm.url}"
      sha256 "${arm.sha256}"
    end
  end

  def install
    libexec.install Dir["*"]
    bin.install_symlink libexec/"seashard-server"
  end

  service do
    run [opt_bin/"seashard-server", "run"]
    keep_alive true
    working_dir opt_libexec
    log_path var/"log/seashard-server.log"
    error_log_path var/"log/seashard-server-error.log"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/seashard-server --version")
  end
end
`;
await writeFile(output, formula, "utf8");
console.log(`SEASHARD_HOMEBREW_FORMULA_READY output=${output}`);

function readArgument(name) {
  const prefix = `${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  const value = argument?.slice(prefix.length).trim();
  return value || undefined;
}

function requireArgument(name) {
  const value = readArgument(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}
