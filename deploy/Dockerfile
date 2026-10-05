FROM node:20-bookworm-slim

ARG APP_UID=10001
ARG APP_GID=10001
RUN groupadd --gid ${APP_GID} proxy-dispatcher \
  && useradd --uid ${APP_UID} --gid ${APP_GID} --create-home --home-dir /home/proxy-dispatcher --shell /usr/sbin/nologin proxy-dispatcher

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=proxy-dispatcher:proxy-dispatcher server.mjs server-auth.mjs shared-bridge.mjs event-log.mjs settings-store.mjs store.mjs proxy-probe.mjs ./
COPY --chown=proxy-dispatcher:proxy-dispatcher public ./public
COPY --chown=proxy-dispatcher:proxy-dispatcher vendor/mihomo/mihomo ./vendor/mihomo/mihomo
RUN chmod 755 /app/vendor/mihomo/mihomo

USER proxy-dispatcher
ENV NODE_ENV=production SERVER_MODE=1 HOST=127.0.0.1 PORT=4173 MIHOMO_PATH=/app/vendor/mihomo/mihomo
EXPOSE 4173 21000-21250
VOLUME ["/var/lib/proxy-dispatcher/data"]
CMD ["node", "server.mjs"]
