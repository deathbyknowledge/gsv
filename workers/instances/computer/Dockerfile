FROM rust:1-bookworm AS builder
WORKDIR /build
COPY host/ ./host/
RUN cargo build --manifest-path host/Cargo.toml --locked --release --package machine --bin gsvd --no-default-features --features rustls

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git python3 python3-pip python3-venv build-essential pkg-config unzip zip xz-utils \
    file jq sqlite3 poppler-utils qpdf ghostscript imagemagick \
    && rm -rf /var/lib/apt/lists/*
# The computer is disposable: Python packages install system-wide, so a plain `pip install` works.
ENV PIP_ROOT_USER_ACTION=ignore
RUN rm -f /usr/lib/python3*/EXTERNALLY-MANAGED \
    && pip install --no-cache-dir pandas openpyxl pypdf python-docx python-pptx matplotlib reportlab
COPY --from=builder /build/host/target/release/gsvd /usr/local/bin/gsvd
RUN mkdir /workspace
WORKDIR /workspace
EXPOSE 8788
# The provider supplies a complete startup command, mapped to Docker Cmd locally.
ENTRYPOINT []
CMD ["/usr/local/bin/gsvd", "--container", "--listen", "0.0.0.0:8788", "--workspace", "/workspace"]
