# Bonnie FX Capture

基于 Cloudflare 的中国银行外汇牌价截图网站版。

当前实现不再依赖本地 Electron 安装包，而是改为：

- 前端网页：静态页面，负责日期导入、币种选择、任务轮询、验证码输入、ZIP 下载
- 后端 Worker：提供任务 API
- Durable Objects：负责单任务状态机和单用户互斥
- Browser Rendering：负责打开中行查询页、等待验证码、提交查询、截图
- Durable Object 存储：保存 PNG 和最终 ZIP

验证码仍然保留人工输入，不做自动破解。

## 当前能力

- 导入 `.txt` / `.csv` 日期文件
- 用日期选择器手动添加日期
- 日期勾选、全选、反选
- 动态读取中国银行页面币种列表
- 单用户同一时间只允许一个活动任务
- 网页内显示验证码并继续任务
- 每个日期输出一张 `币种-日期-价格.png`
- 任务完成后提供 ZIP 下载
- 结果默认保留 10 分钟

## 目录结构

```txt
cloudflare/
  worker.js           API 路由与 scheduled cleanup
  job-state-do.js     任务状态机 Durable Object
  user-gate-do.js     单用户活动任务互斥 Durable Object
  automation.js       Browser Rendering 自动化逻辑
  shared.js           共享工具函数
public/
  index.html          网站页面
  app.js              前端交互与轮询逻辑
  styles.css          网站样式
wrangler.toml         Cloudflare 绑定与部署配置
```

旧的 Electron 代码仍保留在 `src/`，当前作为参考实现，没有接入新的部署链路。

## 环境要求

部署前需要准备这些 Cloudflare 资源：

- 1 个 Browser Rendering 绑定
- 2 个 Durable Object 类
- Cloudflare Access 保护站点访问

`wrangler.toml` 当前使用的绑定名：

- `MYBROWSER`
- `JOB_STATE`
- `USER_GATE`

## 本地开发

安装依赖：

```bash
npm install
```

远端开发模式：

```bash
npm run dev
```

当前配置使用 `wrangler dev` + remote browser binding。Durable Objects 和静态资源本地运行，Browser Rendering 仍通过 Cloudflare 远端能力执行。

## 部署

部署命令：

```bash
npm run deploy
```

预检查：

```bash
npm run check
```

`check` 实际执行 `wrangler deploy --dry-run`。如果本机没有权限写入 Wrangler 默认日志目录，可能会看到本地日志写入报错，但只要后续出现绑定清单和 `--dry-run: exiting now.`，说明配置检查本身已经通过。

## Access 身份

Worker 优先读取 Cloudflare Access 注入的邮箱头：

- `cf-access-authenticated-user-email`
- `cf-access-verified-email`

本地开发时如果没有 Access 头，会退回到 `DEV_USER_EMAIL`。

## API

当前提供这些接口：

- `GET /api/session`
- `GET /api/currencies`
- `POST /api/jobs`
- `GET /api/jobs/:id`
- `GET /api/jobs/:id/captcha`
- `POST /api/jobs/:id/captcha`
- `POST /api/jobs/:id/captcha/refresh`
- `POST /api/jobs/:id/cancel`
- `GET /api/jobs/:id/download`

## 运行流程

1. 用户上传日期文件或手动添加日期
2. 前端创建任务
3. Worker 创建 `JobStateDO`
4. Browser Rendering 打开中行页面并准备当前日期验证码
5. 前端显示验证码
6. 用户输入验证码
7. Worker 恢复浏览器会话、提交查询、截图并写入 Durable Object 存储
8. 全部日期完成后，Worker 打包 ZIP 并返回下载入口

## 当前限制

- 仍然依赖人工输入验证码
- Browser Rendering 资源和并发能力取决于你的 Cloudflare 套餐
- 中行页面结构如果变化，需要同步调整 `cloudflare/automation.js`
- 当前结果保留策略是 10 分钟短保留，不做长期归档
- 当前版本不依赖 R2，这是为了兼容尚未开通 R2 的 Cloudflare 账号；如果你后续启用 R2，可以再切回对象存储方案
- 当前实现采用 `Worker + Assets` 统一部署；如果后续必须拆成独立 Pages 项目，可直接复用 `public/` 和 `cloudflare/` 代码
