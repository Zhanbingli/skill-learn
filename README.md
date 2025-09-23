# Skill Sprint Coach

一个围绕 16 周临床数据科学路线打造的学习督促平台。前端提供每日/每周驾驶舱，后端以 Node.js + JSON 持久化存储学习进度与日志，既能快速本地运行，又方便后续扩展为多端项目。

## 功能亮点

- **路线自动匹配**：设定起始日后自动定位当前阶段、周次与主题。
- **每日仪式面板**：70′ 深工、20′ 可见产出、20′ 英文 micro post、10′ 复盘，勾选即保存。
- **任务看板**：展示周里程碑与任务，支持完成/延后，实时计算进度条与提醒。
- **学习日志**：记录每日亮点，后端持久化，随时导出 JSON 备份。
- **全局状态栏**：保存、报错、加载状态即时反馈。
- **Backlog 透视**：完整 4 阶段概览，随时核查剩余任务。
- **进度洞察仪表盘**：累计完成折线、仪式完成度条形图、日志/仪式连续天数一目了然。
- **作品集同步**：连接 GitHub，自动拉取最新仓库与技术栈摘要，随时补充个人作品集。

## 快速启动

1. 安装依赖（需要 Node.js ≥ 18）：
   ```bash
   npm install
   ```
2. 启动开发服务：
   ```bash
   # 热重载（需全局 or 本地 nodemon）
   npm run dev

   # 或直接启动
   npm start
   ```
3. 打开浏览器访问 `http://localhost:3000`，设置路线起始日即可开始使用。

> 所有进度、日志会被保存到 `server/state.json`；删除该文件即可重置数据。

## API 速览

- `GET /api/roadmap`：返回 16 周路线配置。
- `GET /api/state`：读取当前 startDate、progress、ritual、logs。
- `POST /api/state`：提交部分更新，后端会合并并返回最新状态。
- `GET /api/insights`：结合路线与本地存档生成完成率、趋势、连续天数等统计。
- `GET /api/portfolio`：读取最近一次作品集同步结果。
- `POST /api/portfolio/sync`：触发作品集同步，默认支持 GitHub。

请求体验证字段格式，防止非法状态写入。可据此对接其他前端（CLI、小程序、Telegram Bot 等）。

### 作品集同步（GitHub）

前端页面右下角新增 **Portfolio** 面板，输入 GitHub 用户名即可一键同步，展示仓库卡片、语言占比与星数统计。后台同样暴露 JSON API：

```json
POST /api/portfolio/sync
{
  "provider": "github",
  "username": "your-name",
  "limit": 12,
  "token": "ghp_..."
}
```

> `token` 字段为可选，用于突破匿名速率或访问私有仓库。同步接口依赖 Node.js 18+ 自带的 `fetch`，无需额外安装依赖。若所在环境无法访问 GitHub，可自行注入 mock 数据后调用 `POST /api/state` 写入 `portfolio` 字段。

## 项目结构

```
.
|-- README.md
|-- package.json
|-- skill-root.md        # 原始路线需求
|-- public               # 前端页面
|   |-- index.html
|   |-- styles.css
|   |-- app.js
|   `-- data
|       `-- roadmap.json # 16 周路线数据
`-- server
    |-- index.js         # Express 服务 + API
    |-- store.js         # JSON 状态存储封装
    `-- state.json       # 运行时生成的用户数据（首次启动会自动创建）
```

## 可拓展方向

- **多用户 / 鉴权**：引入 SQLite/PostgreSQL + JWT，让不同账号维护独立进度。
- **提醒系统**：结合 cron/Celery 或外部服务触发邮件、Telegram、短信 nudges。
- **作品集同步**：调用 GitHub/GitLab API 自动读取 commit、PR、Issues，生成周报。
- **PWA / 桌面端**：加 Service Worker、IndexedDB 缓存，实现离线使用与桌面通知。
- **数据可视化**：依据 `server/state.json` 的历史记录绘制 streak、完成率、投入时间。

欢迎继续把它产品化，例如迁移到 VPS、加上 FastAPI/GraphQL、或接入真实临床数据项目的任务模板。
------

**我打算认真学习一下数据科学技能。所以新建了一个项目，用于记录和督促我进步。**

1、这是开始，感谢codex和ChatGPT帮助我制定计划和指导我开始。
2、随着做事和研究的深入，越发觉得能降低个人的启动摩擦成本这件事太重要了，所以便有了这个项目，希望我后续可以不那么懒，让这个项目继续优化下去。
