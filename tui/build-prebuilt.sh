#!/usr/bin/env bash
# Rebuild the committed prebuilt dashboard binaries in tui/prebuilt/.
# Run this on a macOS host after changing tui/src.
#
#   macOS universal : needs the two apple targets + `lipo` (ships with Xcode CLT)
#   Linux x64/arm64 : cross-compiled with zig — `brew install zig` and
#                     `cargo install cargo-zigbuild` (skipped if missing)
#
# Note: the Linux binaries are glibc-dynamic (not musl) — for Alpine/musl, build
# from source in the container instead.
set -euo pipefail
cd "$(dirname "$0")"
[ -f "${HOME}/.cargo/env" ] && . "${HOME}/.cargo/env"
mkdir -p prebuilt

echo "==> macOS universal (arm64 + x86_64)"
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
cargo build --release --target aarch64-apple-darwin
cargo build --release --target x86_64-apple-darwin
lipo -create -output prebuilt/e2b-dash-darwin-universal \
  target/aarch64-apple-darwin/release/e2b-dash \
  target/x86_64-apple-darwin/release/e2b-dash

if command -v cargo-zigbuild >/dev/null 2>&1 && command -v zig >/dev/null 2>&1; then
  echo "==> Linux x64 + arm64 (zigbuild)"
  rustup target add x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu >/dev/null
  cargo zigbuild --release --target x86_64-unknown-linux-gnu
  cargo zigbuild --release --target aarch64-unknown-linux-gnu
  cp target/x86_64-unknown-linux-gnu/release/e2b-dash  prebuilt/e2b-dash-linux-x64
  cp target/aarch64-unknown-linux-gnu/release/e2b-dash prebuilt/e2b-dash-linux-arm64
else
  echo "==> skipping Linux (need: brew install zig && cargo install cargo-zigbuild)"
fi

chmod +x prebuilt/*
echo "==> done:"
for f in prebuilt/*; do printf '   %-30s %s\n' "$(basename "$f")" "$(du -h "$f" | cut -f1)"; done
