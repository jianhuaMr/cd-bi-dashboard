# CD-BI 迁移到 AWS EC2 部署说明

适用场景：Netlify 积分/额度用完后，把 CD-BI 部署到自己的 AWS 云服务器。

## 1. 在 AWS 创建 EC2

区域建议先用你当前控制台所在区域：`us-east-1`。

创建实例建议：

- Name: `cd-bi-dashboard`
- AMI: Ubuntu Server 24.04 LTS 或 22.04 LTS
- Instance type: `t3.micro` 或 `t2.micro`
- Key pair: 新建并下载 `.pem`
- Security group:
  - SSH 22: 仅允许你的 IP
  - HTTP 80: 允许 `0.0.0.0/0`
  - HTTPS 443: 如后续配置域名证书再开放

创建后记下 EC2 的 Public IPv4 address。

## 2. 登录服务器

Windows PowerShell 示例：

```powershell
ssh -i C:\path\to\your-key.pem ubuntu@你的EC2公网IP
```

## 3. 安装运行环境

```bash
sudo apt update
sudo apt install -y nginx nodejs npm unzip
sudo npm install -g pm2
```

检查版本：

```bash
node -v
npm -v
pm2 -v
```

Node 建议 18+。如果系统自带版本太低，再安装 NodeSource 版本。

## 4. 上传项目文件

在本机 PowerShell，进入项目目录：

```powershell
cd "C:\Users\yangj\Desktop\店铺销售情况\bi-dashboard"
```

打包：

```powershell
Compress-Archive -Path index.html,css,js,server.js,package.json,ecosystem.config.cjs,nginx-cd-bi.conf -DestinationPath cd-bi-dashboard.zip -Force
```

上传：

```powershell
scp -i C:\path\to\your-key.pem cd-bi-dashboard.zip ubuntu@你的EC2公网IP:/tmp/
```

服务器上解压：

```bash
sudo mkdir -p /var/www/cd-bi
sudo unzip -o /tmp/cd-bi-dashboard.zip -d /var/www/cd-bi
sudo chown -R ubuntu:ubuntu /var/www/cd-bi
```

## 5. 启动 CD-BI 服务

```bash
cd /var/www/cd-bi
npm run check
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

执行 `pm2 startup` 后，终端会输出一行 `sudo env PATH=...` 命令，把那一行复制执行一次。

检查服务：

```bash
curl http://127.0.0.1:3001/health
```

正常返回：

```json
{"ok":true}
```

## 6. 配置 Nginx

```bash
sudo cp /var/www/cd-bi/nginx-cd-bi.conf /etc/nginx/sites-available/cd-bi
sudo ln -sf /etc/nginx/sites-available/cd-bi /etc/nginx/sites-enabled/cd-bi
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

浏览器打开：

```text
http://你的EC2公网IP/
```

## 7. 数据迁移提醒

CD-BI 的上传数据保存在浏览器 IndexedDB。

从 Netlify 换到 AWS 地址后，浏览器会把它当作新网站，所以旧数据不会自动带过去。

迁移前：

1. 在旧 Netlify 网站进入「数据中心」
2. 点击「导出备份 JSON」

迁移后：

1. 打开 AWS 新地址
2. 进入「数据中心」
3. 点击「导入备份」

## 8. 更新版本

以后本地修改后，重新打包上传并重启：

```bash
cd /var/www/cd-bi
pm2 restart cd-bi-dashboard
```

## 9. 可选：绑定域名和 HTTPS

如果你有域名：

1. 在域名 DNS 添加 A 记录到 EC2 公网 IP
2. 修改 `nginx-cd-bi.conf` 的 `server_name`
3. 安装证书：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 你的域名
```

