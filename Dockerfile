# ── 镜像源（已按国内网络预先配好，构建机不用再改 daemon.json）─────────────
# 基础镜像默认走 Docker Hub 的国内代理站；想换回官方或自有加速地址时用 --build-arg 覆盖：
#   官方：  --build-arg NODE_IMAGE=node:24-alpine
#   自有：  --build-arg NODE_IMAGE=<你的加速地址>/library/node:24-alpine
ARG NODE_IMAGE=docker.m.daocloud.io/library/node:24-alpine
FROM ${NODE_IMAGE}

# Alpine 官方 CDN 在国内经常只有几十 KB/s，先换阿里云源再装包。
# tzdata：alpine 默认没有时区文件，不装的话 TZ=Asia/Shanghai 不生效，页面时间会差 8 小时。
# su-exec：入口脚本用来从 root 降回 node，比 gosu 小一个数量级（alpine 官方源里就有）。
RUN sed -i 's#dl-cdn.alpinelinux.org#mirrors.aliyun.com#g' /etc/apk/repositories \
 && apk add --no-cache tzdata su-exec

WORKDIR /app

# npm 也走国内源（company 有私有 registry 时用 --build-arg NPM_REGISTRY=... 覆盖）。
# 放在 COPY 之前，改依赖清单才会重装，只改业务代码仍命中缓存。
ARG NPM_REGISTRY=https://registry.npmmirror.com
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --registry=${NPM_REGISTRY}

COPY . .

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=8080 \
    DATA_DIR=/data \
    MAX_UPLOAD_MB=800

# 数据目录在镜像里先建好并属于 node；真正挂载进来时属主由宿主机决定，
# 由 docker-entrypoint.sh 在启动时兜底修正（见脚本头部注释）。
RUN mkdir -p /data && chown -R node:node /data

# 入口脚本负责：修正 /data 属主 → 用 uid 1000 降权执行 CMD。
# 所以这里**不写 USER node**——必须以 root 进入才能 chown，
# 但业务进程仍然不是 root（su-exec 执行），权限模型没放松。
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
