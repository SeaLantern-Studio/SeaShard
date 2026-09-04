class SeashardServer < Formula
  desc "Headless Minecraft Server Controller for SeaShard"
  homepage "https://github.com/SeaLantern-Studio/SeaShard"
  version "0.8.2"
  license :cannot_represent
  on_macos do
    on_intel do
      url "https://github.com/SeaLantern-Studio/SeaShard/releases/download/v0.8.2/SeaShard-Server-0.8.2-macos-x64.tar.gz"
      sha256 "49bc066c37e3d0990ff92afa1387e3f4e2f304c3394bcb0734dc232529579045"
    end
    on_arm do
      url "https://github.com/SeaLantern-Studio/SeaShard/releases/download/v0.8.2/SeaShard-Server-0.8.2-macos-arm64.tar.gz"
      sha256 "68c712409cd600d8d926a208cd30d06f0f7b66b0f53e3372855d436ac871a0e6"
    end
  end
  on_linux do
    on_intel do
      url "https://github.com/SeaLantern-Studio/SeaShard/releases/download/v0.8.2/SeaShard-Server-0.8.2-linux-x64.tar.gz"
      sha256 "94472753e29d614afdc92d529e8f37db4394e266338561574bfcdac98c50c915"
    end
    on_arm do
      url "https://github.com/SeaLantern-Studio/SeaShard/releases/download/v0.8.2/SeaShard-Server-0.8.2-linux-arm64.tar.gz"
      sha256 "df360664c945461a685ea876f8e03e121c8c83b61ba45c37973f109cebcc7c40"
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
