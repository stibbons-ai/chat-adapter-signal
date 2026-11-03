# Build context: the repository root (see compose.yaml).

# The adapter, packed from this checkout. Your own app installs it from npm instead.
FROM node:24-slim AS adapter
WORKDIR /src
COPY package.json package-lock.json tsconfig.json tsconfig.build.json README.md LICENSE ./
COPY src src
RUN npm ci --no-audit --no-fund && npm pack && mv stibbons-chat-adapter-signal-*.tgz /adapter.tgz

FROM node:24-slim
WORKDIR /app
COPY examples/echo-bot/package.json ./
COPY --from=adapter /adapter.tgz ./
RUN npm install --omit=dev --no-audit --no-fund
COPY examples/echo-bot/bot.ts ./
USER node
CMD ["node", "bot.ts"]
