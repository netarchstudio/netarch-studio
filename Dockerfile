FROM node:22-alpine
WORKDIR /app

# Dépendances d'abord (meilleur cache de build)
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY . .
USER node
ENV PORT=3737
EXPOSE 3737
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3737/api/schema >/dev/null || exit 1
CMD ["node", "server.js"]
