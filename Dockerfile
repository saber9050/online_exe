FROM node:24-alpine

# alpine 默认没有时区文件
RUN apk add --no-cache tzdata

WORKDIR /app

# 先拷依赖清单，利用层缓存：只改业务代码时不会重装依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=8080 \
    DATA_DIR=/data \
    MAX_UPLOAD_MB=800

RUN mkdir -p /data && chown -R node:node /data
USER node

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
