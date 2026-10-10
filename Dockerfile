# Node runs the TypeScript sources directly (type stripping), so there is no build stage.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production DB_PATH=/data/gateway.db PORT=8787

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY config ./config
COPY scripts ./scripts

# SQLite lives on a volume so keys, budgets and the ledger survive restarts.
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:8787/readyz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "src/server.ts"]
