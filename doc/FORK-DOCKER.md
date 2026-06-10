# Fork Docker Runtime

This fork includes an optional nested Docker runtime so coding agents can build and run containers from inside the Paperclip container.

The image includes:

- `docker`
- `docker buildx`
- `docker compose`
- a rootless `dockerd` runtime started by `scripts/docker-agent-runtime-entrypoint.sh`

The rootless daemon stores images and containers under `/paperclip/.local/share/docker`, so the existing `/paperclip` volume preserves Docker state across container recreation.

## Compose

Use the fork override when agent runs need Docker:

```sh
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
DATABASE_URL=postgres://paperclip:paperclip@127.0.0.1:5432/paperclip \
HERMES_DATA_DIR=../data/hermes \
  docker compose \
    -f docker/docker-compose.quickstart.yml \
    -f docker/docker-compose.fork.override.yml \
    up --build
```

The override enables the privilege and namespace settings required by nested Docker and sets:

```sh
PAPERCLIP_DOCKER_RUNTIME=rootless
```

Set `PAPERCLIP_DOCKER_RUNTIME=off` to run the fork image without starting the embedded daemon.

## Docker Run

For direct `docker run`, add `--privileged`:

```sh
docker run --name paperclip \
  --privileged \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

If you deliberately want host socket passthrough instead, disable the embedded daemon:

```sh
docker run --name paperclip \
  -p 3100:3100 \
  -e PAPERCLIP_DOCKER_RUNTIME=off \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

## Verify

Inside a running container:

```sh
docker exec -it paperclip sh -lc 'docker version && docker compose version && docker run --rm hello-world'
```

Agent runs inherit:

```sh
DOCKER_HOST=unix:///run/user/<node-uid>/docker.sock
XDG_RUNTIME_DIR=/run/user/<node-uid>
```

Daemon logs are written to:

```sh
/var/log/paperclip-dockerd-rootless.log
```
