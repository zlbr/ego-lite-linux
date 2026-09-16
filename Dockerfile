FROM node:22-bookworm-slim AS build

WORKDIR /src/package/ego-browser
COPY package/ego-browser/package.json package/ego-browser/package-lock.json ./
RUN CI=true npm ci

WORKDIR /src
COPY package/ego-browser package/ego-browser
COPY skills/ego-browser skills/ego-browser
RUN cd package/ego-browser && npm run build

FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium \
      fonts-liberation \
      fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

ENV EGO_BROWSER_LINUX_HOST=1 \
    EGO_BROWSER_CHROMIUM_PATH=/usr/bin/chromium \
    EGO_BROWSER_AGENT_WORKSPACE=/app/ego-browser

WORKDIR /app
COPY --from=build /src/package/ego-browser/dist/out/index.js /app/ego-browser.js
COPY --from=build /src/package/ego-browser/dist/out/ego-browser /app/ego-browser

RUN chown -R node:node /app
USER node

ENTRYPOINT ["node", "/app/ego-browser.js"]
