# eisenpaper — `just` serves the sheet

# serve at http://localhost:8741 (default)
serve: build
    ./target/release/eisenpaper

# serve reachable from the phone / LAN
lan: build
    ./target/release/eisenpaper --host 0.0.0.0

build:
    cargo build --release

# install as an always-on systemd user service
install-service: build
    cp eisenpaper.service ~/.config/systemd/user/
    systemctl --user daemon-reload
    systemctl --user enable --now eisenpaper
