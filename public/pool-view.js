/* View-only state stays in this browser; subscriptions and assignments stay on the server. */
let poolViewMode = localStorage.getItem('pd_pool_view') === 'list' ? 'list' : 'cards';
let appViewMode = localStorage.getItem('pd_app_view') === 'list' ? 'list' : 'cards';
let collapsedSources;
try { collapsedSources = new Set(JSON.parse(localStorage.getItem('pd_collapsed_sources') || '[]')); }
catch { collapsedSources = new Set(); }
const persistCollapsed = () => localStorage.setItem('pd_collapsed_sources', JSON.stringify([...collapsedSources]));
const metric = (value, suffix, digits = 0) => Number.isFinite(value) ? `${Number(value).toFixed(digits)} ${suffix}` : '—';
const nodeIp = p => p.lastProbe?.ip || (p.lastProbe?.error ? '检测失败' : '待查');
const nodeDelay = p => metric(p.lastProbe?.latencyMs, 'ms');
const nodeSpeed = p => metric(p.lastProbe?.downloadMbps, 'Mbps', 2);
const nodeConnectivity = p => p.lastProbe?.error ? '检测失败' : p.lastProbe?.ip ? 'IP 已查到' : '未检测';
const checkedTime = p => p.lastProbe?.checkedAt ? new Date(p.lastProbe.checkedAt).toLocaleString('zh-CN') : '尚未检测';
const assignedApps = p => state.apps.filter(app => app.proxyId === p.id);
const assignmentBadge = p => { const apps=assignedApps(p); return apps.length ? `<span class="assignment-badge" title="${esc(apps.map(a=>a.name).join('、'))}">已分配 ${apps.length}</span>` : ''; };
const probeRank = p => p.lastProbe?.ip ? 0 : p.lastProbe?.error ? 2 : 1;

function sourceGroups(rows) {
  const groups = new Map(state.sources.map(source => [source.id, { id: source.id, name: source.name, items: [] }]));
  for (const p of rows) {
    const memberships = [...new Set(Array.isArray(p.sourceIds) && p.sourceIds.length ? p.sourceIds : [p.sourceId || 'other'])];
    for (const id of memberships) {
      if (!groups.has(id)) groups.set(id, { id, name: p.sourceName || '其他节点', items: [] });
      groups.get(id).items.push(p);
    }
  }
  return [...groups.values()].filter(group => group.items.length);
}

function nodeActionButtons(p) {
  if(isSubscriptionNotice(p))return '<span class="muted">订阅信息，仅供查看</span>';
  const id = esc(p.id);
  const bridge = bridgeFor(`pool-${p.id}`);
  const available = bridge || probeBridgeFor(p) || nativeProbeable(p);
  const busy = probingNodes.has(p.id);
  let actions = `<button class="copy-btn" data-assign-node="${id}">分配</button>`;
  if (bridgeable(p)) {
    actions += bridge
      ? `<button class="copy-btn" data-copy-local="${id}">复制代理</button><button class="copy-btn" data-check-node="${id}">连通性</button><button class="copy-btn" data-stop-node="${id}">停用</button>`
      : p.rawLine ? `<button class="copy-btn" data-start-node="${id}">启用</button>` : '<span class="muted">需重新解析</span>';
  } else if (directExportable(p)) {
    actions += `<button class="copy-btn" data-copy-proxy="${id}">复制代理</button>`;
  } else {
    actions += '<span class="muted">不可导出</span>';
  }
  if (available) actions += `<button class="copy-btn" data-probe-ip="${id}" ${busy ? 'disabled' : ''}>${busy ? '检测中…' : '查 IP'}</button><button class="copy-btn" data-probe-speed="${id}" ${busy ? 'disabled' : ''}>测速</button>`;
  return actions;
}

function nodeCard(p) {
  const bridge = bridgeFor(`pool-${p.id}`);
  const preview = bridge ? '本地代理已启用，可复制使用' : bridgeable(p) ? (p.rawLine ? '未启用 · 按需启动' : '需重新解析') : directExportable(p) ? '原生代理 · 可直接复制' : '缺少账号或密码 · 不能直接导出';
  return `<article class="proxy-card${bridge ? ' is-active' : ''}"><div class="proxy-card-head"><label class="node-check"><input type="checkbox" data-probe-select="${esc(p.id)}" ${selectedProbeIds.has(p.id) ? 'checked' : ''} ${probingNodes.has(p.id) || isSubscriptionNotice(p) ? 'disabled' : ''}/><span class="node-name" title="${esc(p.name)}">${esc(p.name)}</span></label>${assignmentBadge(p)}${probeSummary(p)}<span class="pill">${esc(p.protocol)}</span></div><div class="proxy-card-endpoint" title="${esc(`${p.server}:${p.port}`)}">${esc(p.server)}:${esc(p.port)}</div><div class="proxy-card-preview">${isSubscriptionNotice(p)?'订阅信息 · 不参与默认分配和检测':esc(preview)} · ${esc(checkedTime(p))}</div><div class="node-actions">${nodeActionButtons(p)}</div></article>`;
}

function nodeListRow(p) {
  const status = nodeConnectivity(p);
  return `<tr><td><input type="checkbox" aria-label="选择 ${esc(p.name)}" data-probe-select="${esc(p.id)}" ${selectedProbeIds.has(p.id) ? 'checked' : ''} ${probingNodes.has(p.id) || isSubscriptionNotice(p) ? 'disabled' : ''}/></td><td><div class="list-node-name" title="${esc(p.name)}">${esc(p.name)} ${assignmentBadge(p)}</div><span class="list-protocol">${esc(p.protocol)}</span></td><td class="${p.lastProbe?.error ? 'status-error' : p.lastProbe?.ip ? 'status-good' : ''}" title="${esc(p.lastProbe?.error || '')}">${esc(status)}<small>${esc(checkedTime(p))}</small></td><td class="${p.lastProbe?.error ? 'status-error' : p.lastProbe?.ip ? 'status-good' : ''}">${esc(nodeIp(p))}</td><td>${esc(nodeSpeed(p))}</td><td><div class="list-actions">${nodeActionButtons(p)}</div></td></tr>`;
}

function nodeTable(items) {
  return `<div class="proxy-table-wrap"><table class="proxy-table"><thead><tr><th aria-label="选择">选</th><th>节点 / 协议</th><th>连通性 / 延迟</th><th>出口 IP</th><th>下载速度</th><th>操作</th></tr></thead><tbody>${items.map(nodeListRow).join('')}</tbody></table></div>`;
}

function wireNodeActions(root) {
  root.querySelectorAll('[data-copy-proxy]').forEach(button => button.onclick = () => { const p = state.proxies.find(item => item.id === button.dataset.copyProxy); if (p) copyText(formatProxy(p)); });
  root.querySelectorAll('[data-copy-local]').forEach(button => button.onclick = () => { const bridge = bridgeFor(`pool-${button.dataset.copyLocal}`); if (bridge) copyText(formatBridge(bridge)); });
  root.querySelectorAll('[data-start-node]').forEach(button => button.onclick = () => startNodeBridge(button.dataset.startNode));
  root.querySelectorAll('[data-stop-node]').forEach(button => button.onclick = () => stopNodeBridge(button.dataset.stopNode));
  root.querySelectorAll('[data-check-node]').forEach(button => button.onclick = () => checkNodeBridge(button.dataset.checkNode));
  root.querySelectorAll('[data-probe-ip]').forEach(button => button.onclick = () => runNodeProbe(button.dataset.probeIp, 'ip'));
  root.querySelectorAll('[data-probe-speed]').forEach(button => button.onclick = () => runNodeProbe(button.dataset.probeSpeed, 'speed'));
  root.querySelectorAll('[data-assign-node]').forEach(button => button.onclick = () => openNodeAssignment(button.dataset.assignNode));
  root.querySelectorAll('[data-probe-select]').forEach(input => input.onchange = () => {
    if (input.checked) selectedProbeIds.add(input.dataset.probeSelect); else selectedProbeIds.delete(input.dataset.probeSelect);
    renderProxies();
  });
}

window.renderProxiesEnhanced = function () {
  const rows = filteredProxies();
  const groups = sourceGroups(rows);
  const searching = Boolean($('#proxy-search').value.trim());
  $('#proxy-count').textContent = `${rows.filter(p=>!isSubscriptionNotice(p)).length} / ${state.proxies.filter(p=>!isSubscriptionNotice(p)).length} 个节点 · ${rows.filter(isSubscriptionNotice).length} 条订阅信息 · ${state.bridges.length} 个端口已启用`;
  $('#proxy-empty').style.display = rows.length ? 'none' : 'block';
  $('#selected-proxy-count').textContent = `已选 ${selectedProbeIds.size} 个`;
  const selectableRows = rows.filter(p => !isSubscriptionNotice(p));
  const selectedVisible = selectableRows.filter(p => selectedProbeIds.has(p.id)).length;
  const selectAll = $('#select-all-proxies');
  selectAll.checked = selectableRows.length > 0 && selectedVisible === selectableRows.length;
  selectAll.indeterminate = selectedVisible > 0 && selectedVisible < selectableRows.length;
  selectAll.onchange = () => { selectableRows.forEach(p => selectAll.checked ? selectedProbeIds.add(p.id) : selectedProbeIds.delete(p.id)); renderProxies(); };
  $('#pool-view-cards').setAttribute('aria-pressed', String(poolViewMode === 'cards'));
  $('#pool-view-list').setAttribute('aria-pressed', String(poolViewMode === 'list'));
  const allCollapsed = groups.length > 0 && groups.every(group => collapsedSources.has(group.id));
  $('#collapse-sources').textContent = allCollapsed ? '展开全部订阅' : '收起全部订阅';
  const grid = $('#proxy-grid');
  grid.innerHTML = groups.map(group => {
    const collapsed = !searching && collapsedSources.has(group.id);
    const nodes=group.items.filter(p=>!isSubscriptionNotice(p));
    const notices=group.items.filter(isSubscriptionNotice);
    const selected = nodes.filter(p => selectedProbeIds.has(p.id)).length;
    const section=items=>poolViewMode === 'cards' ? `<div class="proxy-grid">${items.map(nodeCard).join('')}</div>` : nodeTable(items);
    const body = collapsed ? '' : `${nodes.length?section(nodes):''}${notices.length?`<details class="source-notices"><summary>订阅信息 · ${notices.length} 条</summary>${section(notices)}</details>`:''}`;
    return `<section class="proxy-source-group"><div class="proxy-source-heading"><button type="button" class="source-toggle" data-toggle-source="${esc(group.id)}" aria-expanded="${!collapsed}"><span class="source-chevron">${collapsed ? '▸' : '▾'}</span><strong title="${esc(group.name)}">${esc(group.name)}</strong><span>${nodes.length} 个节点${notices.length?` · ${notices.length} 条订阅信息`:''}</span></button><label class="source-select"><input type="checkbox" data-source-select="${esc(group.id)}" ${nodes.length&&selected===nodes.length?'checked':''} ${nodes.length?'':'disabled'}/>选中本组</label></div>${body}</section>`;
  }).join('');
  grid.querySelectorAll('[data-toggle-source]').forEach(button => button.onclick = () => {
    const id = button.dataset.toggleSource;
    if (collapsedSources.has(id)) collapsedSources.delete(id); else collapsedSources.add(id);
    persistCollapsed(); renderProxies();
  });
  grid.querySelectorAll('[data-source-select]').forEach(input => input.onchange = () => {
    const group = groups.find(item => item.id === input.dataset.sourceSelect);
    if (!group) return;
    group.items.filter(p=>!isSubscriptionNotice(p)).forEach(p => input.checked ? selectedProbeIds.add(p.id) : selectedProbeIds.delete(p.id));
    renderProxies();
  });
  grid.querySelectorAll('[data-source-select]').forEach(input => {
    const group = groups.find(item => item.id === input.dataset.sourceSelect);
    const nodes=group?.items.filter(p=>!isSubscriptionNotice(p))||[];
    const selected = nodes.filter(p => selectedProbeIds.has(p.id)).length;
    input.indeterminate = selected > 0 && selected < nodes.length;
  });
  wireNodeActions(grid);
};

function appPickerTrigger(app, p) {
  const label = p ? p.name : '暂不分配';
  const detail = p ? p.lastProbe?.ip || (p.lastProbe?.error ? '检测失败' : 'IP 待查') : '选择代理节点';
  const result = p?.lastProbe?.ip ? 'success' : p?.lastProbe?.error ? 'failed' : '';
  return `<button type="button" class="app-picker-trigger ${result}" data-app-picker="${esc(app.id)}" aria-label="为 ${esc(app.name)} 选择节点"><span class="picker-trigger-name" title="${esc(label)}">${esc(label)}</span><span class="picker-trigger-detail">${esc(detail)}</span><span class="picker-trigger-arrow">▾</span></button>`;
}

function appNodeInfo(p) {
  if (!p) return '<span class="muted">尚未分配节点</span>';
  return `<div class="app-node-info"><span title="出口 IP">IP <b>${esc(nodeIp(p))}</b></span><span title="延迟">延迟 <b>${esc(nodeDelay(p))}</b></span><span title="下载速度">下载 <b>${esc(nodeSpeed(p))}</b></span></div>`;
}

function appActions(app, p, bridge) {
  let actions = '';
  if (bridge || directExportable(p)) actions += `<button class="small-btn" data-copy-assigned="${esc(app.id)}">复制代理</button>`;
  if (bridge || nativeProbeable(p)) actions += `<button class="small-btn" data-probe-assigned="${esc(app.id)}">查出口 IP</button>`;
  if (bridgeable(p)) actions += `<button class="small-btn" data-bridge-app="${esc(app.id)}">${bridge ? '停止本地代理' : '启动本地代理'}</button>`;
  actions += `<button class="small-btn danger" data-delete-app="${esc(app.id)}">删除</button>`;
  return actions;
}

function appCard(app) {
  const p = state.proxies.find(item => item.id === app.proxyId);
  const bridge = bridgeFor(app.id);
  const status = bridge ? `本地端口 ${bridge.port} 已启用 · ${p?.lastProbe?.error?'最近检测失败':p?.lastProbe?.ip?'最近查到出口 IP':'出口 IP 待检测'}` : p ? bridgeable(p) ? '本地代理未启用' : directExportable(p) ? '原生代理 · 可直接复制' : '代理凭据不完整' : '选择节点后可分配';
  return `<article class="app-card"><div class="app-head"><div class="app-title">${esc(app.name)}</div></div><div class="app-desc">${esc(app.description || '独立代理分配')}</div>${appPickerTrigger(app, p)}${appNodeInfo(p)}<div class="app-status">${esc(status)}</div><div class="app-actions">${appActions(app, p, bridge)}</div></article>`;
}

function appListRow(app) {
  const p = state.proxies.find(item => item.id === app.proxyId);
  const bridge = bridgeFor(app.id);
  return `<tr><td><strong>${esc(app.name)}</strong><small>${esc(app.description || '')}</small></td><td>${appPickerTrigger(app, p)}</td><td class="${p?.lastProbe?.ip ? 'status-good' : p?.lastProbe?.error ? 'status-error' : ''}">${p ? esc(nodeIp(p)) : '—'}</td><td>${p ? esc(nodeDelay(p)) : '—'}</td><td>${p ? esc(nodeSpeed(p)) : '—'}</td><td>${bridge ? '本地端口已启用' : p ? bridgeable(p) ? '待启动' : directExportable(p) ? '可直接使用' : '不可导出' : '未分配'}</td><td><div class="list-actions">${appActions(app, p, bridge)}</div></td></tr>`;
}

window.renderAppsEnhanced = function () {
  const el = $('#app-list');
  $('#app-view-cards').setAttribute('aria-pressed', String(appViewMode === 'cards'));
  $('#app-view-list').setAttribute('aria-pressed', String(appViewMode === 'list'));
  el.className = appViewMode === 'cards' ? 'app-grid' : 'app-list-view';
  if (!state.apps.length) {
    el.innerHTML = '<div class="panel empty-state"><div class="empty-icon">▦</div><p>还没有应用</p><small>新建应用后即可选择节点</small></div>';
    return;
  }
  el.innerHTML = appViewMode === 'cards'
    ? state.apps.map(appCard).join('')
    : `<div class="app-table-wrap"><table class="app-table"><thead><tr><th>应用</th><th>分配节点</th><th>出口 IP</th><th>延迟</th><th>下载速度</th><th>状态</th><th>操作</th></tr></thead><tbody>${state.apps.map(appListRow).join('')}</tbody></table></div>`;
  el.querySelectorAll('[data-app-picker]').forEach(button => button.onclick = () => openAppPicker(button.dataset.appPicker));
  el.querySelectorAll('[data-copy-assigned]').forEach(button => button.onclick = () => {
    const app = state.apps.find(item => item.id === button.dataset.copyAssigned);
    const bridge = bridgeFor(app?.id);
    const p = state.proxies.find(item => item.id === app?.proxyId);
    if (bridge) copyText(formatBridge(bridge)); else if (directExportable(p)) copyText(formatProxy(p));
  });
  el.querySelectorAll('[data-bridge-app]').forEach(button => button.onclick = () => bridgeFor(button.dataset.bridgeApp) ? stopAppBridge(button.dataset.bridgeApp) : startAppBridge(button.dataset.bridgeApp));
  el.querySelectorAll('[data-probe-assigned]').forEach(button => button.onclick = () => {const app=state.apps.find(item=>item.id===button.dataset.probeAssigned);if(app?.proxyId)runNodeProbe(app.proxyId,'ip');});
  el.querySelectorAll('[data-delete-app]').forEach(button => button.onclick = async () => {
    const id = button.dataset.deleteApp;
    if (bridgeFor(id)) await stopAppBridge(id);
    state.apps = state.apps.filter(app => app.id !== id);
    await save();
  });
};

let pickingForAppId = '';
function renderAppPickerChoices() {
  const app = state.apps.find(item => item.id === pickingForAppId);
  if (!app) return;
  const query = $('#app-picker-search').value.trim().toLowerCase();
  const sourceId=$('#app-picker-source').value;
  const successOnly=$('#app-picker-success-only').checked;
  const assignable=state.proxies.filter(p=>!isSubscriptionNotice(p)&&(bridgeable(p)||directExportable(p)));
  const matches = assignable.filter(p => (!sourceId || (p.sourceIds||[p.sourceId]).includes(sourceId)) && (!successOnly || p.lastProbe?.ip) && (!query || [p.name, p.protocol, p.sourceName, p.server, p.lastProbe?.ip].join(' ').toLowerCase().includes(query)));
  const groups = sourceGroups(matches);
  $('#app-picker-count').textContent = `找到 ${matches.length} / ${assignable.length} 个可分配节点 · 绿色表示曾查到出口 IP，使用前仍可重测`;
  const clear = !query ? `<button type="button" class="picker-node clear-choice" data-pick-node="" ${!app.proxyId ? 'aria-current="true"' : ''}><span class="picker-name">暂不分配</span><span class="picker-hint">清除当前应用的节点</span></button>` : '';
  $('#app-picker-results').innerHTML = clear + (matches.length ? groups.map(group => `<section class="picker-group"><h4>${esc(group.name)} <span>${group.items.length}</span></h4>${group.items.sort((a,b)=>probeRank(a)-probeRank(b)||a.name.localeCompare(b.name,'zh-CN')).map(p => {
    const result = p.lastProbe?.ip ? 'success' : p.lastProbe?.error ? 'failed' : '';
    const status = p.lastProbe?.ip ? 'IP 已查到' : p.lastProbe?.error ? '检测失败' : '未检测';
    const used=assignedApps(p).filter(a=>a.id!==app.id);
    return `<button type="button" class="picker-node ${result}" data-pick-node="${esc(p.id)}" ${p.id === app.proxyId ? 'aria-current="true"' : ''} title="检测时间：${esc(checkedTime(p))}${used.length?` · 已分配给 ${esc(used.map(a=>a.name).join('、'))}`:''}"><span class="picker-name" title="${esc(p.name)}">${esc(p.name)}<small>${esc(p.protocol)}</small>${p.id===app.proxyId?'<small class="picker-used">当前应用</small>':used.length?`<small class="picker-used">已分配 ${used.length}</small>`:''}</span><span class="picker-status">${status}</span><span class="picker-ip">${esc(p.lastProbe?.ip || '—')}</span><span>${esc(nodeDelay(p))}</span><span>${esc(nodeSpeed(p))}</span></button>`;
  }).join('')}</section>`).join('') : '<p class="picker-empty">没有匹配的节点</p>');
}
function openAppPicker(appId) {
  const app = state.apps.find(item => item.id === appId);
  if (!app) return;
  pickingForAppId = appId;
  $('#app-picker-title').textContent = `为 ${app.name} 选择代理节点`;
  $('#app-picker-search').value = '';
  $('#app-picker-success-only').checked=false;
  $('#app-picker-source').innerHTML='<option value="">全部订阅</option>'+state.sources.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  renderAppPickerChoices();
  $('#app-picker-modal').classList.remove('hidden');
  $('#app-picker-search').focus();
}
function closeAppPicker() { pickingForAppId = ''; $('#app-picker-modal').classList.add('hidden'); }
async function assignAppProxy(app, proxyId) {
  if (app.proxyId === proxyId) return;
  const proxy=state.proxies.find(p=>p.id===proxyId);
  if(proxy && isSubscriptionNotice(proxy))throw new Error('订阅信息不能分配给应用');
  if(proxy && !bridgeable(proxy) && !directExportable(proxy))throw new Error('节点尚不能转换为目标应用可用的代理');
  if(proxy && bridgeable(proxy) && !proxy.rawLine)throw new Error('节点缺少转换配置，请重新解析订阅');
  const previousId=app.proxyId;
  const oldBridge = bridgeFor(app.id);
  if(proxy && bridgeable(proxy))await bridgeRequest('/api/bridge/start',{appId:app.id,name:proxy.name,rawLine:proxy.rawLine});
  app.proxyId = proxyId;
  try{await save();}catch(error){
    app.proxyId=previousId;
    if(oldBridge){const old=state.proxies.find(p=>p.id===previousId);if(old?.rawLine)await bridgeRequest('/api/bridge/start',{appId:app.id,name:old.name,rawLine:old.rawLine});}
    else if(proxy && bridgeable(proxy))await bridgeRequest('/api/bridge/stop',{appId:app.id});
    await reloadBridges();
    throw error;
  }
  if(oldBridge && (!proxy || !bridgeable(proxy)))await bridgeRequest('/api/bridge/stop',{appId:app.id});
  await reloadBridges();
}
$('#app-picker-search').oninput = renderAppPickerChoices;
$('#app-picker-source').onchange = renderAppPickerChoices;
$('#app-picker-success-only').onchange = renderAppPickerChoices;
$('#app-picker-results').onclick = async event => {
  const choice = event.target.closest('[data-pick-node]');
  if (!choice) return;
  const app = state.apps.find(item => item.id === pickingForAppId);
  if (!app) return;
  try { await assignAppProxy(app, choice.dataset.pickNode); closeAppPicker(); const p=state.proxies.find(item=>item.id===choice.dataset.pickNode); toast(p?bridgeable(p)?'应用分配已保存，本地端口已启用；请查出口 IP':'应用分配已保存，可复制原生代理':'应用分配已清除'); }
  catch (error) { closeAppPicker(); renderApps(); toast(`分配后代理未就绪：${error.message}`); }
};
$('#close-app-picker').onclick = closeAppPicker;
$('#cancel-app-picker').onclick = closeAppPicker;
$('#app-picker-modal').onclick = event => { if (event.target.id === 'app-picker-modal') closeAppPicker(); };
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#app-picker-modal').classList.contains('hidden')) closeAppPicker(); });

let assigningNodeId = '';
function openNodeAssignment(id) {
  const p = state.proxies.find(item => item.id === id);
  if (!p) return;
  if (!state.apps.length) { go('apps'); openAppModal(); toast('请先创建应用，再选择节点'); return; }
  assigningNodeId = id;
  $('#assign-node-name').textContent = p.name;
  $('#assign-node-metrics').textContent = `出口 ${nodeIp(p)} · ${nodeDelay(p)} · ${nodeSpeed(p)}`;
  $('#assign-app-target').innerHTML = state.apps.map(app => `<option value="${esc(app.id)}">${esc(app.name)}</option>`).join('');
  $('#assign-node-modal').classList.remove('hidden');
}
function closeNodeAssignment() { assigningNodeId = ''; $('#assign-node-modal').classList.add('hidden'); }
$('#close-assign-modal').onclick = closeNodeAssignment;
$('#cancel-assign-modal').onclick = closeNodeAssignment;
$('#assign-node-modal').onclick = event => { if (event.target.id === 'assign-node-modal') closeNodeAssignment(); };
$('#confirm-assign-node').onclick = async () => {
  const app = state.apps.find(item => item.id === $('#assign-app-target').value);
  if (!app || !assigningNodeId) return;
  try { await assignAppProxy(app, assigningNodeId); const p=state.proxies.find(item=>item.id===assigningNodeId); closeNodeAssignment(); go('apps'); toast(bridgeable(p)?'节点已分配，本地端口已启用；请查出口 IP':'节点已分配，可复制原生代理'); }
  catch (error) { closeNodeAssignment(); go('apps'); toast(`分配后代理未就绪：${error.message}`); }
};
$('#pool-view-cards').onclick = () => { poolViewMode = 'cards'; localStorage.setItem('pd_pool_view', poolViewMode); renderProxies(); };
$('#pool-view-list').onclick = () => { poolViewMode = 'list'; localStorage.setItem('pd_pool_view', poolViewMode); renderProxies(); };
$('#app-view-cards').onclick = () => { appViewMode = 'cards'; localStorage.setItem('pd_app_view', appViewMode); renderApps(); };
$('#app-view-list').onclick = () => { appViewMode = 'list'; localStorage.setItem('pd_app_view', appViewMode); renderApps(); };
$('#collapse-sources').onclick = () => {
  const groups = sourceGroups(filteredProxies());
  const allCollapsed = groups.every(group => collapsedSources.has(group.id));
  groups.forEach(group => allCollapsed ? collapsedSources.delete(group.id) : collapsedSources.add(group.id));
  persistCollapsed(); renderProxies();
};
renderProxies();
renderApps();
