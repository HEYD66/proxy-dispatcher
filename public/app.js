const isServerMode = document.body.dataset.serverMode === '1';
if (isServerMode) ['pd_sources', 'pd_proxies', 'pd_apps'].forEach(key => localStorage.removeItem(key));
const state = { sources: isServerMode ? [] : JSON.parse(localStorage.getItem('pd_sources') || '[]'), proxies: isServerMode ? [] : JSON.parse(localStorage.getItem('pd_proxies') || '[]'), apps: isServerMode ? [] : JSON.parse(localStorage.getItem('pd_apps') || '[]'), bridges: [], format: 'hostportuserpass' };
const $ = (s) => document.querySelector(s);
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  const method = String(init.method || input?.method || 'GET').toUpperCase();
  if (url.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('X-Requested-With', 'ProxyDispatcher');
    init = { ...init, headers };
  }
  const response = await nativeFetch(input, init);
  if (isServerMode && url.startsWith('/api/') && response.status === 401) {
    location.replace('/login');
    throw new Error('登录已过期，请重新登录');
  }
  return response;
};
const esc = (s='') => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
let saveQueue = Promise.resolve();
const save = () => { const snapshot=JSON.parse(JSON.stringify({sources:state.sources,proxies:state.proxies,apps:state.apps})); if(!isServerMode){localStorage.setItem('pd_sources', JSON.stringify(snapshot.sources)); localStorage.setItem('pd_proxies', JSON.stringify(snapshot.proxies)); localStorage.setItem('pd_apps', JSON.stringify(snapshot.apps));} renderAll(); const task=saveQueue.then(async()=>{const response=await fetch('/api/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot)});if(!response.ok)throw new Error((await response.json()).error||'服务端保存失败');});saveQueue=task.catch(error=>toast(error.message));return task; };
const toast = (message) => { const el=$('#toast'); el.textContent=message; el.classList.add('show'); clearTimeout(window.__toast); window.__toast=setTimeout(()=>el.classList.remove('show'),2200); };
const bridgeProtocols = new Set(['ss','ssr','vmess','vless','trojan','anytls','hysteria','hysteria2','tuic','snell','wireguard','ssh']);
const bridgeable = (p) => Boolean(p && bridgeProtocols.has(p.protocol));
const hasCredentials = (p) => Boolean(String(p?.username||'').trim() && String(p?.password||'').trim());
const directExportable = (p) => Boolean(p?.server && p?.port && hasCredentials(p) && ['http','https','socks','socks5'].includes(p.protocol));
const nativeProbeable = (p) => Boolean(p?.server && p?.port && ['http','https','socks','socks5'].includes(p.protocol));
const isSubscriptionNotice = p => /^(剩余流量|套餐到期|到期时间|距离下次重置|建议每天更新|如果很少节点可用|流量剩余|官网|更新订阅)/i.test(String(p?.name || '').trim());
const bridgeFor = (appId) => state.bridges.find(b => b.appId === appId);
async function bridgeRequest(path, payload){ const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}); const data=await response.json(); if(!response.ok) throw new Error(data.error||'本地代理操作失败'); return data; }
async function reloadBridges(){const response=await fetch('/api/bridges');if(!response.ok)throw new Error('读取活动端口失败');state.bridges=(await response.json()).bridges;renderAll();}
async function stopMissingBridges(){try{for(const b of state.bridges){const keep=b.appId.startsWith('pool-')?state.proxies.some(p=>`pool-${p.id}`===b.appId):state.apps.some(a=>a.id===b.appId&&state.proxies.some(p=>p.id===a.proxyId));if(!keep)await bridgeRequest('/api/bridge/stop',{appId:b.appId});}await reloadBridges();}catch(error){toast(`清理旧端口失败：${error.message}`);}}
async function startAppBridge(appId){ const app=state.apps.find(a=>a.id===appId); const proxy=state.proxies.find(p=>p.id===app?.proxyId); if(!app||!proxy)return toast('请先选择节点'); if(!bridgeable(proxy))return toast('HTTP/SOCKS 节点可直接复制，无需本地转换'); if(!proxy.rawLine)return toast('此节点是旧数据，请先在订阅源页面点击重新解析'); try{ const bridge=await bridgeRequest('/api/bridge/start',{appId,name:proxy.name,rawLine:proxy.rawLine}); await reloadBridges(); toast(`已启动本地代理 127.0.0.1:${bridge.port}`); }catch(e){toast(e.message);} }
async function stopAppBridge(appId){ try{await bridgeRequest('/api/bridge/stop',{appId});await reloadBridges();toast('本地代理已停止');}catch(e){toast(e.message);} }
function formatBridge(b, format=state.format){ return formatProxy({server:b.host||'127.0.0.1',port:b.port,username:b.username,password:b.password},format); }
async function startProxyPool(){ const nodes=filteredProxies().filter(p=>!isSubscriptionNotice(p)&&bridgeable(p)&&p.rawLine); if(!nodes.length)return toast('当前没有可转换的协议节点，请先重新解析订阅'); const button=$('#pool-start');if(button){button.disabled=true;button.textContent='批量启用中…';} try{const result=await bridgeRequest('/api/bridge/pool/start',{items:nodes.map(p=>({id:p.id,name:p.name,rawLine:p.rawLine}))});await reloadBridges();const copied=await copyText(result.bridges.map(b=>formatBridge(b)).join('\n'));toast(`已启用 ${result.bridges.length} 个本地端口${copied?'，已复制代理行':'；复制失败，请逐条复制'}。使用前请测试出口`);}catch(e){toast(e.message);}finally{if(button){button.disabled=false;button.textContent='启用筛选节点';}} }
async function stopProxyPool(){try{const result=await bridgeRequest('/api/bridge/pool/stop',{});await reloadBridges();toast(`已停止 ${result.stopped} 个本地端口`);}catch(e){toast(e.message);}}
function go(view){ document.querySelectorAll('.view').forEach(el=>el.classList.toggle('active-view',el.id===`view-${view}`)); document.querySelectorAll('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.view===view)); }
document.querySelectorAll('.nav-item').forEach(el=>el.addEventListener('click',()=>go(el.dataset.view))); document.querySelectorAll('[data-jump]').forEach(el=>el.addEventListener('click',()=>go(el.dataset.jump)));

function decodeBase64(input){ const compact=input.replace(/\s+/g,''); if(!/^[A-Za-z0-9+/=_-]+$/.test(compact) || compact.length<12) return ''; try { const normalized=compact.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(compact.length/4)*4,'='); return decodeURIComponent(escape(atob(normalized))); } catch { try{return atob(compact)}catch{return ''} } }
function flowLine(fields){const ordered={name:fields.name||fields.server};for(const [key,value] of Object.entries(fields)){if(key!=='name'&&value!==undefined&&value!==null)ordered[key]=value;}return `- {${Object.entries(ordered).map(([key,value])=>`${key}: ${JSON.stringify(value)}`).join(', ')}}`;}
function cleanName(name, fallback='未命名节点'){ return String(name||fallback).replace(/^\[|\]$/g,'').trim() || fallback; }
function addProxy(list, p, source){ if(!p || !p.server || !p.port) return; const server=String(p.server).trim().replaceAll('\\.','.'); const port=Number(p.port); if(!server || !Number.isInteger(port)||port<1||port>65535) return; const protocol=String(p.protocol||'http').toLowerCase(); const rawLine=p.rawLine||''; const key=rawLine?`${protocol}|${rawLine}`:`${protocol}|${server}|${port}|${p.username||''}|${p.password||''}`; if(list.some(x=>x.key===key)) return; list.push({id:uid(),key,name:cleanName(p.name,`${protocol} · ${server}`),protocol,server,port,username:String(p.username||''),password:String(p.password||''),rawLine,sourceId:source.id,sourceIds:[source.id],sourceName:source.name}); }
function mergeParsed(source, parsed){const existing=new Map(state.proxies.map(p=>[p.key,p]));for(const p of parsed){const old=existing.get(p.key);if(old){old.sourceIds=[...new Set([...(old.sourceIds||[old.sourceId]),source.id])];p.id=old.id;}else{existing.set(p.key,p);state.proxies.push(p);}}}
function detachSource(id){state.proxies=state.proxies.filter(p=>{p.sourceIds=(p.sourceIds||[p.sourceId]).filter(sourceId=>sourceId!==id);if(!p.sourceIds.length)return false;if(p.sourceId===id){p.sourceId=p.sourceIds[0];p.sourceName=state.sources.find(s=>s.id===p.sourceId)?.name||p.sourceName;}return true;});}
function decodeShortBase64(value){try{return decodeURIComponent(escape(atob(value.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(value.length/4)*4,'='))));}catch{return '';}}
function parseExtraUri(raw,source,list){
  const scheme=raw.slice(0,raw.indexOf(':')).toLowerCase();
  if(!['tuic','hysteria','ssh','ssr'].includes(scheme))return false;
  try{
    if(scheme==='ssr'){
      const decoded=decodeShortBase64(raw.slice(6));
      const [body,query='']=decoded.split('/?');
      const match=body.match(/^(.+):(\d+):([^:]+):([^:]+):([^:]+):([^:]+)$/);
      if(!match)return false;
      const params=new URLSearchParams(query),name=decodeShortBase64(params.get('remarks')||'')||match[1];
      const fields={name,server:match[1],port:Number(match[2]),type:'ssr',cipher:match[4],password:decodeShortBase64(match[6]),obfs:match[5],protocol:match[3],udp:true};
      if(params.get('obfsparam'))fields['obfs-param']=decodeShortBase64(params.get('obfsparam'));
      if(params.get('protoparam'))fields['protocol-param']=decodeShortBase64(params.get('protoparam'));
      addProxy(list,{protocol:'ssr',name,server:fields.server,port:fields.port,rawLine:flowLine(fields)},source);return true;
    }
    const u=new URL(raw),q=u.searchParams,name=decodeURIComponent(u.hash.slice(1)||'')||u.hostname;
    const server=u.hostname,port=Number(u.port||(scheme==='ssh'?22:443));
    const user=decodeURIComponent(u.username||''),password=decodeURIComponent(u.password||'');
    const insecure=['1','true'].includes((q.get('insecure')||q.get('allowInsecure')||'').toLowerCase());
    let fields;
    if(scheme==='tuic')fields={name,server,port,type:'tuic',uuid:user,password,'skip-cert-verify':insecure,sni:q.get('sni')||undefined,'congestion-controller':q.get('congestion_control')||undefined,'udp-relay-mode':q.get('udp_relay_mode')||undefined,udp:true};
    else if(scheme==='hysteria')fields={name,server,port,type:'hysteria','auth-str':q.get('auth')||q.get('auth-str')||user||password,protocol:q.get('protocol')||'udp',sni:q.get('sni')||undefined,'skip-cert-verify':insecure,up:q.get('upmbps')||q.get('up')||undefined,down:q.get('downmbps')||q.get('down')||undefined,udp:true};
    else fields={name,server,port,type:'ssh',username:user,password};
    addProxy(list,{protocol:scheme,name,server,port,username:user,password,rawLine:flowLine(fields)},source);return true;
  }catch{return false;}
}
function parseUri(line, source, list){const raw=line.trim();if(!/^(ss|vmess|vless|trojan|anytls|hysteria2|hy2|http|https|socks|socks5):\/\//i.test(raw))return false;try{const protocol=raw.slice(0,raw.indexOf(':')).toLowerCase();if(protocol==='vmess'){const obj=JSON.parse(decodeBase64(raw.slice(8).split('#')[0]));const name=obj.ps||obj.add;const fields={name,server:obj.add,port:Number(obj.port),type:'vmess',uuid:obj.id,alterId:Number(obj.aid||0),cipher:obj.scy||'auto',tls:obj.tls==='tls'||obj.tls===true,network:obj.net||'tcp',servername:obj.sni||undefined,udp:true};if(fields.network==='ws')fields['ws-opts']={path:obj.path||'/',headers:obj.host?{Host:obj.host}:{}};addProxy(list,{protocol,name,server:obj.add,port:obj.port,username:obj.id,rawLine:flowLine(fields)},source);return true;}let u=new URL(raw);let name=decodeURIComponent(u.hash.slice(1)||'')||u.hostname;if(protocol==='ss'){if(!raw.slice(5).split('#')[0].includes('@')){const decoded=decodeBase64(raw.slice(5).split('#')[0]);if(!decoded)return false;u=new URL(`ss://${decoded}`);}let auth=decodeURIComponent(u.username||'');let method='',password='';if(u.password){method=auth;password=decodeURIComponent(u.password);}else{const decoded=decodeBase64(auth)||auth;const colon=decoded.indexOf(':');if(colon<0)return false;method=decoded.slice(0,colon);password=decoded.slice(colon+1);}addProxy(list,{protocol,name,server:u.hostname,port:u.port,username:method,password,rawLine:flowLine({name,server:u.hostname,port:Number(u.port),type:'ss',cipher:method,password,udp:true})},source);return true;}const user=decodeURIComponent(u.username||'');const pass=decodeURIComponent(u.password||'');if(protocol==='anytls'){const q=u.searchParams;const fields={name,server:u.hostname,port:Number(u.port||443),type:'anytls',password:user||pass,'skip-cert-verify':['1','true'].includes((q.get('insecure')||q.get('allowInsecure')||'').toLowerCase()),servername:q.get('sni')||undefined,'client-fingerprint':q.get('fp')||'chrome',udp:true};addProxy(list,{protocol:'anytls',name,server:u.hostname,port:Number(u.port||443),username:'',password:user||pass,rawLine:flowLine(fields)},source);return true;}if(protocol==='hysteria2'||protocol==='hy2'){const q=u.searchParams;const fields={name,server:u.hostname,port:Number(u.port||443),type:'hysteria2',password:user||pass,'skip-cert-verify':['1','true'].includes((q.get('insecure')||'').toLowerCase()),servername:q.get('sni')||undefined,udp:true};if(q.get('obfs')){fields.obfs=q.get('obfs');fields['obfs-password']=q.get('obfs-password')||user||pass;}addProxy(list,{protocol:'hysteria2',name,server:u.hostname,port:Number(u.port||443),username:'',password:user||pass,rawLine:flowLine(fields)},source);return true;}if(protocol==='vless'||protocol==='trojan'){const q=u.searchParams;const network=q.get('type')||'tcp';const fields={name,server:u.hostname,port:Number(u.port),type:protocol,tls:protocol==='trojan'||['tls','reality'].includes(q.get('security')),servername:q.get('sni')||q.get('serverName')||undefined,network,udp:true};if(protocol==='vless')fields.uuid=user;else fields.password=user||pass;if(network==='ws')fields['ws-opts']={path:q.get('path')||'/',headers:q.get('host')?{Host:q.get('host')}:{}};if(q.get('security')==='reality'){fields['reality-opts']={'public-key':q.get('pbk')||'', 'short-id':q.get('sid')||''};fields['client-fingerprint']=q.get('fp')||'chrome';}addProxy(list,{protocol,name,server:u.hostname,port:u.port,username:user,password:pass,rawLine:flowLine(fields)},source);return true;}addProxy(list,{protocol,name,server:u.hostname,port:u.port,username:user,password:pass},source);return true;}catch{return false;}}
function parseLoose(line, source, list){ const text=line.trim().replace(/^[-*]\s*/,'').replace(/^['"]|['"]$/g,''); if(!text || text.startsWith('#') || text.startsWith('//')) return false; if(parseExtraUri(text,source,list)||parseUri(text,source,list)) return true; let m=text.match(/^([^:@\s]+):(\d{2,5}):([^:@\s]*):(.+)$/); if(m){const server=m[1].replaceAll('\\.','.');const isCipher=/^(aes-|chacha|xchacha|none|2022-)/i.test(m[3]);addProxy(list,{protocol:isCipher?'ss':'http',server,port:m[2],username:m[3],password:m[4],rawLine:isCipher?flowLine({name:server,server,port:m[2],type:'ss',cipher:m[3],password:m[4]}):''},source);return true;} m=text.match(/^([^:@\s]+):(\d{2,5})@([^:]+):(.+)$/); if(m){addProxy(list,{protocol:'http',server:m[1],port:m[2],username:m[3],password:m[4]},source);return true;} return false; }
function splitFlowMap(text){ const parts=[]; let start=0, depth=0, quote=''; for(let i=0;i<text.length;i++){ const ch=text[i]; if(quote){ if(ch===quote && text[i-1]!=='\\') quote=''; continue; } if(ch==='"'||ch==="'"){quote=ch;continue;} if(ch==='{') depth++; else if(ch==='}') depth--; else if(ch===','&&depth===0){parts.push(text.slice(start,i));start=i+1;} } parts.push(text.slice(start)); return parts; }
function parseInlineYamlMap(line){ const body=line.trim().replace(/^[-]\s*/,'').replace(/^\{/, '').replace(/\}\s*$/, ''); const obj={}; for(const part of splitFlowMap(body)){ const match=part.trim().match(/^([\w-]+)\s*:\s*(.*)$/); if(!match) continue; let [,key,value]=match; value=value.trim().replace(/^['"]|['"]$/g,''); obj[key]=value; } return obj; }
function addConfiguredProxy(p,source,list){if(!p||typeof p!=='object'||Array.isArray(p))return;const protocol=String(p.type||p.protocol||'').toLowerCase();const server=p.server||p.address||p.peers?.[0]?.server;const port=Number(p.port||p.server_port||p.peers?.[0]?.port);if(!protocol||!server||!port)return;const fields={...p,name:p.name||p.tag||server,server:p.server||server,port:p.port||port,type:protocol};if(!p.type)delete fields.protocol;delete fields.address;delete fields.server_port;delete fields.tag;if(protocol==='wireguard'&&Array.isArray(p.peers)){delete fields.server;delete fields.port;}addProxy(list,{protocol,name:fields.name,server,port,username:p.username||p.uuid||'',password:p.password||'',rawLine:bridgeProtocols.has(protocol)?flowLine(fields):''},source);}
function parseYaml(text,source,list){if(!window.jsyaml)return false;try{const document=window.jsyaml.load(text,{maxDepth:100});const entries=Array.isArray(document)?document:document?.proxies;if(!Array.isArray(entries))return false;entries.forEach(p=>addConfiguredProxy(p,source,list));return list.length>0;}catch{return false;}}
function parseContent(content, source){const list=[];let text=String(content||'').trim().replace(/^\uFEFF/,'');if(!text)return list;try{const obj=JSON.parse(text);const arr=obj.proxies||obj.outbounds||obj;if(Array.isArray(arr))arr.forEach(p=>addConfiguredProxy(p,source,list));else if(obj.server)addConfiguredProxy(obj,source,list);}catch{}if(!list.length&&/(^|\n)\s*proxies\s*:/i.test(text))parseYaml(text,source,list);if(!list.length){const decoded=decodeBase64(text);if(decoded&&decoded!==text&&(decoded.includes('://')||decoded.includes('proxies:')))return parseContent(decoded,source);text.split(/\r?\n|\s*,\s*/).forEach(line=>parseLoose(line,source,list));}return list;}
function formatProxy(p, format=state.format){ const u=p.username||'', pw=p.password||'', h=p.server, port=p.port; if(format==='userpasshostport') return `${u}:${pw}:${h}:${port}`; if(format==='userpass-at') return `${u}:${pw}@${h}:${port}`; if(format==='hostport-at') return `${h}:${port}@${u}:${pw}`; return `${h}:${port}:${u}:${pw}`; }
async function importSource(){const name=$('#source-name').value.trim()||`订阅 ${state.sources.length+1}`;const urls=$('#source-url').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);const pasted=$('#source-content').value.trim();$('#modal-error').textContent='';if(!urls.length&&!pasted){$('#modal-error').textContent='请输入订阅链接或配置内容';return;}const button=$('#save-source');button.disabled=true;button.textContent='导入中…';let imported=0;let nodes=0;const failures=[];const failedUrls=[];async function addOne(label,url,content){const source={id:uid(),name:label,url:url||'本地粘贴',createdAt:new Date().toISOString()};const parsed=parseContent(content,source);if(!parsed.length)throw new Error('没有识别到节点');state.sources.unshift({...source,nodeCount:parsed.length});mergeParsed(source,parsed);imported++;nodes+=parsed.length;}try{for(let i=0;i<urls.length;i++){try{const response=await fetch(`/api/fetch?url=${encodeURIComponent(urls[i])}`);const data=await response.json();if(!response.ok)throw new Error(data.error||'订阅请求失败');await addOne(urls.length>1?`${name} ${i+1}`:name,urls[i],data.text);}catch(error){failures.push(`第 ${i+1} 条：${error.message}`);failedUrls.push(urls[i]);}}if(pasted){try{await addOne(urls.length?`${name} 本地`:name,'',pasted);}catch(error){failures.push(`粘贴内容：${error.message}`);}}if(imported)await save();if(failures.length){$('#source-url').value=failedUrls.join('\n');if(imported)$('#source-content').value='';$('#modal-error').textContent=`成功 ${imported} 条、失败 ${failures.length} 条；${failures.slice(0,2).join('；')}`;}else{closeModal();go('sources');toast(`已导入 ${imported} 个来源、${nodes} 个节点`);}}catch(error){$('#modal-error').textContent=error.message;}finally{button.disabled=false;button.innerHTML='导入并解析 <span>→</span>';}}
function renderOverview(){
  const nodes=state.proxies.filter(p=>!isSubscriptionNotice(p));
  const found=nodes.filter(p=>p.lastProbe?.ip).length;
  const assigned=state.apps.filter(a=>a.proxyId).length;
  $('#stat-sources').textContent=state.sources.length;
  $('#stat-proxies').textContent=nodes.length;
  $('#stat-proxies-note').textContent=nodes.length?`其中 ${found} 个已查到出口 IP`:'等待导入';
  $('#stat-assigned').textContent=assigned;
  $('#stat-status').textContent=nodes.length?`${found} / ${nodes.length}`:'READY';
  $('#last-sync').textContent=state.sources.length?`最近更新 ${new Date(state.sources[0].updatedAt||state.sources[0].createdAt||Date.now()).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}`:'尚未导入订阅';
  const el=$('#recent-sources');
  if(!state.sources.length){el.innerHTML='<div class="empty-icon">↥</div><p>还没有订阅源</p><small>添加链接或粘贴配置文本开始</small>';return;}
  el.innerHTML=state.sources.slice(0,3).map(s=>`<div class="recent-row"><span>${esc(s.name)}</span><b>${s.nodeCount||0}</b></div>`).join('');
  $('#overview-task-title').textContent='当前待办';
  const unassigned=state.apps.filter(a=>!a.proxyId).length;
  const failed=nodes.filter(p=>p.lastProbe?.error).length;
  const recent=nodes.map(p=>p.lastProbe?.checkedAt).filter(Boolean).sort().at(-1);
  $('#overview-task-list').innerHTML=`<div class="guide"><b>✓</b><div><strong>${found} 个节点已查到出口 IP</strong><span>${nodes.length-found-failed} 个未检测，${failed} 个检测失败</span></div></div><div class="guide"><b>▦</b><div><strong>${assigned} 个应用已分配</strong><span>${unassigned} 个应用待选择节点 · ${state.bridges.length} 个本地端口已启用</span></div></div><div class="guide"><b>◷</b><div><strong>最近检测</strong><span>${recent?esc(new Date(recent).toLocaleString('zh-CN')):'尚未检测'}</span></div></div>`;
}
async function refreshSource(id){ const source=state.sources.find(s=>s.id===id); if(!source?.url || source.url==='本地粘贴') return; const button=document.querySelector(`[data-refresh="${id}"]`); if(button){button.disabled=true;button.textContent='解析中…';} try{const response=await fetch(`/api/fetch?url=${encodeURIComponent(source.url)}`);const data=await response.json();if(!response.ok)throw new Error(data.error||'订阅请求失败');const parsed=parseContent(data.text,source);if(!parsed.length)throw new Error('没有识别到节点');const previous=state.proxies.filter(p=>(p.sourceIds||[p.sourceId]).includes(id));const used=new Set();const nameKey=p=>`${p.protocol}|${String(p.name).replace(/[+\s]+/g,'').toLowerCase()}`;const identity=p=>`${p.server}|${p.port}|${nameKey(p)}`;detachSource(id);for(const p of parsed){const old=previous.find(x=>!used.has(x.id)&&x.key===p.key)||previous.find(x=>!used.has(x.id)&&identity(x)===identity(p))||previous.find(x=>!used.has(x.id)&&nameKey(x)===nameKey(p)&&previous.filter(y=>nameKey(y)===nameKey(p)).length===1&&parsed.filter(y=>nameKey(y)===nameKey(p)).length===1);if(old){used.add(old.id);p.id=old.id;if(old.lastProbe&&old.server===p.server&&old.port===p.port&&old.username===p.username&&old.password===p.password)p.lastProbe=old.lastProbe;}}mergeParsed(source,parsed);source.nodeCount=parsed.length;source.updatedAt=new Date().toISOString();state.apps.forEach(a=>{if(!state.proxies.some(p=>p.id===a.proxyId))a.proxyId='';});await save();await stopMissingBridges();toast(`已重新解析 ${parsed.length} 个节点`);}catch(error){if(button){button.disabled=false;button.textContent='重新解析';}toast(`重新解析失败：${error.message}`);} }
function renderSources(){ const el=$('#source-list'); if(!state.sources.length){el.innerHTML='<div class="panel empty-state"><div class="empty-icon">↥</div><p>还没有订阅源</p><small>添加链接或粘贴配置内容开始</small></div>';return;} el.innerHTML=state.sources.map(s=>`<div class="source-card"><div class="source-main"><div class="source-icon">↥</div><div><div class="source-name">${esc(s.name)}</div><div class="source-url">${esc(s.url)}</div></div></div><div class="source-meta"><strong>${s.nodeCount||0}</strong><span>个节点</span></div><div class="source-actions">${s.url!=='本地粘贴'?`<button class="small-btn" data-refresh="${s.id}">重新解析</button>`:''}<button class="small-btn danger" data-delete-source="${s.id}">删除</button></div></div>`).join(''); el.querySelectorAll('[data-delete-source]').forEach(b=>b.onclick=()=>{const id=b.dataset.deleteSource;state.sources=state.sources.filter(s=>s.id!==id);detachSource(id);state.apps.forEach(a=>{if(!state.proxies.some(p=>p.id===a.proxyId))a.proxyId='';});save();stopMissingBridges();toast('已删除订阅源及其节点');}); el.querySelectorAll('[data-refresh]').forEach(b=>b.onclick=()=>refreshSource(b.dataset.refresh)); }
let availableOnly = localStorage.getItem('pd_available_only') === '1';
function filteredProxies(){const q=$('#proxy-search').value.trim().toLowerCase();return state.proxies.filter(p=>(!availableOnly || (!isSubscriptionNotice(p) && p.lastProbe?.ip && !p.lastProbe?.error)) && (!q || [p.name,p.server,p.protocol,p.sourceName].join(' ').toLowerCase().includes(q)));}
async function startNodeBridge(id){const p=state.proxies.find(x=>x.id===id);if(!p?.rawLine)return toast('请重新解析此节点');try{await bridgeRequest('/api/bridge/start',{appId:`pool-${id}`,name:p.name,rawLine:p.rawLine});await reloadBridges();toast('本地端口已启用，请测试出口');}catch(error){toast(error.message);}}
async function stopNodeBridge(id){try{await bridgeRequest('/api/bridge/stop',{appId:`pool-${id}`});await reloadBridges();toast('本地端口已停止');}catch(error){toast(error.message);}}
async function checkNodeBridge(id){try{const result=await bridgeRequest('/api/bridge/check',{appId:`pool-${id}`});toast(result.upstreamReachable?'出口检测通过':`出口未通过：${result.error||result.status||'未知原因'}`);}catch(error){toast(error.message);}}
const probingNodes = new Set();
const selectedProbeIds = new Set();
let bulkProbeRunning = false;
let bulkProbeCancelled = false;
function bulkProbeStatus(message,running){const el=$('#bulk-probe-progress');el.textContent=message;el.classList.toggle('hidden',!message);$('#cancel-bulk-probe').classList.toggle('hidden',!running);}
$('#cancel-bulk-probe').onclick=()=>{bulkProbeCancelled=true;bulkProbeStatus('正在停止：进行中的请求完成后保存已得结果…',false);};
const probeBridgeFor = p => bridgeFor(`pool-${p.id}`) || state.bridges.find(b => state.apps.some(a => a.id === b.appId && a.proxyId === p.id));
function probeSummary(p){const r=p.lastProbe;if(!r)return '';const date=r.checkedAt?new Date(r.checkedAt).toLocaleString('zh-CN'):'';if(r.error)return `<span class="probe-result probe-error" title="检测时间：${esc(date)}">失败：${esc(r.error)}</span>`;const pieces=[];if(r.ip)pieces.push(`<span>IP ${esc(r.ip)}</span>`);if(Number.isFinite(r.latencyMs))pieces.push(`<span>${Math.round(r.latencyMs)} ms</span>`);if(Number.isFinite(r.downloadMbps))pieces.push(`<span>${r.downloadMbps.toFixed(2)} Mbps</span>`);if(!pieces.length)return '';return `<span class="probe-result" title="检测时间：${esc(date)}">${pieces.join('')}</span>`;}
async function runNodeProbe(id,kind){if(probingNodes.has(id))return;const p=state.proxies.find(item=>item.id===id);if(!p)return;probingNodes.add(id);renderProxies();try{const result=await bridgeRequest('/api/proxy/probe',{id,kind});p.lastProbe=result;await save().catch(()=>{});toast(kind==='ip'?`出口 IP：${result.ip}`:`下载约 2 MB：${result.downloadMbps.toFixed(2)} Mbps · ${result.latencyMs} ms`);}catch(error){p.lastProbe={error:error.message,checkedAt:new Date().toISOString()};await save().catch(()=>{});toast(`探测失败：${error.message}`);}finally{probingNodes.delete(id);renderProxies();}}
async function runSelectedProbes(kind){
  if(bulkProbeRunning)return toast('批量检测正在进行，请等待当前任务结束');
  const rows=filteredProxies();
  const selected=rows.filter(p=>selectedProbeIds.has(p.id)&&!isSubscriptionNotice(p));
  if(!selected.length)return toast('请先勾选要检测的节点');
  const eligible=selected.filter(p=>probeBridgeFor(p)||nativeProbeable(p));
  const skipped=selected.length-eligible.length;
  if(!eligible.length)return toast('选中的节点没有可用代理端口，请先启用节点');
  const concurrency=Math.min(8,Math.max(1,Number($('#probe-concurrency').value)||5));
  bulkProbeRunning=true;
  bulkProbeCancelled=false;
  $('#probe-selected-ip').disabled=true;
  $('#probe-selected-speed').disabled=true;
  $('#probe-concurrency').disabled=true;
  bulkProbeStatus(`准备检测 ${eligible.length} 个节点…`,true);
  renderProxies();
  let cursor=0,success=0,failed=0;
  const worker=async()=>{while(!bulkProbeCancelled&&cursor<eligible.length){const p=eligible[cursor++];probingNodes.add(p.id);try{p.lastProbe=await bridgeRequest('/api/proxy/probe',{id:p.id,kind});success++;}catch(error){p.lastProbe={error:error.message,checkedAt:new Date().toISOString()};failed++;}finally{probingNodes.delete(p.id);bulkProbeStatus(`${bulkProbeCancelled?'正在停止':'检测中'}：${success+failed} / ${eligible.length} · 成功 ${success} · 失败 ${failed}`,!bulkProbeCancelled);renderProxies();}}};
  await Promise.all(Array.from({length:Math.min(concurrency,eligible.length)},worker)).finally(()=>{
    bulkProbeRunning=false;
    $('#probe-selected-ip').disabled=false;
    $('#probe-selected-speed').disabled=false;
    $('#probe-concurrency').disabled=false;
  });
  try{await save();}catch{}
  const suffix=skipped?`，跳过 ${skipped} 个未启用节点`:'';
  const summary=`${bulkProbeCancelled&&eligible.length>success+failed?'已取消':'已完成'}：成功 ${success} 个，失败 ${failed} 个，未处理 ${eligible.length-success-failed} 个${suffix}`;
  bulkProbeStatus(summary,false);
  toast(summary);
}
function renderProxies(){
  if(window.renderProxiesEnhanced)return window.renderProxiesEnhanced();
  const rows=filteredProxies();
  $('#proxy-count').textContent=`${rows.length} / ${state.proxies.length} 个节点 · ${state.bridges.length} 个端口已启用`;
  $('#proxy-empty').style.display=rows.length?'none':'block';
  const selectedVisible=rows.filter(p=>selectedProbeIds.has(p.id)).length;
  $('#selected-proxy-count').textContent=`已选 ${selectedProbeIds.size} 个`;
  const selectAll=$('#select-all-proxies');
  if(selectAll){selectAll.checked=rows.length>0&&selectedVisible===rows.length;selectAll.indeterminate=selectedVisible>0&&selectedVisible<rows.length;}
  const card=p=>{
    const b=bridgeFor(`pool-${p.id}`);
    const available=b||probeBridgeFor(p)||nativeProbeable(p);
    const busy=probingNodes.has(p.id);
    const previewText=b?formatBridge(b):bridgeable(p)?(p.rawLine?'未启用 · 按需启动':'需重新解析'):directExportable(p)?formatProxy(p):'缺少账号或密码 · 不能直接导出';
    const preview=esc(previewText);
    const action=bridgeable(p)?(b?`<button class="copy-btn" data-copy-local="${p.id}" title="复制本地代理行">复制代理</button><button class="copy-btn" data-check-node="${p.id}" title="检查代理是否能访问目标">连通性</button><button class="copy-btn" data-stop-node="${p.id}">停用</button>`:p.rawLine?`<button class="copy-btn" data-start-node="${p.id}">启用</button>`:'<span class="muted">请重新解析</span>'):directExportable(p)?`<button class="copy-btn" data-copy-proxy="${p.id}">复制</button>`:'<span class="muted">不可导出</span>';
    const probes=available?`<button class="copy-btn" data-probe-ip="${p.id}" ${busy?'disabled':''}>${busy?'检测中…':'查 IP'}</button><button class="copy-btn" data-probe-speed="${p.id}" ${busy?'disabled':''}>测速</button>`:'';
    const probe=probeSummary(p);
    return `<article class="proxy-card${b?' is-active':''}"><div class="proxy-card-head"><label class="node-check"><input type="checkbox" data-probe-select="${p.id}" ${selectedProbeIds.has(p.id)?'checked':''} ${busy?'disabled':''}/><span class="node-name" title="${esc(p.name)}">${esc(p.name)}</span></label>${probe}<span class="pill">${esc(p.protocol)}</span></div><div class="proxy-card-endpoint" title="${esc(`${p.server}:${p.port}`)}">${esc(p.server)}:${p.port}</div><div class="proxy-card-preview" title="${esc(previewText)}">${preview}</div><div class="node-actions">${action}${probes}</div></article>`;
  };
  const groups=new Map();
  for(const source of state.sources)groups.set(source.id,{name:source.name,items:[]});
  for(const p of rows){const id=p.sourceId||'other';if(!groups.has(id))groups.set(id,{name:p.sourceName||'其他节点',items:[]});groups.get(id).items.push(p);}
  $('#proxy-grid').innerHTML=[...groups.values()].filter(g=>g.items.length).map(g=>`<section class="proxy-source-group"><div class="proxy-source-heading"><h3>${esc(g.name)}</h3><span>${g.items.length} 个节点</span></div><div class="proxy-grid">${g.items.map(card).join('')}</div></section>`).join('');
  document.querySelectorAll('[data-copy-proxy]').forEach(b=>b.onclick=()=>{const p=state.proxies.find(x=>x.id===b.dataset.copyProxy);copyText(formatProxy(p));});
  document.querySelectorAll('[data-copy-local]').forEach(b=>b.onclick=()=>{const entry=bridgeFor(`pool-${b.dataset.copyLocal}`);if(entry)copyText(formatBridge(entry));});
  document.querySelectorAll('[data-start-node]').forEach(b=>b.onclick=()=>startNodeBridge(b.dataset.startNode));
  document.querySelectorAll('[data-stop-node]').forEach(b=>b.onclick=()=>stopNodeBridge(b.dataset.stopNode));
  document.querySelectorAll('[data-check-node]').forEach(b=>b.onclick=()=>checkNodeBridge(b.dataset.checkNode));
  document.querySelectorAll('[data-probe-ip]').forEach(b=>b.onclick=()=>runNodeProbe(b.dataset.probeIp,'ip'));
  document.querySelectorAll('[data-probe-speed]').forEach(b=>b.onclick=()=>runNodeProbe(b.dataset.probeSpeed,'speed'));
  document.querySelectorAll('[data-probe-select]').forEach(input=>input.onchange=()=>{if(input.checked)selectedProbeIds.add(input.dataset.probeSelect);else selectedProbeIds.delete(input.dataset.probeSelect);renderProxies();});
  if(selectAll)selectAll.onchange=()=>{rows.forEach(p=>selectAll.checked?selectedProbeIds.add(p.id):selectedProbeIds.delete(p.id));renderProxies();};
}
function renderApps(){if(window.renderAppsEnhanced)return window.renderAppsEnhanced();const el=$('#app-list'); if(!state.apps.length){el.innerHTML='<div class="panel empty-state"><div class="empty-icon">▦</div><p>还没有应用</p><small>新建一个应用并选择要使用的节点</small></div>';return;} el.innerHTML=state.apps.map(a=>{const p=state.proxies.find(x=>x.id===a.proxyId);const bridge=bridgeFor(a.id);const endpoint=bridge?formatBridge(bridge):'';return `<div class="app-card"><div class="app-head"><div class="app-title">${esc(a.name)}</div><button class="small-btn danger" data-delete-app="${a.id}">删除</button></div><div class="app-desc">${esc(a.description||'为此应用选择独立代理节点')}</div><select class="app-select" data-app-select="${a.id}"><option value="">暂不分配</option>${state.proxies.map(x=>`<option value="${x.id}" ${x.id===a.proxyId?'selected':''}>${esc(x.name)} · ${esc(x.server)}:${x.port}</option>`).join('')}</select>${p?`<div class="assigned-preview">${bridge?esc(endpoint):bridgeable(p)?'加密节点 · 点击下方启动本地代理':directExportable(p)?esc(formatProxy(p)):'缺少账号或密码，不能按四段式导出'}</div>${bridge?`<button class="small-btn bridge-btn" data-copy-bridge="${a.id}">复制本地代理</button>`:''}${bridgeable(p)?`<button class="small-btn bridge-btn" data-bridge-app="${a.id}">${bridge?'停止本地代理':'启动本地代理'}</button>`:''}`:'<div class="assigned-preview">未分配节点</div>'}</div>`}).join('');el.querySelectorAll('[data-app-select]').forEach(s=>s.onchange=()=>{const a=state.apps.find(x=>x.id===s.dataset.appSelect);a.proxyId=s.value;const old=bridgeFor(a.id);if(old){save();stopAppBridge(a.id);}else{save();toast('应用分配已保存');}});el.querySelectorAll('[data-copy-bridge]').forEach(b=>b.onclick=()=>{const bridge=bridgeFor(b.dataset.copyBridge);if(bridge)copyText(formatBridge(bridge));});el.querySelectorAll('[data-bridge-app]').forEach(b=>b.onclick=()=>bridgeFor(b.dataset.bridgeApp)?stopAppBridge(b.dataset.bridgeApp):startAppBridge(b.dataset.bridgeApp));el.querySelectorAll('[data-delete-app]').forEach(b=>b.onclick=()=>{const id=b.dataset.deleteApp;stopAppBridge(id);state.apps=state.apps.filter(a=>a.id!==id);save();});}
function renderAll(){renderOverview();renderSources();renderProxies();renderApps();}
async function copyText(text){try{await navigator.clipboard.writeText(text);toast('已复制到剪贴板');return true;}catch{const area=document.createElement('textarea');area.value=text;area.setAttribute('readonly','');area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();let copied=false;try{copied=document.execCommand('copy');}catch{}area.remove();if(copied){toast('已复制到剪贴板');return true;}toast('复制失败，请手动选择文本');return false;}}
function openModal(){ $('#source-modal').classList.remove('hidden'); $('#source-name').focus(); } function closeModal(){ $('#source-modal').classList.add('hidden'); $('#source-name').value='';$('#source-url').value='';$('#source-content').value='';$('#modal-error').textContent=''; }
function openAppModal(){ $('#app-modal').classList.remove('hidden'); $('#app-name').focus(); } function closeAppModal(){ $('#app-modal').classList.add('hidden'); $('#app-name').value=''; $('#app-description').value=''; $('#app-modal-error').textContent=''; }
function saveApp(){ const name=$('#app-name').value.trim(); if(!name){$('#app-modal-error').textContent='请输入应用名称';return;} state.apps.push({id:uid(),name,description:$('#app-description').value.trim(),proxyId:''}); save(); closeAppModal(); go('apps'); toast('应用已创建'); }
$('#open-source-modal').onclick=openModal;$('#close-source-modal').onclick=closeModal;$('#cancel-source').onclick=closeModal;$('#save-source').onclick=importSource;$('#source-modal').onclick=e=>{if(e.target.id==='source-modal')closeModal()};$('#add-app').onclick=openAppModal;$('#close-app-modal').onclick=closeAppModal;$('#cancel-app').onclick=closeAppModal;$('#save-app').onclick=saveApp;$('#app-modal').onclick=e=>{if(e.target.id==='app-modal')closeAppModal()};$('#proxy-search').oninput=renderProxies;$('#format-select').onchange=e=>{state.format=e.target.value;renderProxies()};$('#pool-start').onclick=startProxyPool;$('#pool-stop').onclick=stopProxyPool;$('#probe-selected-ip').onclick=()=>runSelectedProbes('ip');$('#probe-selected-speed').onclick=()=>runSelectedProbes('speed');$('#clear-data').onclick=async()=>{if(confirm('确定清空保存的订阅、节点和应用分配吗？')){try{await bridgeRequest('/api/bridge/stop-all',{});state.sources=[];state.proxies=[];state.apps=[];selectedProbeIds.clear();await save();await reloadBridges();toast('数据和本地端口已清空');}catch(error){toast(error.message);}}};
async function boot(){try{const response=await fetch('/api/state');if(!response.ok)throw new Error('读取服务端数据失败');const stored=await response.json();const hasServerData=stored.sources.length||stored.proxies.length||stored.apps.length;if(hasServerData){state.sources=stored.sources;state.proxies=stored.proxies;state.apps=stored.apps;}else if(state.sources.length||state.proxies.length||state.apps.length){await save();}await reloadBridges();}catch(error){renderAll();toast(`服务端数据未加载：${error.message}`);}}
boot();
