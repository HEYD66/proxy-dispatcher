(() => {
  const byId = id => document.getElementById(id);
  let setup = false;
  async function status() {
    const response = await fetch('/api/auth/status', { cache: 'no-store' });
    const info = await response.json();
    if (!response.ok) throw new Error(info.error || '无法连接管理服务');
    if (!info.serverMode || info.authenticated) return location.replace('/');
    setup = !info.configured && info.canSetup;
    if (!info.configured && !info.canSetup) {
      byId('login-description').textContent = '管理账号尚未初始化。请先通过 SSH 隧道打开管理页面，创建密码后再从公网登录。';
      return;
    }
    byId('login-title').textContent = setup ? '创建管理密码' : '安全登录';
    byId('login-description').textContent = setup ? '你正在通过 SSH 隧道访问。请为管理账号设置独立密码，至少 12 个字符。' : '使用管理账号登录，查看和分配服务器上的代理。';
    byId('confirm-row').hidden = !setup;
    byId('confirm-password').required = setup;
    byId('password').minLength = setup ? 12 : 1;
    byId('password').autocomplete = setup ? 'new-password' : 'current-password';
    byId('login-submit').textContent = setup ? '创建密码并进入' : '登录';
    byId('login-form').hidden = false;
    byId('password').focus();
  }
  byId('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const password = byId('password').value;
    if (setup && password !== byId('confirm-password').value) { byId('login-message').textContent = '两次密码不一致'; return; }
    byId('login-submit').disabled = true;
    byId('login-message').textContent = '';
    try {
      const response = await fetch(setup ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ProxyDispatcher' }, body: JSON.stringify({ username: 'admin', password }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '登录失败');
      ['pd_sources', 'pd_proxies', 'pd_apps'].forEach(key => localStorage.removeItem(key));
      location.replace('/');
    } catch (error) { byId('login-message').textContent = error.message; }
    finally { byId('password').value = ''; byId('confirm-password').value = ''; byId('login-submit').disabled = false; }
  });
  status().catch(error => { byId('login-message').textContent = error.message; });
})();
