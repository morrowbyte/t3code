{ pkgs ? import (builtins.getFlake "github:NixOS/nixpkgs/0954f7ee2f6bb3dc7d4e3d0d8bcb8fd4bde4cfc5").outPath { } }:

pkgs.mkShell {
  nativeBuildInputs = with pkgs; [
    pkg-config
    gnumake
    gcc
    cargo
    rustc
    chromium
  ];
  buildInputs = with pkgs; [
    libsecret
    openssl
    wayland
  ];
  shellHook = ''
    export T3CODE_TEST_CHROMIUM_EXECUTABLE_PATH="${pkgs.chromium}/bin/chromium"
    if [ -f "''${XDG_CONFIG_HOME:-$HOME/.config}/vite-plus/env" ]; then
      . "''${XDG_CONFIG_HOME:-$HOME/.config}/vite-plus/env"
    fi
  '';
}
