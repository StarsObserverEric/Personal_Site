# Personal_Site · 个人主页 + 私有网盘（单仓库）

一个 GitHub 仓库、一个本地文件夹，包含两部分：

| 目录 | 内容 | 部署目标 | 访问 |
|---|---|---|---|
| `homepage/` | 公开主页 + 公开文档 | **Cloudflare Pages**（项目 `starsobserveric`） | 公开，`starsobservereric.cc.cd` |
| `netdisk/` | cloud-r2pan 网盘（Worker + R2 + D1） | **Cloudflare Worker** | 私有，需登录 → `disk.starsobservereric.cc.cd` |

## 目录结构
```
Personal_Site/
├─ homepage/                         # 公开站点根（Pages 直接发布这一层）
│  ├─ index.html
│  └─ docs/                          # 公开文档放这里，丢 html 进去即自动公开
├─ netdisk/                          # 网盘全部代码（Cloudflare Worker）
│  ├─ src/            public/        # Worker 源码 / 前端页面
│  ├─ wrangler.jsonc                 # 绑定：D1(db) / R2(r2) / Analytics
│  └─ package.json
├─ .github/workflows/
│  ├─ deploy.yml                     # 主页：push main → 自动部署到 Pages
│  └─ deploy-netdisk.yml             # 网盘：手动触发 → 部署 Worker
├─ .gitignore
└─ README.md
```

## 部署基线
- **主页**：push 到 `main` 且改动落在 `homepage/**` → GitHub Actions 执行
  `wrangler pages deploy homepage --project-name starsobserveric`，直接顶掉旧内容。
  域名 `starsobservereric.cc.cd` 保持绑定在 `starsobserveric` 项目上，无需改动。
- **网盘**：在 Actions 页手动运行 `Deploy netdisk (Worker)`。首次前需在 Cloudflare 建好
  R2 桶 `cloud-r2pan`、D1 库 `cloud-r2pan`（把 id 填进 `netdisk/wrangler.jsonc`），
  并在 Worker 上设 Secret `admin`。

### 仓库 Secrets（Settings → Secrets and variables → Actions）
- `CF_API_TOKEN` —— Cloudflare API Token（主页需 Pages:Edit；网盘还需 Workers 脚本 / D1 / R2:Edit）
- `CF_ACCOUNT_ID` —— Cloudflare Account ID

## 本地位置（VSCode 打开这个文件夹）
`E:\Personal_Site`

## 备注
- 网盘为 fork 自 `Admin666pro/cloud-r2pan`（MIT）合并进本仓库的**普通子目录**，已移除其自带 `.git`；
  因此不再具备 GitHub「Sync fork」一键同步能力，上游更新需手动合并。
- 原 `wrangler.toml`（与 `wrangler.jsonc` 冲突、导致 v3→v4 部署报错）已删除，只保留 `wrangler.jsonc`。
