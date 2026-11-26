# SummerTime: game + admin page + multiplayer WebSocket server in one image.
#   docker build -t summertime .
#   docker run -p 8787:8787 -e FIREBASE_PROJECT_ID=<id> summertime   → http://localhost:8787
#   (FIREBASE_PROJECT_ID enables Google-verified display names; omit it to keep everyone a guest.)
# The Firebase web config is read from .env at build time (public client
# identifiers, see .env.example); pass a different .env to target another project.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY server/package.json ./server/
RUN cd server && npm install --omit=dev --no-audit --no-fund
COPY server ./server
# Shop catalog, shared with the game build.
COPY shared ./shared
COPY --from=build /app/dist ./dist
# Flower wallets (daily rewards): mount a volume here so they survive new containers.
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data
USER node
EXPOSE 8787
CMD ["node", "server/index.mjs"]
