{ pkgs ? import (builtins.getFlake "github:NixOS/nixpkgs/0954f7ee2f6bb3dc7d4e3d0d8bcb8fd4bde4cfc5").outPath { } }:

pkgs.mkShell {
  nativeBuildInputs = with pkgs; [
    pkg-config
    gnumake
    gcc
    cargo
    rustc
  ];
  buildInputs = with pkgs; [
    libsecret
    openssl
    wayland
  ];
  shellHook = ''
    if [ -f "''${XDG_CONFIG_HOME:-$HOME/.config}/vite-plus/env" ]; then
      . "''${XDG_CONFIG_HOME:-$HOME/.config}/vite-plus/env"
    fi
  '';
}
