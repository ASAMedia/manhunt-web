FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# npm, yarn und corepack werden zur Laufzeit nicht gebraucht – raus damit (kleiner, weniger Angriffsfläche)
RUN npm ci --omit=dev && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
     /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* /root/.npm

COPY server.js ./
COPY src ./src
COPY public ./public

# Wird vom CI-Build gesetzt (Commit + Datum) und im Admin-Bereich angezeigt
ARG APP_BUILD=""
ENV APP_BUILD=$APP_BUILD

RUN mkdir -p /data && chown node:node /data
USER node

ENV PORT=3000 DATA_DIR=/data
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
