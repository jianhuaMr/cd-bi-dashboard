# CD-BI 迁移到 Cloudflare Pages 免费版

## 已生成文件

桌面文件：

`C:\Users\yangj\Desktop\cd-bi-cloudflare-pages.zip`

这个包只包含前端代码、样式、解析逻辑和 Cloudflare 汇率接口，不包含任何 Excel 原始数据或 IndexedDB 业务数据。

## 推荐部署方式

1. 打开 Cloudflare 控制台。
2. 进入 `Workers & Pages`。
3. 点击 `Create application`。
4. 选择 `Pages`。
5. 选择 `Upload assets` 或 `Direct Upload`。
6. 项目名建议：`cd-bi-dashboard`。
7. 上传 `cd-bi-cloudflare-pages.zip`。
8. 部署完成后打开 Cloudflare 给出的 `*.pages.dev` 地址。

## 部署后检查

打开页面后先检查：

- 页面标题和导航不再乱码。
- 数据中心可以上传清算表。
- 汇率管理里点击自动获取时，请求路径应为 `/api/smbs-rate`。
- 如果 SMBS 网站临时访问失败，系统会显示明确错误，不会静默写入错误汇率。

## 数据迁移说明

当前 CD-BI 的业务数据保存在浏览器 IndexedDB，按域名隔离：

- AWS 地址的数据不会自动出现在 Cloudflare Pages 地址。
- 迁移到新地址后，需要在旧站导出备份 JSON，再在新站导入备份。
- 如果旧站已经无法正常使用，可以直接在新站重新上传 Excel 原件。

## 重要说明

Cloudflare Pages 免费版适合这个项目，因为 CD-BI 主要是静态前端工具。它不需要 EC2、Nginx、PM2 或 SSH。

后续如果要做“多设备共享同一份数据”“老板也能看到同一份已上传数据”，需要再接一个后端数据库，例如 Cloudflare D1 / R2 / Supabase。
