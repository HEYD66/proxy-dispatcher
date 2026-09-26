# Proxy Dispatcher（代理分发器）

本机订阅节点管理与按需分发工具。可一次粘贴多条订阅链接（每行一条），分别抓取、解析和更新。一个来源失败不影响其他来源。导入只保存节点，不自动启动节点或对全部节点测速。

## 转发方式

- 原生 HTTP/HTTPS/SOCKS5：有账号和密码时直接导出四段式代理行，不经过 Mihomo。
- SS/VMess/VLESS/Trojan：启用后由**同一个 Mihomo 进程**提供多个独立的本地 Mixed（HTTP+SOCKS）端口，每个端口绑定一个上游节点。节点池和“应用分配”共用此进程。
- 可在节点池逐条启用、停止和测试出口；搜索后点击“生成可用代理池”会增加当前筛选结果，已启用的其他端口继续保留。更改已启用的节点时会重建共享进程，现有连接可能短暂中断，原有端口和认证信息保持不变。

生成的本地代理形如 `127.0.0.1:port:username:password`，只供**同一台机器**上的应用使用。本地端口启动成功不等于上游可达，使用前请单独测试出口。订阅商线路或 DNS 异常不会被格式转换解决。

## Windows 运行

```powershell
npm.cmd start
```

打开 <http://127.0.0.1:4173>。Windows 默认使用项目自带的 `vendor/mihomo/mihomo.exe`（v1.19.31），不依赖或修改 Clash Verge；只有设置 `MIHOMO_PATH` 时才改用指定内核。内核版本、官方来源、校验值和许可见 `vendor/mihomo/README.md`。`MAX_ACTIVE_NODES` 设置同时启用数量上限，默认 200，最大 500。100 个节点可先全部导入，实际只启用需要的部分。

管理服务仅监听 `127.0.0.1`，代理入口也仅监听 `127.0.0.1`。订阅、节点、应用分配保存在 `data/state.json`；活动监听端口及凭据保存在 `data/active-bridges.json`，服务重启后尝试恢复。修改前自动生成 `state.json.bak`。`data/` 已加入 `.gitignore`；其中含订阅签名链接、节点凭据和本地端口凭据，请限制文件访问。

## Windows 桌面版（Electron）

开发时运行 `npm.cmd run desktop`；执行 `npm.cmd run package:win` 后，在 `dist/ProxyDispatcher-1.0.0-win32-x64/` 中得到 `Proxy Dispatcher.exe` 和完整运行目录。复制整个目录即可运行，无需目标电脑另装 Node.js 或 Clash Verge。首次打包运行会尝试读取当前项目的本地数据，或从正在运行的旧网页服务导入订阅、节点和应用分配；不会将私人订阅写入安装包。桌面版随后把数据保存在 Windows 用户数据目录的 `代理分发器/data/` 下，与网页开发服务分开。关闭桌面窗口会停止它启动的 Mihomo 进程，活动端口记录保留供下次恢复。

桌面版使用独立的随机本机管理端口，不占用网页开发服务的 `4173`。打包产物是便携目录，并非安装程序；请保留目录中的全部文件。当前仅打包 Windows x64。

## 输入与导出

支持 Clash 行内 YAML 节点、部分多行 YAML、JSON `proxies/outbounds`、Base64 节点列表、常见 SS/VMess/VLESS/Trojan/HTTP/SOCKS URI，以及四段式代理文本。复杂供应商私有配置可能无法完整解析，应以 Mihomo 配置校验和出口测试为准。去重比较完整节点配置及协议字段，跨来源重复节点保留来源关联。

可选导出格式：

- `hostname:port:username:password`
- `username:password:hostname:port`
- `username:password@hostname:port`
- `hostname:port@username:password`

未带账号密码的原生代理不能填入要求四段式认证的目标应用；请按目标应用支持的无认证格式另行配置。

## Linux 部署边界

当前版本的管理 API 和代理端口都只绑定回环地址，适合 Windows 本机验证或 Linux 本机使用。**尚未实现公网代理分发、管理 API 认证、访问白名单、systemd 守护和 2 核 2 GB 机器的吞吐容量验证**。不能通过修改监听地址直接暴露到公网；对外服务需要先补鉴权、访问控制和带宽监控。Linux 可用 `MIHOMO_PATH` 指定内核、`STATE_FILE` 与 `ACTIVE_BRIDGES_FILE` 指定持久化位置。
