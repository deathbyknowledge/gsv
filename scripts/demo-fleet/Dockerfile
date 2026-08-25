FROM rust:1-bookworm AS builder

WORKDIR /build
COPY cli/Cargo.toml cli/Cargo.lock cli/build.rs cli/clippy.toml ./
COPY cli/src ./src
COPY cli/tests ./tests
RUN cargo build --release --no-default-features --features rustls

FROM debian:bookworm-slim

ARG GSV_SOURCE_REV=unknown
LABEL org.opencontainers.image.revision="${GSV_SOURCE_REV}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    coreutils \
    findutils \
    grep \
    jq \
    procps \
    sed \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/gsv /usr/local/bin/gsv
COPY entrypoint.sh /usr/local/bin/gsv-demo-device-entrypoint

RUN chmod +x /usr/local/bin/gsv /usr/local/bin/gsv-demo-device-entrypoint

WORKDIR /fleet
ENTRYPOINT ["/usr/local/bin/gsv-demo-device-entrypoint"]
