FROM node:22-slim
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Public hosting defaults. The SQLite file lives on a mounted volume at /data (see DEPLOY.md).
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DB_FILE=/data/songexplain.db \
    TRUST_PROXY=1 \
    COOKIE_SECURE=1

EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
