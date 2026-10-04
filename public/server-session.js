(() => {
  if (!isServerMode) return;
  const logout = document.createElement('button');
  logout.type = 'button';
  logout.className = 'secondary-btn';
  logout.textContent = '退出登录';
  document.querySelector('.top-actions').appendChild(logout);
  logout.addEventListener('click', async () => {
    logout.disabled = true;
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error('退出失败，请重试');
      ['pd_sources', 'pd_proxies', 'pd_apps'].forEach(key => localStorage.removeItem(key));
      location.replace('/login');
    } catch (error) { toast(error.message); logout.disabled = false; }
  });

  const panel = document.createElement('div');
  panel.className = 'settings-panel';
  panel.innerHTML = '<h3>管理账号</h3><p class="settings-warning">30 分钟无操作后过期，最长登录 12 小时。修改密码会撤销所有旧会话。</p><button class="secondary-btn" id="open-password-form" type="button">修改管理密码</button><form id="password-form" class="hidden"><label>当前密码<input type="password" name="currentPassword" autocomplete="current-password" maxlength="256" required /></label><label>新密码<input type="password" name="newPassword" autocomplete="new-password" minlength="12" maxlength="256" required /></label><label>确认新密码<input type="password" name="confirmPassword" autocomplete="new-password" minlength="12" maxlength="256" required /></label><button class="secondary-btn" type="submit">保存新密码</button></form><p id="password-feedback" class="settings-feedback" role="status"></p>';
  document.querySelector('.settings-grid').appendChild(panel);
  const form = panel.querySelector('form');
  panel.querySelector('#open-password-form').onclick = () => { form.classList.toggle('hidden'); if (!form.classList.contains('hidden')) form.elements.currentPassword.focus(); };
  form.onsubmit = async event => {
    event.preventDefault();
    const feedback = panel.querySelector('#password-feedback');
    if (form.elements.newPassword.value !== form.elements.confirmPassword.value) { feedback.textContent = '两次新密码不一致'; return; }
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      const response = await fetch('/api/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: form.elements.currentPassword.value, newPassword: form.elements.newPassword.value }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '密码修改失败');
      feedback.textContent = '密码已更新，其他登录会话已退出。';
      form.classList.add('hidden');
    } catch (error) { feedback.textContent = error.message; }
    finally { form.reset(); submit.disabled = false; }
  };

  // Background telemetry does not extend the session; only actual interaction does.
  let lastTouch = 0;
  for (const event of ['pointerdown', 'keydown', 'wheel']) document.addEventListener(event, () => {
    if (Date.now() - lastTouch < 60_000) return;
    lastTouch = Date.now();
    fetch('/api/auth/touch', { method: 'POST' }).catch(() => {});
  }, { passive: true });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
})();
