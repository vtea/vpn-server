# vpn-api 手工打包部署（Linux）

本文用于不依赖一键安装脚本的场景：先在构建机产出 `tar.gz`，再上传到服务器以 `systemd` 运行。

## 1. 在构建机打包

在项目目录执行：

```bash
cd vpn-api
bash scripts/package-linux.sh
```

产物位于：

- `dist/vpn-api-linux-bundle-<version>/`
- `dist/vpn-api-linux-bundle-<version>.tar.gz`

## 2. 上传并解压到服务器

```bash
sudo mkdir -p /opt/vpn-api
sudo tar -xzf vpn-api-linux-bundle-<version>.tar.gz -C /opt/vpn-api --strip-components=1
sudo mkdir -p /opt/vpn-api/data /opt/vpn-api/ca /opt/vpn-api/backups
```

## 3. 配置环境变量

```bash
sudo cp /opt/vpn-api/config/vpn-api.env.example /opt/vpn-api/config/vpn-api.env
sudo vim /opt/vpn-api/config/vpn-api.env
```

至少修改以下变量：

- `JWT_SECRET`：必须替换为强随机字符串
- `EXTERNAL_URL`：必须设置为服务器公网可达地址（域名或公网 IP）

## 4. 安装并启动 systemd

```bash
sudo cp /opt/vpn-api/systemd/vpn-api.service /etc/systemd/system/vpn-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now vpn-api
sudo systemctl status vpn-api --no-pager
```

## 5. 验收

```bash
curl -sf http://127.0.0.1:56700/api/health
curl -fLo /tmp/vpn-agent-linux-amd64 http://127.0.0.1:56700/api/downloads/vpn-agent-linux-amd64
ls -lh /tmp/vpn-agent-linux-amd64
```

## 6. 备份（可选）

```bash
sudo crontab -e
```

添加：

```cron
0 2 * * * DB_PATH=/opt/vpn-api/data/vpn.db BACKUP_DIR=/opt/vpn-api/backups /opt/vpn-api/scripts/backup.sh >> /var/log/vpn-backup.log 2>&1
```
