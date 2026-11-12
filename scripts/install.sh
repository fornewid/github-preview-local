#!/usr/bin/env bash
# Installs gh-prv-local to ~/.local/bin (or $PREFIX/bin). Run it again to update.
#
#   install.sh            the latest release's binary for this machine, checked against its SHA-256
#   install.sh v0.2.0     that release
#   install.sh --source   builds this checkout instead (Rust and Node.js 20+)
set -euo pipefail
REPO=fornewid/github-preview-local
PREFIX="${PREFIX:-$HOME/.local}"
dest="$PREFIX/bin/gh-prv-local"

put() {
  mkdir -p "$PREFIX/bin"
  install -m 0755 "$1" "$dest"
  if version=$("$dest" --version 2>/dev/null); then
    echo "Installed: $dest ($version)"
  else
    echo "Installed $dest, but it does not start. On Linux it needs the WebKitGTK runtime (libwebkit2gtk-4.1)." >&2
  fi
  case ":$PATH:" in *":$PREFIX/bin:"*) ;; *) echo "Add $PREFIX/bin to your PATH." ;; esac
}

if [ "${1:-}" = --source ]; then
  cd "$(dirname "$0")/.."
  [ -f src-tauri/Cargo.toml ] || { echo "--source builds a clone of https://github.com/$REPO: run it from there" >&2; exit 1; }
  command -v cargo >/dev/null || { echo "Rust is required: https://rustup.rs" >&2; exit 1; }
  command -v npm >/dev/null || { echo "Node.js/npm is required" >&2; exit 1; }
  npm --prefix ui ci --no-audit --no-fund
  npm --prefix ui run build
  cargo build --release --locked --manifest-path src-tauri/Cargo.toml
  put src-tauri/target/release/gh-prv-local
  exit
fi

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "No installer for $(uname -s): download a binary from https://github.com/$REPO/releases" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "No release binary for $(uname -m): build from source (install.sh --source)" >&2; exit 1 ;;
esac
asset="gh-prv-local-$os-$arch"
tag="${1:-}"
[ -z "$tag" ] || [ "${tag#v}" != "$tag" ] || tag="v$tag"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# gh (when signed in) also reaches a private repository; plain curl otherwise.
if command -v gh >/dev/null && gh auth token --hostname github.com >/dev/null 2>&1 &&
  gh release download ${tag:+"$tag"} --repo "github.com/$REPO" --pattern "$asset" --pattern "$asset.sha256" --dir "$tmp"; then
  :
else
  if [ -n "$tag" ]; then base="https://github.com/$REPO/releases/download/$tag"; else base="https://github.com/$REPO/releases/latest/download"; fi
  curl -fsSL -o "$tmp/$asset" "$base/$asset"
  curl -fsSL -o "$tmp/$asset.sha256" "$base/$asset.sha256"
fi

expected=$(cut -d' ' -f1 "$tmp/$asset.sha256")
if command -v sha256sum >/dev/null; then
  actual=$(sha256sum "$tmp/$asset" | cut -d' ' -f1)
else
  actual=$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)
fi
[ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "Checksum mismatch for $asset" >&2; exit 1; }
put "$tmp/$asset"
