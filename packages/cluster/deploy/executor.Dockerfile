FROM oven/bun:1.4.2
RUN apt-get update && apt-get install -y --no-install-recommends bash git coreutils findutils ripgrep ca-certificates python3 tar \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY packages/cluster/src/execution/broker.ts packages/cluster/src/execution/protocol.ts packages/cluster/src/execution/main.ts ./
RUN mkdir -p /workspace && chown bun:bun /workspace
USER bun
ENV PORT=8081 WORKSPACE_ROOT=/workspace
EXPOSE 8081
CMD ["bun", "main.ts"]
