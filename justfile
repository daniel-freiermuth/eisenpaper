# eisenpaper — run `just` to build and serve the sheet, `just --list` for all recipes

set shell := ["bash", "-euo", "pipefail", "-c"]

bin := "target/release/eisenpaper"

# build everything and serve at http://localhost:8741
default: serve

# build everything and serve at http://localhost:8741
serve: build
    {{ bin }}

# build everything and serve reachable from the phone / LAN
lan: build
    {{ bin }} --host 0.0.0.0

# hot-reload UI on :5173, backend on :8742 against dev-tasks.json (never the real sheet)
dev: deps
    #!/usr/bin/env bash
    set -euo pipefail
    trap 'kill 0' EXIT
    cargo run --quiet -- --port 8742 --data dev-tasks.json &
    pnpm -C web dev

# build web app and server
build: build-web build-server

# build the web app into web/dist
build-web: deps
    pnpm -C web build

# build the release server binary
build-server:
    cargo build --release --locked

# install web dependencies exactly as locked
deps:
    pnpm -C web install --frozen-lockfile

# every check CI runs
check: check-rust check-advisories check-web

# rustfmt, clippy (pedantic+), tests, cargo-deny (bans, licenses, sources)
check-rust:
    cargo fmt --check
    cargo clippy --all-targets --locked -- -D warnings
    cargo test --locked
    cargo deny check bans licenses sources

# RustSec advisories; the DB changes daily, so CI runs this on its own schedule
check-advisories:
    cargo deny check advisories

# prettier, eslint (strict type-checked), svelte-check, vitest, build
check-web: deps
    pnpm -C web format:check
    pnpm -C web lint
    pnpm -C web check
    pnpm -C web test
    pnpm -C web build

# format all code
fmt: deps
    cargo fmt
    pnpm -C web format

# apply automatic lint fixes, then format
fix: deps
    cargo clippy --fix --allow-dirty --allow-staged --all-targets --locked
    pnpm -C web exec eslint . --fix
    just fmt

# install as an always-on systemd user service for this checkout
install-service: build
    mkdir -p ~/.config/systemd/user
    sed 's|@PROJECT_DIR@|{{ justfile_directory() }}|' eisenpaper.service > ~/.config/systemd/user/eisenpaper.service
    systemctl --user daemon-reload
    systemctl --user enable --now eisenpaper
    systemctl --user restart eisenpaper

# remove build outputs
clean:
    cargo clean
    rm -rf web/dist
