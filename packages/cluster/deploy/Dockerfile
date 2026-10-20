FROM oven/bun:1.4.2 AS dependencies
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile

FROM oven/bun:1.4.2
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies /app /app
RUN mkdir -p /workspace && chown bun:bun /workspace
USER bun
WORKDIR /app/packages/cluster
ENV PORT=8080
EXPOSE 8080
CMD ["bun", "src/native/main.ts"]
