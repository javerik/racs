#!/usr/bin/env bash
# Runs the client library test suites against `examples/fake_server.rs`.
#
#   client_libs/run-tests.sh [python|dotnet|rust|all]
#
# Needs cargo, python3 (with venv) and the .NET 10 SDK. Each suite gets a fresh server on a free
# port, so the state one suite leaves behind (disconnected devices, written features) can't leak
# into the next.
#
# With RACS_TEST_REPORTS=<dir> each suite also writes a JUnit report there (racs-python.xml,
# racs-dotnet.xml, racs-rust.xml), as GitLab CI does; the Rust suite then needs cargo-nextest.
set -euo pipefail

suite="${1:-all}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(dirname "$here")"
reports="${RACS_TEST_REPORTS:+$(realpath -m "$RACS_TEST_REPORTS")}"
[[ -z "$reports" ]] || mkdir -p "$reports"
server="$repo/target/release/examples/fake_server"
log="$(mktemp)"
pid=""

stop_server() {
    if [[ -n "$pid" ]]; then
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
        pid=""
    fi
}

trap 'stop_server; rm -f "$log"' EXIT

# Starts a fake server and exports its API root as RACS_TEST_URL. Sessions time out after 5 s
# (the shortest the server allows), so every suite runs with sessions that only live through their
# heartbeats, and the expiry tests don't wait long.
start_server() {
    "$server" --session-timeout 5 >"$log" 2>&1 &
    pid=$!
    for _ in $(seq 1 100); do
        local url
        url="$(sed -n 's/^Listening at //p' "$log")"
        if [[ -n "$url" ]]; then
            export RACS_TEST_URL="$url"
            echo "fake server at $url"
            return
        fi
        if ! kill -0 "$pid" 2>/dev/null; then
            cat "$log" >&2
            echo "the fake server exited" >&2
            exit 1
        fi
        sleep 0.1
    done
    cat "$log" >&2
    echo "the fake server did not start" >&2
    exit 1
}

run_python() {
    echo "== racs-python"
    cd "$here/racs-python"
    [[ -d .venv ]] || python3 -m venv .venv
    .venv/bin/python -m pip install -q -e '.[test]'
    start_server
    .venv/bin/python -m pytest ${reports:+--junitxml="$reports/racs-python.xml"}
    stop_server
}

run_rust() {
    echo "== racs-client (Rust)"
    cd "$here/racs-rust"
    cargo build --tests
    start_server
    if [[ -n "$reports" ]]; then
        # nextest writes the JUnit report (profile `ci` in .config/nextest.toml), also when a
        # test fails, but skips doctests, so those run on their own.
        local status=0
        cargo nextest run --profile ci || status=$?
        cp target/nextest/ci/junit.xml "$reports/racs-rust.xml"
        ((status == 0)) || exit "$status"
        cargo test --doc
    else
        cargo test
    fi
    stop_server
}

run_dotnet() {
    echo "== Racs.Dotnet"
    cd "$here/racs-dotnet.Tests"
    start_server
    if [[ -n "$reports" ]]; then
        dotnet test --results-directory "$reports" --report-xunit-junit --report-xunit-junit-filename racs-dotnet.xml
    else
        dotnet test
    fi
    stop_server
}

case "$suite" in
    python | dotnet | rust | all) ;;
    *)
        echo "usage: $0 [python|dotnet|rust|all]" >&2
        exit 2
        ;;
esac

(cd "$repo" && cargo build --release --example fake_server)

case "$suite" in
    python) run_python ;;
    dotnet) run_dotnet ;;
    rust) run_rust ;;
    all)
        run_python
        run_dotnet
        run_rust
        ;;
esac
