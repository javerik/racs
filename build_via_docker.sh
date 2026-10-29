#!/bin/bash

DOCKER_IMAGE="sharerox/racs:1-debian-builder"
BIN_DIR="bin/docker"
EXEC_NAME="racs-api"
echo "Build RACS api server via docker"

mkdir -p $BIN_DIR

docker run --rm -it -v $PWD:/app -w /app --user "$UID:$GID" --entrypoint  \
 /bin/bash $DOCKER_IMAGE -c 'cargo build --release && cp target/release/rust-cam-serve /app/bin/docker/racs-api'