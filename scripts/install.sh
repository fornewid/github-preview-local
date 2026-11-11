#!/usr/bin/env bash
# Builds gh-prv-local from source and installs it to ~/.local/bin (or $PREFIX/bin).
set -euo pipefail
cd "$(dirname "$0")/.."
PREFIX="${PREFIX:-$HOME/.local}"
command -v cargo >/dev/null || { echo "Rust is required: https://rustup.rs" >&2; exit 1; }
command -v npm >/dev/null || { echo "Node.js/npm is required" >&2; exit 1; }
npm --prefix ui ci --no-audit --no-fund
npm --prefix ui run build
cargo build --release --manifest-path src-tauri/Cargo.toml
mkdir -p "$PREFIX/bin"
install -m 0755 src-tauri/target/release/gh-prv-local "$PREFIX/bin/gh-prv-local"
echo "Installed: $PREFIX/bin/gh-prv-local"
case ":$PATH:" in *":$PREFIX/bin:"*) ;; *) echo "Add $PREFIX/bin to your PATH." ;; esac
