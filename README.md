# Personal_Site · 个人主页（公开站点）

本仓库 = **公开主页 + 公开文档**，托管在 **Cloudflare Pages**，对外公开访问。

> 私有网盘（cloud-r2pan）是**另一个独立仓库**：`StarsObserverEric/cloud-r2pan`（fork 自 Admin666pro/cloud-r2pan），
> 部署到子域 `disk.starsobservereric.cc.cd`，需要登录才能进，**不在本仓库内**。

## 目录
```
Personal_Site/
├─ homepage/                       # 站点根（Cloudflare Pages 直接发布这一层）
│  ├─ index.html
│  └─ docs/                        # 公开文档放这里，丢 html 进去即自动公开
└─ .github/workflows/deploy.yml    # push main → 自动部署到 Pages
```

## 部署
- 托管：Cloudflare Pages，项目名 `personal-site`
- 触发：push 到 `main` → GitHub Actions 执行 `wrangler pages deploy homepage`
- 仓库需在 **Settings → Secrets and variables → Actions** 配置：
  - `CF_API_TOKEN`（Cloudflare API Token）
  - `CF_ACCOUNT_ID`（Cloudflare Account ID）

## 本地位置（VSCode 打开这个文件夹）
`E:\Personal_Site`

## 关联仓库
- 网盘：`StarsObserverEric/cloud-r2pan`（Cloudflare Worker + R2 + D1）
