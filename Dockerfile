# Jolly AI 管理面板 - ARM64 Docker镜像
FROM node:22-alpine AS builder

# 安装构建依赖
RUN apk add --no-cache python3 make g++

WORKDIR /app

# 复制package.json
COPY package.json package-lock.json* ./

# 安装依赖
RUN npm ci --omit=dev

# 生产阶段
FROM node:22-alpine

# 安装SQLite运行时依赖
RUN apk add --no-cache sqlite

WORKDIR /app

# 复制node_modules和源代码
COPY --from=builder /app/node_modules ./node_modules
COPY . .

# 创建数据目录
RUN mkdir -p /app/data

# 暴露端口
EXPOSE 30000 18789

# 启动命令
CMD ["node", "server.js"]
