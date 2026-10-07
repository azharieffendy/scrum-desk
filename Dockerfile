# Daily Scrum — single container: UI + auth + API + SQLite database
FROM node:22-slim

WORKDIR /app

# Dependencies first (cached layer). better-sqlite3 ships a prebuilt
# binary for this platform, so no compiler is needed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib
COPY api ./api
COPY public ./public

ENV PORT=3000
ENV DATA_DIR=/app/data
EXPOSE 3000

# Run as the unprivileged "node" user (uid 1000). A bind-mounted ./data
# folder must be writable by uid 1000 — see README "Upgrading".
RUN mkdir -p /app/data && chown node:node /app/data
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/auth/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
