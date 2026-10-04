(() => {
  const byId = id => document.getElementById(id);
  let current = null;
  let paths = {};
  let desktopAvailable = false;
  const feedback = (message, error = false) => {
    const element = byId('settings-feedback');
    element.textContent = message;
    element.classList.toggle('error', error);
  };

  function fill(settings) {
    byId('setting-restore').checked = settings.restoreOnLaunch;
    byId('setting-close').value = settings.closeBehavior;
    byId('setting-autostart').checked = settings.autoStart;
    byId('setting-page').value = settings.startupPage;
    byId('setting-concurrency').value = String(settings.probeConcurrency);
    byId('setting-timeout').value = String(settings.probeTimeoutSeconds);
    byId('setting-log-level').value = settings.coreLogLevel;
    byId('setting-retention').value = String(settings.logRetentionDays);
    byId('probe-concurrency').value = String(settings.probeConcurrency);
  }

  function readForm() {
    return {
      restoreOnLaunch: byId('setting-restore').checked,
      closeBehavior: byId('setting-close').value,
      autoStart: byId('setting-autostart').checked,
      startupPage: byId('setting-page').value,
      probeConcurrency: Number(byId('setting-concurrency').value),
      probeTimeoutSeconds: Number(byId('setting-timeout').value),
      coreLogLevel: byId('setting-log-level').value,
      logRetentionDays: Number(byId('setting-retention').value)
    };
  }

  function showInfo(data) {
    if (data.serverMode) {
      document.querySelector('.sidebar-foot span:last-child').textContent = '服务器模式 · 数据保存在服务器';
      byId('clear-data').textContent = '清空服务器数据';
      document.querySelector('#view-apps .section-head > div > p:last-child').textContent = '按出口 IP、延迟和速率选择节点；配置保存在服务器。';
      document.querySelector('#view-logs .section-head > div > p:last-child').textContent = '记录订阅请求、代理启停、节点检测及共享内核警告。日志保存在服务器。';
    }
    paths = { data: data.dataDirectory, log: data.logFile };
    byId('setting-core-version').textContent = data.coreVersion;
    byId('setting-active-ports').textContent = `${data.runtime.activeListeners} 个端口`;
    byId('setting-data-path').textContent = paths.data;
    byId('setting-log-path').textContent = paths.log;
    const active = data.runtime.coreLogLevel;
    const pending = data.runtime.pendingCoreLogLevel !== active;
    byId('setting-active-log-level').textContent = `${active}${pending ? ' · 新级别待重启内核' : ''}`;
  }

  async function reloadInfo() {
    const response = await fetch('/api/settings', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取设置失败');
    showInfo(data);
    return data;
  }

  async function load() {
    try {
      const data = await reloadInfo();
      current = data.settings;
      desktopAvailable = data.desktopAvailable;
      fill(current);
      byId('setting-autostart').disabled = !desktopAvailable;
      byId('setting-close').disabled = !desktopAvailable;
      const savedMessage = sessionStorage.getItem('pd_restore_notice');
      if (savedMessage) { feedback(savedMessage); sessionStorage.removeItem('pd_restore_notice'); }
      const startupButton = document.querySelector(`[data-view="${current.startupPage}"]`);
      if (startupButton) startupButton.click();
    } catch (error) { feedback(error.message, true); }
  }

  byId('save-settings').addEventListener('click', async () => {
    if (!current) return feedback('设置尚未加载', true);
    const next = readForm();
    if (!desktopAvailable && (next.autoStart !== current.autoStart || next.closeBehavior !== current.closeBehavior)) return feedback('开机自启和托盘功能仅桌面版可用', true);
    if (next.logRetentionDays && (!current.logRetentionDays || next.logRetentionDays < current.logRetentionDays) &&
        !confirm(`保存后将清理超过 ${next.logRetentionDays} 天的旧日志，确定继续吗？`)) return;
    const button = byId('save-settings');
    button.disabled = true;
    try {
      const response = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '保存设置失败');
      const startupChanged = next.restoreOnLaunch !== current.restoreOnLaunch || next.startupPage !== current.startupPage;
      current = result.settings;
      fill(current);
      await reloadInfo();
      feedback(result.retentionWarning || (result.pendingCoreRestart ? '设置已保存。新内核日志级别需点击“重启内核应用”后生效。' : startupChanged ? '设置已保存。启动时恢复和启动页面将在下次打开程序时生效。' : '设置已保存并生效。'), Boolean(result.retentionWarning));
    } catch (error) { feedback(error.message, true); }
    finally { button.disabled = false; }
  });

  byId('restart-core').addEventListener('click', async () => {
    if (!confirm('这会断开当前连接并重启本应用的共享 Mihomo 内核，是否继续？')) return;
    const button = byId('restart-core');
    button.disabled = true;
    try {
      const response = await fetch('/api/bridge/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '重启内核失败');
      await reloadBridges();
      await reloadInfo();
      feedback(`共享内核已重启，恢复 ${result.restarted} 个端口。`);
    } catch (error) { feedback(error.message, true); }
    finally { button.disabled = false; }
  });

  byId('copy-data-path').addEventListener('click', () => paths.data && copyText(paths.data));
  byId('copy-log-path').addEventListener('click', () => paths.log && copyText(paths.log));
  document.querySelector('[data-view="settings"]').addEventListener('click', () => { reloadInfo().catch(error => feedback(error.message, true)); });

  byId('export-backup').addEventListener('click', async () => {
    try {
      const response = await fetch('/api/backup', { cache: 'no-store' });
      if (!response.ok) throw new Error('备份生成失败');
      const blob = await response.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      const today = new Date();
      const localDate = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-');
      link.download = `proxy-dispatcher-backup-${localDate}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 60000);
      feedback('备份文件已交给浏览器下载。请检查下载目录，并妥善保管其中的凭据。');
    } catch (error) { feedback(error.message, true); }
  });

  byId('import-backup').addEventListener('click', () => byId('backup-file').click());
  byId('backup-file').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 8_000_000) return feedback('备份文件超过 8 MB 限制', true);
    let backup;
    try { backup = JSON.parse(await file.text()); }
    catch { return feedback('备份文件不是有效 JSON', true); }
    if (backup.type !== 'proxy-dispatcher-backup' || backup.version !== 1 || !Array.isArray(backup.state?.sources) || !Array.isArray(backup.activeBridges)) return feedback('备份文件格式无效', true);
    if (!confirm(`将恢复 ${backup.state.sources.length} 个订阅和 ${backup.activeBridges.length} 个活动端口。当前数据会先自动备份，已有代理连接会断开。确定恢复吗？`)) return;
    try {
      const response = await fetch('/api/backup/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(backup) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '恢复失败');
      for (const key of ['pd_sources', 'pd_proxies', 'pd_apps']) localStorage.removeItem(key);
      sessionStorage.setItem('pd_restore_notice', `数据已恢复：${result.sources} 个订阅、${result.proxies} 个节点、${result.activeListeners} 个端口。恢复前快照：${result.safetyFile}`);
      location.reload();
    } catch (error) { feedback(error.message, true); }
  });

  load();
})();
