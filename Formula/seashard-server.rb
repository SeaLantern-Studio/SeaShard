class SeashardServer < Formula
  desc "Headless Minecraft Server Controller for SeaShard"
  homepage "https://github.com/SeaLantern-Studio/SeaShard"
  version "0.8.1"
  license :cannot_represent
  on_macos do
    on_intel do
      url "https://github.com/SeaLantern-Studio/SeaShard/releases/download/v0.8.1/SeaShard-Server-0.8.1-macos-x64.tar.gz"
      sha256 "d5af18c3bfaa6da44f94754e4e51865b9503aff4b4a91bacb96aa8b381b00f24"
    end
    on_arm do
      url "https://github.com/SeaLantern-Studio/SeaShard/releases/download/v0.8.1/SeaShard-Server-0.8.1-macos-arm64.tar.gz"
      sha256 "d526b8d5a241e8dc9b7709e6fe8ee9f8fbb5993f80ae63ad39f2f0cabe47de4a"
    end
  end
  on_linux do
    on_intel do
      url "https://github.com/SeaLantern-Studio/SeaShard/releases/download/v0.8.1/SeaShard-Server-0.8.1-linux-x64.tar.gz"
      sha256 "0a90d12bc30bd076c9542f8521395fb496f8c4ad750d2444831b2d44fb7084ff"
    end
    on_arm do
      url "https://github.com/SeaLantern-Studio/SeaShard/releases/download/v0.8.1/SeaShard-Server-0.8.1-linux-arm64.tar.gz"
      sha256 "a158bb25f4f65fe3a06fa7b1e024cff2463e78546c687ebaf54073f0e95a6a43"
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
