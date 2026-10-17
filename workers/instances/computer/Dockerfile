FROM rust:1-bookworm AS builder
WORKDIR /build
COPY host/ ./host/
RUN cargo build --manifest-path host/Cargo.toml --locked --release --package machine --bin gsvd --no-default-features --features rustls

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git python3 python3-pip build-essential pkg-config unzip \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/host/target/release/gsvd /usr/local/bin/gsvd
RUN mkdir /workspace
WORKDIR /workspace
EXPOSE 8788
# The provider supplies a complete startup command, mapped to Docker Cmd locally.
ENTRYPOINT []
CMD ["/usr/local/bin/gsvd", "--container", "--listen", "0.0.0.0:8788", "--workspace", "/workspace"]
