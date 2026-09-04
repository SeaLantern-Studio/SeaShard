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
  ["macos", "linux"].flatMap((platform) =>
    ["x64", "arm64"].map(async (architecture) => {
      const name = `SeaShard-Server-${version}-${platform}-${architecture}.tar.gz`;
      const bytes = await readFile(join(assetsRoot, name));
      return {
        platform,
        architecture,
        url: `https://github.com/${repository}/releases/download/v${version}/${name}`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  ),
);
const target = (platform, architecture) =>
  targets.find(
    (candidate) => candidate.platform === platform && candidate.architecture === architecture,
  );
const macIntel = target("macos", "x64");
const macArm = target("macos", "arm64");
const linuxIntel = target("linux", "x64");
const linuxArm = target("linux", "arm64");
if (!macIntel || !macArm || !linuxIntel || !linuxArm) {
  throw new Error("Homebrew Formula 缺少 macOS 或 Linux 架构产物");
}

const formula = `class SeashardServer < Formula
  desc "Headless Minecraft Server Controller for SeaShard"
  homepage "https://github.com/${repository}"
  version "${version}"
  license :cannot_represent
  on_macos do
    on_intel do
      url "${macIntel.url}"
      sha256 "${macIntel.sha256}"
    end
    on_arm do
      url "${macArm.url}"
      sha256 "${macArm.sha256}"
    end
  end
  on_linux do
    on_intel do
      url "${linuxIntel.url}"
      sha256 "${linuxIntel.sha256}"
    end
    on_arm do
      url "${linuxArm.url}"
      sha256 "${linuxArm.sha256}"
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
