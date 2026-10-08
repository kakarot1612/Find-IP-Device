FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3030

RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu iputils-ping \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chmod=755 docker-entrypoint.sh ./docker-entrypoint.sh

EXPOSE 3030

ENTRYPOINT ["/app/docker-entrypoint.sh"]