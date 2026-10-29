# --- Build Stage ---
# We pin to rust:1-alpine3.21 to ensure we know exactly which OS version we are using.
FROM rust:1-alpine3.21 AS builder

# Build dependencies. aravis-port is pure Rust with no C dependencies, so no meson/glib/
# gstreamer/libxml2 and no building the Aravis C library from source. What remains is unrelated to
# cameras: build-base for the vendored C in actix-web's zstd, and curl because
# utoipa-swagger-ui's build script downloads the Swagger UI bundle.
RUN apk add --no-cache build-base curl

WORKDIR /app

# Note: no PKG_CONFIG_PATH and no `-C target-feature=-crt-static`. There is no native library to
# find or dynamically link against any more, so the musl target's default static linking applies
# and produces a self-contained binary.
COPY Cargo.toml Cargo.lock ./
COPY aravis-port ./aravis-port
COPY src ./src

RUN cargo build --release

# --- Runtime Stage ---
FROM alpine:3.21

# The binary is statically linked, so no runtime shared libraries are required.
RUN apk update && apk upgrade

RUN adduser -D -s /bin/false rustcam
WORKDIR /app

COPY --from=builder /app/target/release/rust-cam-serve /app/rust-cam-serve

RUN chown rustcam:rustcam /app/rust-cam-serve

USER rustcam
EXPOSE 8742

CMD ["./rust-cam-serve"]
