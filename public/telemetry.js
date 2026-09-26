(() => {
  const byId = id => document.getElementById(id);
  const samples = [];
  let lastPid = null;
  let polling = false;
  let loadingLogs = false;
  let events = [];

  function speed(bytes) {
    if (!Number.isFinite(bytes)) return ['—', 'KB/s'];
    if (bytes >= 1024 * 1024) return [(bytes / 1024 / 1024).toFixed(2), 'MB/s'];
    if (bytes >= 1024) return [(bytes / 1024).toFixed(1), 'KB/s'];
    return [String(Math.round(bytes)), 'B/s'];
  }
  function amount(bytes) {
    if (!Number.isFinite(bytes)) return '—';
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${Math.round(bytes)} B`;
  }
  function line(values) {
    const maximum = Math.max(1024, ...samples.flatMap(item => [item.up, item.down]));
    return values.map((value, index) => `${(index * 180 / 59).toFixed(1)},${(43 - Math.min(40, value / maximum * 40)).toFixed(1)}`).join(' ');
  }
  function showTelemetry(data) {
    const running = Boolean(data.running);
    const traffic = running ? data.traffic : null;
    const memory = running ? data.memory : null;
    if (lastPid !== data.pid) { samples.length = 0; lastPid = data.pid; }
    if (traffic) {
      samples.push({ up: traffic.up, down: traffic.down });
      if (samples.length > 60) samples.shift();
    }
    const [up, upUnit] = speed(traffic?.up);
    const [down, downUnit] = speed(traffic?.down);
    byId('sidebar-up').textContent = up;
    byId('sidebar-up-unit').textContent = upUnit;
    byId('sidebar-down').textContent = down;
    byId('sidebar-down-unit').textContent = downUnit;
    byId('sidebar-memory').textContent = memory ? (memory.inuse / 1024 ** 2).toFixed(1) : '—';
    byId('spark-up').setAttribute('points', line(samples.map(item => item.up)));
    byId('spark-down').setAttribute('points', line(samples.map(item => item.down)));
    byId('traffic-status').textContent = running ? (traffic ? '共享内核运行中' : '正在读取内核统计') : '共享内核未运行';
    byId('traffic-up').textContent = traffic ? `${up} ${upUnit}` : '—';
    byId('traffic-down').textContent = traffic ? `${down} ${downUnit}` : '—';
    byId('traffic-up-total').textContent = amount(traffic?.upTotal);
    byId('traffic-down-total').textContent = amount(traffic?.downTotal);
    byId('traffic-memory').textContent = memory ? amount(memory.inuse) : '—';
    byId('traffic-listeners').textContent = running ? String(data.activeListeners) : '0';
  }
  async function pollTelemetry() {
    if (polling) return;
    polling = true;
    try {
      const response = await fetch('/api/telemetry', { cache: 'no-store' });
      if (!response.ok) throw new Error('统计接口不可用');
      showTelemetry(await response.json());
    } catch {
      showTelemetry({ running: false, pid: null });
      byId('traffic-status').textContent = '本机服务暂不可用';
    } finally { polling = false; }
  }
  function renderLogs() {
    const filter = byId('log-level').value;
    const rows = events.filter(event => filter === 'all' || event.level === filter);
    byId('log-count').textContent = `显示 ${rows.length} / ${events.length} 条`;
    const list = byId('log-list');
    list.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'log-empty';
      empty.textContent = '暂无符合条件的日志';
      list.append(empty);
      return;
    }
    for (const event of rows) {
      const row = document.createElement('div');
      row.className = `log-row log-${event.level}`;
      const time = document.createElement('time');
      time.textContent = new Date(event.time).toLocaleString('zh-CN');
      const level = document.createElement('span');
      level.className = 'log-level';
      level.textContent = { info: '信息', warning: '警告', error: '错误' }[event.level] || event.level;
      const category = document.createElement('span');
      category.className = 'log-category';
      category.textContent = event.category;
      const message = document.createElement('span');
      message.className = 'log-message';
      message.textContent = event.message;
      row.append(time, level, category, message);
      list.append(row);
    }
  }
  async function loadLogs() {
    if (loadingLogs) return;
    loadingLogs = true;
    try {
      const response = await fetch('/api/logs?limit=300', { cache: 'no-store' });
      if (!response.ok) throw new Error('读取失败');
      events = (await response.json()).events || [];
      renderLogs();
    } catch {
      byId('log-list').textContent = '日志读取失败，请检查本机服务。';
    } finally { loadingLogs = false; }
  }
  byId('refresh-logs').addEventListener('click', loadLogs);
  byId('log-level').addEventListener('change', renderLogs);
  document.querySelector('[data-view="logs"]').addEventListener('click', loadLogs);
  pollTelemetry();
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    pollTelemetry();
    if (byId('view-logs').classList.contains('active-view')) loadLogs();
  }, 1000);
})();
