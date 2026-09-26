// Extends the existing source view without changing node or bridge storage formats.
let editingSourceId = null;
const sourceModal = document.querySelector('#source-modal');
const sourceNameInput = document.querySelector('#source-name');
const sourceUrlInput = document.querySelector('#source-url');
const sourceContentInput = document.querySelector('#source-content');
const sourceModalError = document.querySelector('#modal-error');
const sourceSaveButton = document.querySelector('#save-source');

function sourceAddressLabel(source) {
  if (!source.url || source.url === '本地粘贴') return '本地粘贴的配置';
  try { return new URL(source.url).host + ' · 订阅地址已隐藏'; }
  catch { return '订阅地址已隐藏'; }
}

function showSourceModal(source) {
  editingSourceId = source ? source.id : null;
  sourceNameInput.value = source ? source.name : '';
  sourceUrlInput.value = source && source.url !== '本地粘贴' ? source.url : '';
  sourceContentInput.value = '';
  sourceModalError.textContent = '';
  document.querySelector('#source-modal-kicker').textContent = source ? 'EDIT INPUT' : 'NEW INPUT';
  document.querySelector('#source-modal-title').textContent = source ? '编辑订阅源' : '添加订阅源';
  document.querySelector('#source-url-note').textContent = source ? '每个订阅源只能有一个链接' : '可留空，直接粘贴文本';
  document.querySelector('#source-content-note').textContent = source ? '可选；填写后将替换该来源的节点' : '支持 Clash YAML、Base64、URI';
  sourceSaveButton.innerHTML = source ? '保存修改' : '导入并解析 <span>→</span>';
  sourceModal.classList.remove('hidden');
  sourceNameInput.focus();
}

function hideSourceModal() {
  editingSourceId = null;
  sourceModal.classList.add('hidden');
  sourceNameInput.value = '';
  sourceUrlInput.value = '';
  sourceContentInput.value = '';
  sourceModalError.textContent = '';
}

async function saveEditedSource() {
  const source = state.sources.find(item => item.id === editingSourceId);
  if (!source) { sourceModalError.textContent = '订阅源已不存在'; return; }
  const name = sourceNameInput.value.trim();
  const url = sourceUrlInput.value.trim();
  const pasted = sourceContentInput.value.trim();
  if (!name) { sourceModalError.textContent = '请输入订阅源名称'; return; }
  if (url.includes('\n') || url.includes('\r')) { sourceModalError.textContent = '编辑时请只填写一个订阅链接'; return; }
  if (!url && !pasted && source.url !== '本地粘贴') { sourceModalError.textContent = '请填写订阅链接或替换配置内容'; return; }
  if (url) {
    try {
      if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error();
    } catch { sourceModalError.textContent = '请输入有效的 HTTP 或 HTTPS 订阅链接'; return; }
  }
  const oldUrl = source.url === '本地粘贴' ? '' : source.url;
  const needsParse = Boolean(pasted || url !== oldUrl);
  const previousState = JSON.parse(JSON.stringify({ sources: state.sources, proxies: state.proxies, apps: state.apps }));
  const changedActive = [];
  let mutated = false;
  sourceSaveButton.disabled = true;
  sourceSaveButton.textContent = needsParse ? '解析中…' : '保存中…';
  sourceModalError.textContent = '';
  try {
    let parsed = null;
    if (needsParse) {
      let content = pasted;
      if (!pasted) {
        const response = await fetch('/api/fetch?url=' + encodeURIComponent(url));
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '订阅请求失败');
        content = data.text;
      }
      parsed = parseContent(content, { ...source, name });
      if (!parsed.length) throw new Error('没有识别到节点，原有数据未改动');
    }
    if (parsed) {
      const previous = state.proxies.filter(p => (p.sourceIds || [p.sourceId]).includes(source.id));
      const used = new Set();
      const nodeName = p => p.protocol + '|' + String(p.name).replace(/[+\s]+/g, '').toLowerCase();
      mutated = true;
      detachSource(source.id);
      for (const proxy of parsed) {
        const nameMatches = previous.filter(p => nodeName(p) === nodeName(proxy));
        const newNameMatches = parsed.filter(p => nodeName(p) === nodeName(proxy));
        const old = previous.find(p => !used.has(p.id) && p.key === proxy.key)
          || previous.find(p => !used.has(p.id) && p.server === proxy.server && p.port === proxy.port && nodeName(p) === nodeName(proxy))
          || (nameMatches.length === 1 && newNameMatches.length === 1 && !used.has(nameMatches[0].id) ? nameMatches[0] : null);
        if (old) {
          used.add(old.id);
          proxy.id = old.id;
          if (old.rawLine === proxy.rawLine) proxy.lastProbe = old.lastProbe;
          if (old.rawLine !== proxy.rawLine) {
            for (const bridge of state.bridges) {
              if (bridge.appId === 'pool-' + old.id ||
                  state.apps.some(app => app.id === bridge.appId && app.proxyId === old.id)) {
                changedActive.push({ appId: bridge.appId, id: old.id, name: proxy.name, rawLine: proxy.rawLine });
              }
            }
          }
        }
      }
      source.url = pasted ? '本地粘贴' : url;
      source.nodeCount = parsed.length;
      mergeParsed(source, parsed);
      state.apps.forEach(app => {
        if (!state.proxies.some(p => p.id === app.proxyId)) app.proxyId = '';
      });
    }
    mutated = true;
    source.name = name;
    source.updatedAt = new Date().toISOString();
    state.proxies.forEach(p => { if (p.sourceId === source.id) p.sourceName = name; });
    await save();
    if (parsed) {
      const pool = changedActive.filter(item => item.appId === 'pool-' + item.id);
      if (pool.length) await bridgeRequest('/api/bridge/pool/start', { items: pool });
      for (const item of changedActive.filter(item => item.appId !== 'pool-' + item.id)) {
        await bridgeRequest('/api/bridge/start', item);
      }
      await stopMissingBridges();
    }
    hideSourceModal();
    toast(parsed ? '订阅已更新，解析到 ' + parsed.length + ' 个节点' : '订阅名称已保存');
  } catch (error) {
    if (mutated) {
      state.sources = previousState.sources;
      state.proxies = previousState.proxies;
      state.apps = previousState.apps;
      try {
        await save();
        const oldItems = changedActive.map(item => ({
          ...item,
          name: previousState.proxies.find(p => p.id === item.id)?.name,
          rawLine: previousState.proxies.find(p => p.id === item.id)?.rawLine
        }));
        const pool = oldItems.filter(item => item.appId === 'pool-' + item.id);
        if (pool.length) await bridgeRequest('/api/bridge/pool/start', { items: pool });
        for (const item of oldItems.filter(item => item.appId !== 'pool-' + item.id)) {
          await bridgeRequest('/api/bridge/start', item);
        }
        await reloadBridges();
      } catch (restoreError) {
        sourceModalError.textContent = '保存失败，自动恢复也失败：' + restoreError.message;
        return;
      }
    }
    sourceModalError.textContent = error.message || '保存失败，原有数据未改动';
  } finally {
    sourceSaveButton.disabled = false;
    sourceSaveButton.textContent = '保存修改';
  }
}

function sourceButton(label, action, className) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'small-btn' + (className ? ' ' + className : '');
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

renderSources = function () {
  const list = document.querySelector('#source-list');
  list.replaceChildren();
  if (!state.sources.length) {
    list.innerHTML = '<div class="panel empty-state"><div class="empty-icon">↥</div><p>还没有订阅源</p><small>添加链接或粘贴配置内容开始</small></div>';
    return;
  }
  for (const source of state.sources) {
    const card = document.createElement('div');
    card.className = 'source-card';
    const main = document.createElement('div');
    main.className = 'source-main';
    main.innerHTML = '<div class="source-icon">↥</div>';
    const details = document.createElement('div');
    details.className = 'source-details';
    const name = document.createElement('div');
    name.className = 'source-name';
    name.textContent = source.name;
    const address = document.createElement('div');
    address.className = 'source-url';
    address.textContent = sourceAddressLabel(source);
    details.append(name, address);
    main.append(details);
    const meta = document.createElement('div');
    meta.className = 'source-meta';
    const count = document.createElement('strong');
    count.textContent = String(source.nodeCount || 0);
    const countLabel = document.createElement('span');
    countLabel.textContent = '个节点';
    meta.append(count, countLabel);
    const actions = document.createElement('div');
    actions.className = 'source-actions';
    actions.append(sourceButton('编辑', () => showSourceModal(source)));
    if (source.url && source.url !== '本地粘贴') {
      actions.append(sourceButton('重新解析', () => refreshSource(source.id)));
    }
    actions.append(sourceButton('删除', async () => {
      if (!confirm('删除此订阅源及其独有节点？')) return;
      state.sources = state.sources.filter(item => item.id !== source.id);
      detachSource(source.id);
      state.apps.forEach(app => { if (!state.proxies.some(p => p.id === app.proxyId)) app.proxyId = ''; });
      await save();
      await stopMissingBridges();
      toast('已删除订阅源及其独有节点');
    }, 'danger'));
    card.append(main, meta, actions);
    list.append(card);
  }
};

document.querySelector('#open-source-modal').onclick = () => showSourceModal(null);
document.querySelector('#close-source-modal').onclick = hideSourceModal;
document.querySelector('#cancel-source').onclick = hideSourceModal;
sourceModal.onclick = event => { if (event.target === sourceModal) hideSourceModal(); };
sourceSaveButton.onclick = () => editingSourceId ? saveEditedSource() : importSource();
