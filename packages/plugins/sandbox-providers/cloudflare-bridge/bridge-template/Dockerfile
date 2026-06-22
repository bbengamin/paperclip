FROM docker.io/cloudflare/sandbox:0.12.1

USER root

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    coreutils \
    curl \
    findutils \
    git \
    iproute2 \
    procps \
    tar \
  && . /etc/os-release \
  && curl -fsSL "https://pkgs.tailscale.com/stable/${ID}/${VERSION_CODENAME}.noarmor.gpg" \
    -o /usr/share/keyrings/tailscale-archive-keyring.gpg \
  && curl -fsSL "https://pkgs.tailscale.com/stable/${ID}/${VERSION_CODENAME}.tailscale-keyring.list" \
    -o /etc/apt/sources.list.d/tailscale.list \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tailscale \
  && rm -rf /var/lib/apt/lists/*

COPY tailscale-up.sh /usr/local/bin/tailscale-up
RUN chmod +x /usr/local/bin/tailscale-up

WORKDIR /workspace
