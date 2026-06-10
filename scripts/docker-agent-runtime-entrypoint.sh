#!/bin/sh

start_rootless_docker() {
    if ! command -v dockerd-rootless.sh >/dev/null 2>&1; then
        echo "PAPERCLIP_DOCKER_RUNTIME=rootless but dockerd-rootless.sh is not installed; skipping Docker startup" >&2
        return 0
    fi

    if ! grep -q '^node:' /etc/subuid 2>/dev/null; then
        echo "node:100000:65536" >>/etc/subuid
    fi
    if ! grep -q '^node:' /etc/subgid 2>/dev/null; then
        echo "node:100000:65536" >>/etc/subgid
    fi

    docker_run_dir="/run/user/${PUID:-1000}"
    install -d -m 700 -o "${PUID:-1000}" -g "${PGID:-1000}" "$docker_run_dir"
    install -d -m 700 -o "${PUID:-1000}" -g "${PGID:-1000}" /paperclip/.local/share/docker

    export XDG_RUNTIME_DIR="$docker_run_dir"
    export DOCKER_HOST="unix://${docker_run_dir}/docker.sock"

    if [ -S "${docker_run_dir}/docker.sock" ] && docker version >/dev/null 2>&1; then
        echo "Rootless Docker daemon already available at ${docker_run_dir}/docker.sock" >&2
        return 0
    fi

    echo "Starting rootless Docker daemon for Paperclip at ${docker_run_dir}/docker.sock" >&2
    gosu node env \
        HOME=/paperclip \
        XDG_RUNTIME_DIR="$docker_run_dir" \
        DOCKER_HOST="$DOCKER_HOST" \
        PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
        dockerd-rootless.sh >/var/log/paperclip-dockerd-rootless.log 2>&1 &
}

case "${PAPERCLIP_DOCKER_RUNTIME:-rootless}" in
    rootless)
        start_rootless_docker
        ;;
    off|none|disabled)
        ;;
    *)
        echo "Unknown PAPERCLIP_DOCKER_RUNTIME='${PAPERCLIP_DOCKER_RUNTIME}'. Use 'rootless' or 'off'." >&2
        return 1
        ;;
esac
