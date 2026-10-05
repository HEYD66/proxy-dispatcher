# Linux 服务器部署

服务器版把管理页面和代理端口分开：Node 服务只监听 `127.0.0.1:4173`，Nginx 提供 HTTPS，应用提供管理登录；共享 Mihomo 的节点端口监听 `0.0.0.0:21000-21250`，每个端口使用应用生成的独立账号和密码。

## 前置条件

- Ubuntu 22.04/24.04 或兼容的 systemd Linux。
- Node.js 20 或更高版本（systemd 方式需要；Docker 在线构建由镜像提供）。
- 一份与服务器 CPU/系统匹配的 Mihomo Linux 二进制文件，放到 `/opt/proxy-dispatcher/bin/mihomo`，并执行 `chmod 755`。
- 域名、HTTPS 证书和 Nginx。管理页面不要直接把 Node 端口暴露到公网。

## 安装

本项目支持 systemd 和 Docker 两种方式。Docker 方式适合需要固定 Node、依赖和 Mihomo 版本并快速回滚的服务器；Linux Docker 部署使用 host network，以保留管理回环地址和 21000–21250 代理端口。不要同时启动两个版本。

### Docker 部署

服务器已安装 Docker 时，准备好项目目录、`vendor/mihomo/mihomo` 和环境文件后执行。能访问 Docker Hub 时使用标准镜像构建：

```bash
chmod 700 deploy/docker-build.sh deploy/docker-run.sh
PROXY_DISPATCHER_UID="$(id -u proxy-dispatcher)" \
PROXY_DISPATCHER_GID="$(id -g proxy-dispatcher)" \
deploy/docker-build.sh
deploy/docker-run.sh
docker ps --filter name=proxy-dispatcher
docker logs --tail 100 proxy-dispatcher
```

如果服务器不能访问 Docker Hub，使用离线构建器。它从已验证的 `/opt/proxy-dispatcher/runtime/node`、依赖、前端和 Mihomo 二进制组装 `scratch` 镜像，不把服务器数据目录、环境文件或证书复制进镜像：

```bash
chmod 700 deploy/docker-build-offline.sh deploy/docker-run.sh
PROXY_DISPATCHER_IMAGE=proxy-dispatcher:$(cat RELEASE) \
deploy/docker-build-offline.sh
PROXY_DISPATCHER_IMAGE=proxy-dispatcher:$(cat RELEASE) deploy/docker-run.sh
```

容器使用 `--network host`，Node 仍由环境文件绑定 `127.0.0.1:4173`；Nginx 的 HTTPS 和 SSH 隧道无需改端口。数据绑定到 `/var/lib/proxy-dispatcher/data`，密码哈希、节点和设置不会写进镜像。容器以非 root 用户运行，丢弃 Linux capabilities，根文件系统只读，仅 `/tmp` 和数据目录可写，并限制 768 MB 内存。更新时构建新标签，再停止旧容器并运行 `docker-run.sh`；回滚使用旧镜像标签。

切换前先停止 systemd，切回时先删除容器再启动 systemd：

```bash
systemctl disable --now proxy-dispatcher
systemctl enable --now proxy-dispatcher
```

标准镜像构建需要拉取官方 Node 基础镜像；离线构建不需要外网镜像仓库，但要求本机 Node 二进制为 Linux x64 且 Mihomo 二进制为静态文件。

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

复制 `nginx.proxy-dispatcher.conf.example` 到 Nginx 配置目录，替换域名和证书路径，并在环境文件里设置对应的 `PUBLIC_ORIGIN`，例如 `https://proxy.example.com`；自定义端口必须包含端口号。公网管理接口要求登录。页面自动添加修改请求所需的同源保护头。服务器模式按客户端 IP 对管理 API 限流，订阅拉取每分钟最多 30 次。订阅 URL 可能包含 Token，示例配置关闭管理访问日志。防火墙只开放实际使用的 HTTPS 端口和代理端口范围；建议进一步限制来源 IP。不要开放 Node 的 4173 端口。

```bash
sudo nginx -t && sudo systemctl reload nginx
sudo ufw allow 443/tcp
sudo ufw allow 21000:21250/tcp
```

环境文件的 `PUBLIC_PROXY_HOST` 必须设为服务器实际可达的 IP 或代理域名。管理页面中的“复制代理”会使用这个地址、端口和该端口的账号密码，填入目标应用即可；Windows 默认仍输出 `127.0.0.1`。加密协议节点只在启用本地端口后可复制；原生 HTTP/SOCKS 节点可以直接导出。

## 首次登录与账号安全

首次创建密码只能通过 SSH 隧道完成。Windows 可使用 `deploy/connect-server.ps1`，或执行以下命令（替换 SSH 用户、主机和端口）：

```bash
ssh -N -T -p 10022 -L 127.0.0.1:17473:127.0.0.1:4173 root@YOUR_SERVER
```

保持 SSH 连接，打开 `http://127.0.0.1:17473/`，为固定管理账号 `admin` 创建至少 12 个字符的独立密码。密码通过加密的 SSH 通道提交。公网不接受首次创建账号；密码创建后才能通过 HTTPS 登录。

- 密码仅以随机盐的 scrypt 哈希保存在 `AUTH_FILE`，权限 600；此文件包含在服务器数据备份范围内，但不包含在页面导出的节点备份内。
- HTTPS 会话 Cookie 使用 HttpOnly、SameSite=Strict、Secure；SSH 隧道的回环 HTTP 使用 HttpOnly 和 SameSite=Strict。
- 30 分钟无操作或 12 小时后会话过期。后台流量轮询不延长会话。重启服务、退出登录或修改密码会撤销对应会话；修改密码撤销全部旧会话。
- 同一来源 15 分钟内失败 5 次后限制登录；全局每分钟最多 30 次密码验证，最多 2 次并发验证。
- 设置页面可修改管理密码。服务器模式不向浏览器 localStorage 保存订阅和代理凭据。
- 忘记密码时，在 SSH 内将 `admin-auth.json` 移入仅 root 可访问的备份目录，再重启服务，通过 SSH 隧道重新创建密码。不要在公网提供重置入口。

## 验证与维护

```bash
curl -fsS http://127.0.0.1:4173/api/health
sudo systemctl status proxy-dispatcher --no-pager
sudo journalctl -u proxy-dispatcher -n 100 --no-pager
ss -lntp | grep -E ':4173|:21[0-2][0-9]{2}'
```

先导入少量节点，启用并测试 5 到 10 个端口，再批量启用。2 核 2GB 机器可以保存和管理 100 个以上节点，但同时高流量转发能力取决于带宽、连接数和协议加密开销，需要按实际线路压测。`MAX_ACTIVE_NODES` 默认 200，可先设置为 100 控制并发转发规模。

升级时先备份 `/var/lib/proxy-dispatcher/data/`，替换 `/opt/proxy-dispatcher` 代码和 Mihomo 二进制，执行 `npm ci --omit=dev` 后重启服务。回滚时恢复代码和数据备份，再 `systemctl restart`。
