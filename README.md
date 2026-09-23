# Proxy Dispatcher（代理分发器）

一个本地运行的订阅节点整理工具：导入多个订阅链接、Clash YAML、Base64 节点列表或代理 URI，解析并去重后，可生成以下格式并按应用分配：

- `hostname:port:username:password`
- `username:password:hostname:port`
- `username:password@hostname:port`
- `hostname:port@username:password`

对于 SS、VMess、VLESS、Trojan 节点，四段式文本不是可直接连接的 HTTP 代理。应用分配页会调用本机 Clash Verge 的 Mihomo 内核，把选中节点转换为仅监听 `127.0.0.1` 的本地 HTTP 代理，并显示真实的 `127.0.0.1:port:username:password`。启动前会用 Mihomo 校验配置；停止应用分配时会关闭对应子进程。

## 启动

```powershell
npm.cmd start
```

浏览器打开 <http://127.0.0.1:4173>。订阅 URL 由本地服务代取，解决浏览器跨域；订阅内容、节点和应用分配只保存在浏览器 localStorage，不会上传到第三方服务。

## 支持的输入

- Clash / 类 Clash YAML（`proxies:` 节点，支持多行和 `- {name: ..., server: ..., type: ...}` 行内对象）
- JSON 中的 `proxies` / `outbounds`
- Base64 编码的 URI 列表
- `ss://`、`vmess://`、`vless://`、`trojan://`、`http(s)://`、`socks5://`
- 截图中的四种 `host:port:user:pass` 变体

URL 来源支持“重新解析”以抓取最新节点；粘贴型来源保留当前导入结果。解析是本地启发式解析器；复杂的供应商私有格式需要先转换为上述格式。

## 本地转换依赖

默认复用 `D:\Clash Verge\verge-mihomo.exe`。如安装位置不同，可通过 PowerShell 设置 `MIHOMO_PATH` 后启动服务。Mihomo 子进程只绑定本机回环地址，不会开放局域网监听。
