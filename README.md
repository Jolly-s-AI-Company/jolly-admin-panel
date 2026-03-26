# Jolly AI 管理面板

## 项目简述
Jolly AI管理面板 - 包含登录认证、需求发布、WebSocket、角色状态监控功能。

## 技术栈
- Node.js 22
- Express.js
- WebSocket (ws)
- JSON文件持久化

## 功能列表
- 用户登录认证（Token机制）
- 需求发布与WebSocket发送
- 角色状态监控
- 角色可扩充

## 部署方式

### 本地运行
```bash
npm install
npm start
```
访问: http://localhost:30000

### Docker部署
```bash
# 构建ARM64镜像
docker build -t jolly-admin-panel:latest .

# 运行容器
docker run -d -p 30000:30000 -p 18789:18789 -v jolly-data:/app/data jolly-admin-panel:latest
```

## 端口
- HTTP: 30000
- WebSocket: 18789

## 默认账号
- 用户名: admin
- 密码: admin123
