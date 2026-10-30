ARG RUST_IMAGE=rust:1.90-slim-bookworm
FROM --platform=$BUILDPLATFORM ${RUST_IMAGE} AS build
ARG TARGET_ARCH=x86_64
ARG APT_MIRROR
RUN if [ -n "$APT_MIRROR" ]; then sed -i "s|http://deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; fi
RUN case "$TARGET_ARCH" in x86_64) deb=amd64; gcc=gcc-x86-64-linux-gnu; libc=libc6-dev-amd64-cross;; aarch64) deb=arm64; gcc=gcc-aarch64-linux-gnu; libc=libc6-dev-arm64-cross;; *) echo "unsupported TARGET_ARCH=$TARGET_ARCH"; exit 1;; esac \
    && dpkg --add-architecture "$deb" && apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config "$gcc" "$libc" "libxcb1-dev:$deb" "libxrandr-dev:$deb" "libdbus-1-dev:$deb" "libxkbcommon-dev:$deb" && rm -rf /var/lib/apt/lists/*
ARG CARGO_MIRROR
ENV CARGO_HOME=/usr/local/cargo PKG_CONFIG_ALLOW_CROSS=1
RUN mkdir -p /usr/local/cargo && if [ -n "$CARGO_MIRROR" ]; then printf '[source.crates-io]\nreplace-with = "mirror"\n[source.mirror]\nregistry = "sparse+%s/index/"\n' "$CARGO_MIRROR" > /usr/local/cargo/config.toml; fi
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
ARG RUSTUP_MIRROR
RUN if [ -n "$RUSTUP_MIRROR" ]; then export RUSTUP_DIST_SERVER="$RUSTUP_MIRROR"; fi \
    && target="$([ "$TARGET_ARCH" = aarch64 ] && echo aarch64-unknown-linux-gnu || echo x86_64-unknown-linux-gnu)" \
    && rustup target add "$target"
ARG CLIENT_CONFIG_HASH
ARG REMOTE_DEFAULT_ALLOW_INSECURE=false
RUN --mount=type=secret,id=client_server \
    --mount=type=secret,id=client_token \
    --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,id=rust-remote-linux-target-${TARGET_ARCH},target=/src/target,sharing=locked \
    export REMOTE_DEFAULT_SERVER="$(cat /run/secrets/client_server 2>/dev/null || true)" \
    && export REMOTE_DEFAULT_TOKEN="$(cat /run/secrets/client_token 2>/dev/null || true)" \
    && target="$([ "$TARGET_ARCH" = aarch64 ] && echo aarch64-unknown-linux-gnu || echo x86_64-unknown-linux-gnu)" \
    && linker="$([ "$TARGET_ARCH" = aarch64 ] && echo aarch64-linux-gnu-gcc || echo x86_64-linux-gnu-gcc)" \
    && export CARGO_TARGET_$(echo "$target" | tr a-z- A-Z_)_LINKER="$linker" \
    && export CC_$(echo "$target" | tr a-z- A-Z_)="$linker" \
    && export PKG_CONFIG_LIBDIR="/usr/lib/$([ "$TARGET_ARCH" = aarch64 ] && echo aarch64-linux-gnu || echo x86_64-linux-gnu)/pkgconfig:/usr/share/pkgconfig" \
    && cargo build --locked --release --target "$target" \
    && if [ "$TARGET_ARCH" = x86_64 ]; then cargo test --locked --release --target "$target"; fi \
    && mkdir -p /out && cp "target/$target/release/rust-remote-client" /out/
FROM scratch AS export
COPY --from=build /out/ /
