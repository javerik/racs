#!/usr/bin/env bash
# Stamps a version typed into a CI job onto a client library, for publishing from a branch
# (.gitlab-ci.yml, publish:*-gitlab). On a tag the manifests' own version is published instead.
#
#   scripts/set-lib-version.sh <npm|python|dotnet> <version>
#
# <version> is MAJOR.MINOR.PATCH-<label>.<N>, e.g. 0.5.0-feat-laser.1. Registries refuse a
# version twice, so every publish needs a new <N> (or label).
#   npm     rewrites the built racs-webapp/dist/ng-racs-{core,ui}/package.json (ng-racs-ui then
#           peer-depends on exactly that ng-racs-core) and packs both into dist/packages-branch/.
#           Run it after `npm run build:libs`; the source manifests stay as they are.
#   python  rewrites `version` in client_libs/racs-python/pyproject.toml as PEP 440
#           (X.Y.Z-label.N -> X.Y.Z.devN: the label can't be part of a Python version).
#   dotnet  prints the version for `dotnet pack -p:Version=...` (the csproj stays as it is).
set -euo pipefail

target="${1:-}"
version="${2:-}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "$version" ]]; then
    echo "LIB_VERSION is empty: type the version (e.g. 0.5.0-feat-laser.1) into the job's variables when starting it" >&2
    exit 1
fi
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z-]+\.[0-9]+$ ]]; then
    echo "LIB_VERSION '$version' must look like MAJOR.MINOR.PATCH-<label>.<N>, e.g. 0.5.0-feat-laser.1" >&2
    exit 1
fi

case "$target" in
    npm)
        web="$repo/racs-webapp"
        for pkg in ng-racs-core ng-racs-ui; do
            [[ -f "$web/dist/$pkg/package.json" ]] || { echo "$web/dist/$pkg is missing: run 'npm run build:libs' first" >&2; exit 1; }
        done
        node -e '
            const fs = require("node:fs");
            const [web, version] = process.argv.slice(1);
            const edit = (pkg, change) => {
                const file = `${web}/dist/${pkg}/package.json`;
                const json = JSON.parse(fs.readFileSync(file, "utf8"));
                json.version = version;
                change(json);
                fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
            };
            edit("ng-racs-core", () => {});
            edit("ng-racs-ui", (json) => { json.peerDependencies["ng-racs-core"] = version; });
        ' "$web" "$version"
        rm -rf "$web/dist/packages-branch"
        mkdir -p "$web/dist/packages-branch"
        (cd "$web" && npm pack ./dist/ng-racs-core ./dist/ng-racs-ui --pack-destination dist/packages-branch)
        ;;
    python)
        py="${version%%-*}.dev${version##*.}"
        sed -i -E "0,/^version = \"[^\"]*\"/s//version = \"$py\"/" "$repo/client_libs/racs-python/pyproject.toml"
        echo "racs-python $py"
        ;;
    dotnet)
        echo "$version"
        ;;
    *)
        echo "usage: $0 <npm|python|dotnet> <version>" >&2
        exit 2
        ;;
esac
