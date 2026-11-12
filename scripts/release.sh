#!/usr/bin/env bash
# Prepares release vX.Y.Z on main: sets the version of the CLI (Cargo.toml, Cargo.lock) and of the
# Claude Code plugin (plugin.json, so `/plugin update` picks it up), commits that and tags it.
# Pushing the tag builds and publishes the release (.github/workflows/release.yml).
#
#   scripts/release.sh 0.2.0
set -euo pipefail
cd "$(dirname "$0")/.."
die() { echo "release: $*" >&2; exit 1; }

version="${1:-}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "usage: scripts/release.sh X.Y.Z"
tag="v$version"
[ "$(git branch --show-current)" = main ] || die "not on main"
[ -z "$(git status --porcelain)" ] || die "commit or stash your changes first"
! git rev-parse -q --verify "refs/tags/$tag" >/dev/null || die "$tag already exists"
git fetch -q origin main
git merge-base --is-ancestor origin/main HEAD || die "main is behind origin/main: pull first"

perl -0pi -e "s/^version = \"[^\"]*\"/version = \"$version\"/m" src-tauri/Cargo.toml
perl -0pi -e "s/\"version\": \"[^\"]*\"/\"version\": \"$version\"/" plugin/.claude-plugin/plugin.json
perl -0pi -e "s/(name = \"gh-prv-local\"\nversion = \")[^\"]*/\${1}$version/" src-tauri/Cargo.lock
if [ -n "$(git status --porcelain)" ]; then
  git commit -q -am "Release $tag"
fi
git tag -a "$tag" -m "gh-prv-local $tag"
echo "Tagged $tag at $(git rev-parse --short HEAD). Publish it: git push --atomic origin main $tag"
