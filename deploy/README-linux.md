# Linux 服务器部署

服务器版把管理页面和代理端口分开：Node 服务只监听 `127.0.0.1:4173`，Nginx 提供 HTTPS 和 Basic Auth；共享 Mihomo 的节点端口监听 `0.0.0.0:21000-21250`，每个端口使用应用生成的独立账号和密码。

## 前置条件

- Ubuntu 22.04/24.04 或兼容的 systemd Linux。
- Node.js 20 或更高版本。
- 一份与服务器 CPU/系统匹配的 Mihomo Linux 二进制文件，放到 `/opt/proxy-dispatcher/bin/mihomo`，并执行 `chmod 755`。
- 域名、HTTPS 证书和 Nginx。管理页面不要直接把 Node 端口暴露到公网。

## 安装

```bash
sudo useradd --system --home /opt/proxy-dispatcher --shell /usr/sbin/nologin proxy-dispatcher
sudo mkdir -p /opt/proxy-dispatcher/bin /var/lib/proxy-dispatcher/data /etc/proxy-dispatcher
sudo cp -a . /opt/proxy-dispatcher/
sudo chown -R proxy-dispatcher:proxy-dispatcher /opt/proxy-dispatcher /var/lib/proxy-dispatcher
sudo npm ci --omit=dev --prefix /opt/proxy-dispatcher
sudo install -m 755 mihomo-linux-amd64 /opt/proxy-dispatcher/bin/mihomo
sudo install -m 600 deploy/proxy-dispatcher.env.example /etc/proxy-dispatcher/proxy-dispatcher.env
sudo install -m 644 deploy/proxy-dispatcher.service /etc/systemd/system/proxy-dispatcher.service
sudo systemctl daemon-reload
sudo systemctl enable --now proxy-dispatcher
```

编辑环境文件后执行 `sudo systemctl restart proxy-dispatcher`。订阅、节点、活动端口和设置会保存在 `/var/lib/proxy-dispatcher/data/`，这个目录包含订阅签名和代理凭据，只允许服务账号访问。

## Nginx 与防火墙

复制 `nginx.proxy-dispatcher.conf.example` 到 Nginx 配置目录，替换域名和证书路径，使用 `htpasswd` 创建管理账号，然后 reload Nginx。防火墙只开放 `443/tcp` 和代理端口范围；示例环境文件的范围是 `21000-21250/tcp`。如果改了范围，防火墙规则也要同步修改。

```bash
sudo htpasswd -c /etc/nginx/.htpasswd-proxy-dispatcher admin
sudo nginx -t && sudo systemctl reload nginx
sudo ufw allow 443/tcp
sudo ufw allow 21000:21250/tcp
```

管理页面中的“复制代理”会生成服务器地址、端口和该端口的账号密码，填入目标应用即可。加密协议节点只在启用本地端口后可复制；原生 HTTP/SOCKS 节点可以直接导出。

## 验证与维护

```bash
curl -fsS http://127.0.0.1:4173/api/health
sudo systemctl status proxy-dispatcher --no-pager
sudo journalctl -u proxy-dispatcher -n 100 --no-pager
ss -lntp | grep -E ':4173|:21[0-2][0-9]{2}'
```

先导入少量节点，启用并测试 5 到 10 个端口，再批量启用。2 核 2GB 机器可以保存和管理 100 个以上节点，但同时高流量转发能力取决于带宽、连接数和协议加密开销，需要按实际线路压测。`MAX_ACTIVE_NODES` 默认 200，可先设置为 100 控制并发转发规模。

升级时先备份 `/var/lib/proxy-dispatcher/data/`，替换 `/opt/proxy-dispatcher` 代码和 Mihomo 二进制，执行 `npm ci --omit=dev` 后重启服务。回滚时恢复代码和数据备份，再 `systemctl restart`。

