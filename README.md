# Proxy Dispatcher（代理分发器）

一个本地运行的订阅节点整理工具：导入多个订阅链接、Clash YAML、Base64 节点列表或代理 URI，解析并去重后，可生成以下格式并按应用分配：

- `hostname:port:username:password`
- `username:password:hostname:port`
- `username:password@hostname:port`
- `hostname:port@username:password`

## 启动

```powershell
npm.cmd start
```

浏览器打开 <http://127.0.0.1:4173>。订阅 URL 由本地服务代取，解决浏览器跨域；订阅内容、节点和应用分配只保存在浏览器 localStorage，不会上传到第三方服务。

## 支持的输入

- Clash / 类 Clash YAML（`proxies:` 节点）
- JSON 中的 `proxies` / `outbounds`
- Base64 编码的 URI 列表
- `ss://`、`vmess://`、`vless://`、`trojan://`、`http(s)://`、`socks5://`
- 截图中的四种 `host:port:user:pass` 变体

解析是本地启发式解析器；复杂的供应商私有格式需要先转换为上述格式。
