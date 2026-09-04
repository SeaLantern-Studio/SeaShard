class SeashardServer < Formula
  desc "Headless Minecraft Server Controller for SeaShard"
  homepage "https://github.com/SeaLantern-Studio/SeaShard"
  version "0.8.0"
  license :cannot_represent
  on_macos do
    on_intel do
      url "https://github.com/SeaLantern-Studio/SeaShard/releases/download/v0.8.0/SeaShard-Server-0.8.0-macos-x64.tar.gz"
      sha256 "63d5ae69dbcd7927b973b0b880c60d03a159214345ecce6e669537c2ce935291"
    end
    on_arm do
      url "https://github.com/SeaLantern-Studio/SeaShard/releases/download/v0.8.0/SeaShard-Server-0.8.0-macos-arm64.tar.gz"
      sha256 "468aeb80b360a9b10f2bc5e231fa92d043951bfc0b56e7536f814a073f4f406f"
    end
  end
  on_linux do
    on_intel do
      url "https://github.com/SeaLantern-Studio/SeaShard/releases/download/v0.8.0/SeaShard-Server-0.8.0-linux-x64.tar.gz"
      sha256 "7eb92e7be43d6f7bcb3084a9416047880307106b566a109a115b7e272c0d7c63"
    end
    on_arm do
      url "https://github.com/SeaLantern-Studio/SeaShard/releases/download/v0.8.0/SeaShard-Server-0.8.0-linux-arm64.tar.gz"
      sha256 "23ef0fd824acb1412b1f340e853ae246e428171218ffb1032f3c217de023a32a"
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
