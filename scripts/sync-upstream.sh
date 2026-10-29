#!/bin/sh
# Publishes a commit to the public upstreams (GitHub, Codeberg) as one squash commit.
#
# The commit's tree, minus the paths in .upstream-exclude, becomes a new commit on top
# of each upstream's branch (a fast-forward, never a force-push). Nothing changes on
# the GitLab side. Run by the manual `sync:upstream` job; also runs locally.
#
#   SYNC_MESSAGE      the squash commit message (required; on a tag `Release <tag>`)
#   SYNC_REF          commit to publish (default HEAD)
#   SYNC_BRANCH       upstream branch (default main)
#   SYNC_TAG          also push this tag at the squash commit (default $CI_COMMIT_TAG)
#   SYNC_TARGETS      space-separated target names (default "github codeberg")
#   <NAME>_REPO_URL   a target's repository URL (github/codeberg have defaults)
#   <NAME>_SYNC_TOKEN its HTTPS token; without one git uses whatever auth it has (ssh, file)
#   <NAME>_USER       the token's user name (github: x-access-token, codeberg: javerik)
#   UPSTREAM_AUTHOR_NAME/_EMAIL  author of the squash commit (default the GitLab user)
#   SYNC_LEAK_PATTERN files still matching it are listed (default git\.javerik\.dev)
#   SYNC_STRICT=1     fail instead of warning on such files
#   DRY_RUN=1         build and check everything, push nothing
set -eu

die() { echo "error: $*" >&2; exit 1; }

cd "$(git rev-parse --show-toplevel)"

ref=${SYNC_REF:-HEAD}
branch=${SYNC_BRANCH:-main}
tag=${SYNC_TAG:-${CI_COMMIT_TAG:-}}
targets=${SYNC_TARGETS:-github}
leak=${SYNC_LEAK_PATTERN:-git\\.javerik\\.dev}
dry=${DRY_RUN:-0}

message=${SYNC_MESSAGE:-}
if [ -z "$message" ] && [ -n "$tag" ]; then message="Release $tag"; fi
[ -n "$message" ] || die "set SYNC_MESSAGE (the squash commit message) in the job's variables form"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
printf '%s\n' "$message" > "$tmp/message"

# Tokens never reach argv: a credential helper scoped to the target's host reads them
# from the environment, configured through GIT_CONFIG_* so it applies to every call.
export GIT_TERMINAL_PROMPT=0
cfg=${GIT_CONFIG_COUNT:-0}
add_config() {
    export "GIT_CONFIG_KEY_$cfg=$1" "GIT_CONFIG_VALUE_$cfg=$2"
    cfg=$((cfg + 1))
    export GIT_CONFIG_COUNT=$cfg
}

# --- The tree to publish --------------------------------------------------------
git rev-parse --verify -q "$ref^{commit}" > /dev/null || die "$ref is not a commit"
git show "$ref:.upstream-exclude" > "$tmp/exclude" 2> /dev/null || die "$ref has no .upstream-exclude"
(
    export GIT_INDEX_FILE="$tmp/index"
    git read-tree "$ref"
    grep -vE '^[[:space:]]*(#|$)' "$tmp/exclude" |
        git rm -r -q -f --cached --ignore-unmatch --pathspec-from-file=- > /dev/null
    git write-tree > "$tmp/tree"
)
tree=$(cat "$tmp/tree")
echo "publishing $(git rev-parse --short "$ref") as tree $tree ($(git ls-tree -r "$tree" | wc -l) entries)"

leaks=$(git grep -lI -e "$leak" "$tree" -- 2> /dev/null | sed "s|^$tree:||" || true)
if [ -n "$leaks" ]; then
    echo "warning: published files still match /$leak/:" >&2
    echo "$leaks" | sed 's/^/  /' >&2
    [ "${SYNC_STRICT:-0}" = 1 ] && die "SYNC_STRICT=1"
fi

# Same author, committer and dates for every target, so targets whose branches agree
# get the same squash commit.
export GIT_AUTHOR_NAME="${UPSTREAM_AUTHOR_NAME:-${GITLAB_USER_NAME:-$(git config user.name)}}"
export GIT_AUTHOR_EMAIL="${UPSTREAM_AUTHOR_EMAIL:-${GITLAB_USER_EMAIL:-$(git config user.email)}}"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_AUTHOR_DATE="$(date +%s) +0000"
export GIT_COMMITTER_DATE="$GIT_AUTHOR_DATE"

# --- Submodules -----------------------------------------------------------------
git show "$ref:.gitmodules" > "$tmp/gitmodules" 2> /dev/null || : > "$tmp/gitmodules"
git ls-tree -r "$tree" | awk '$2 == "commit" { print $3, $4 }' > "$tmp/gitlinks"

# sh has no local variables, so helpers below use their own prefixes.
# Resolves a submodule URL the way git does: a relative one against the superproject's.
resolve_url() { # <submodule url> <superproject url>
    case $1 in
    ./* | ../*) ;;
    *) echo "$1"; return ;;
    esac
    ru_rel=$1 ru_base=${2%/}
    while :; do
        case $ru_rel in
        ./*) ru_rel=${ru_rel#./} ;;
        ../*) ru_rel=${ru_rel#../} ru_base=${ru_base%/*} ;;
        *) break ;;
        esac
    done
    echo "$ru_base/$ru_rel"
}

# Fails unless every gitlink's commit can be fetched from where the target will look.
check_submodules() { # <target url>
    while read -r sm_sha sm_path; do
        sm_name=$(git config -f "$tmp/gitmodules" --get-regexp '^submodule\..*\.path$' |
            awk -v p="$sm_path" '$2 == p { sub(/^submodule\./, "", $1); sub(/\.path$/, "", $1); print $1 }')
        [ -n "$sm_name" ] || die "gitlink $sm_path has no .gitmodules entry"
        sm_url=$(resolve_url "$(git config -f "$tmp/gitmodules" "submodule.$sm_name.url")" "$1")
        sm_dir="$tmp/sub-$(printf '%s' "$sm_url" | git hash-object --stdin)"
        if [ ! -d "$sm_dir" ]; then
            git clone -q --bare --filter=tree:0 "$sm_url" "$sm_dir" 2> /dev/null ||
                die "$sm_path: cannot clone $sm_url (mirror it there first)"
        fi
        git -C "$sm_dir" cat-file -e "$sm_sha^{commit}" 2> /dev/null ||
            die "$sm_path: $sm_url has no commit $sm_sha (push or mirror it first)"
        echo "  $sm_path $sm_sha ok in $sm_url"
    done < "$tmp/gitlinks"
}

# --- Per target -----------------------------------------------------------------
for target in $targets; do
    up=$(echo "$target" | tr 'a-z-' 'A-Z_')
    case $target in
    github) def_url=https://github.com/javerik/racs def_user=x-access-token ;;
    codeberg) def_url=https://codeberg.org/javerik/rustcamserve.git def_user=javerik ;;
    *) def_url= def_user=oauth2 ;;
    esac
    eval "url=\${${up}_REPO_URL:-$def_url}"
    eval "user=\${${up}_USER:-$def_user}"
    eval "token=\${${up}_SYNC_TOKEN:-}"
    [ -n "$url" ] || die "$target: set ${up}_REPO_URL"
    echo "== $target: $url"

    if [ -n "$token" ]; then
        case $url in
        https://*) ;;
        *) die "$target: ${up}_SYNC_TOKEN needs an https:// URL" ;;
        esac
        host=${url#https://}
        host="https://${host%%/*}"
        export "${up}_SYNC_TOKEN"
        add_config "credential.$host.helper" "" # drop helpers configured elsewhere
        add_config "credential.$host.helper" \
            "!f() { test \"\$1\" = get && printf 'username=%s\\npassword=%s\\n' '$user' \"\$${up}_SYNC_TOKEN\"; }; f"
    fi

    if ! heads=$(git ls-remote "$url" "refs/heads/$branch"); then
        [ "$dry" = 1 ] || die "$target: cannot reach $url"
        echo "  (unreachable, dry run assumes an empty repository)"
        heads=
    fi
    tip=$(echo "$heads" | cut -f1)

    check_submodules "$url"

    if [ -z "$tip" ]; then
        echo "  $branch does not exist yet: first commit"
        commit=$(git commit-tree "$tree" -F "$tmp/message")
    else
        git fetch -q --no-tags --depth=1 "$url" "refs/heads/$branch"
        if [ "$(git rev-parse "$tip^{tree}")" = "$tree" ]; then
            echo "  $branch already has this tree, no new commit"
            commit=$tip
        else
            git diff --stat "$tip" "$tree" | tail -n 1 | sed 's/^/ /'
            commit=$(git commit-tree "$tree" -p "$tip" -F "$tmp/message")
        fi
    fi

    set -- "$commit:refs/heads/$branch"
    [ -n "$tag" ] && set -- "$@" "$commit:refs/tags/$tag"
    if [ "$dry" = 1 ]; then
        echo "  dry run: would push $commit to $*"
    elif [ "$commit" = "$tip" ] && [ -z "$tag" ]; then
        :
    else
        git push -q --atomic "$url" "$@"
        echo "  pushed $commit"
    fi
done
