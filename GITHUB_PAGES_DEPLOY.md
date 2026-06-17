# GitHub Pages 部署说明

本项目推荐使用 GitHub Pages 托管前端静态文件，Supabase 存储云端 BI 数据。

## 发布目录

GitHub Pages 发布目录固定为：

```text
docs/
```

不要上传 Cloudflare zip 包，不要使用旧的单文件包。

## 每次发布前检查

```powershell
npm run check
npm run build:github-pages
npm run verify:static
```

全部通过后再提交和推送。

## GitHub Pages 设置

在 GitHub 仓库中打开：

```text
Settings -> Pages
```

选择：

```text
Source: Deploy from a branch
Branch: main
Folder: /docs
```

保存后等待 GitHub Pages 生成访问网址。

## 数据存储

业务数据不存放在 GitHub 仓库内。团队成员打开同一个网页后，数据通过 Supabase 表：

```text
public.cdbi_records
```

进行云端同步。
