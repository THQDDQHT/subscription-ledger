# 构建阶段：安装依赖并产出 Next standalone
FROM node:24-alpine AS build
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable && apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# 运行阶段：非 root、只读根文件系统（compose 侧配置），数据卷挂 /data
FROM node:24-alpine
ENV NODE_ENV=production LEDGER_DATA_DIR=/data PORT=8000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN adduser --uid 10001 --disabled-password ledger && mkdir /data && chown ledger:ledger /data
COPY --from=build --chown=ledger:ledger /app/.next/standalone ./
COPY --from=build --chown=ledger:ledger /app/.next/static ./.next/static
USER ledger
EXPOSE 8000
CMD ["node", "server.js"]
