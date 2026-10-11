'use strict';
const scriptUrl = document.querySelector('script[src$="/assets/console.js"]').src;
const base = new URL(scriptUrl).pathname.replace('/assets/console.js', '');
const $ = id => document.getElementById(id);
const metricNames = {hr:'心率', spo2:'血氧', bp_sys:'收缩压', bp_dia:'舒张压', temp:'皮温', glu:'厂商血糖值', stress:'厂商压力值', hrv:'厂商 HRV 值'};
const qualityNames = {unknown:'质量未知', invalid:'无效', valid:'有效'};
const taskNames = {queued:'排队中', running:'处理中', completed:'已完成', failed:'失败'};
const scopeNames = {upload:'上传', ai_analysis:'AI 分析', remote_alerts:'远程提醒'};
let expiryTimer;
function message(text, error=false) { $('message').textContent=text; $('message').hidden=!text; $('message').classList.toggle('error',error); }
function element(tag, text, className) { const node=document.createElement(tag); if(text!==undefined)node.textContent=text; if(className)node.className=className; return node; }
function time(value) { const date=new Date(value); return Number.isNaN(date.getTime())?'时间未知':date.toLocaleString('zh-CN',{hour12:false}); }
function loggedIn(value) { $('login').hidden=value; $('dashboard').hidden=!value; $('logout').hidden=!value; if(!value){for(const id of ['devices','metrics','samples','ai','alerts','guardians'])$(id).replaceChildren(); clearPair();} }
function csrf() { const row=document.cookie.split('; ').find(c=>c.startsWith('__Secure-rareguard_csrf=')); return row?decodeURIComponent(row.split('=').slice(1).join('=')):''; }
async function api(path, body) {
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf()},body:body===undefined?undefined:JSON.stringify(body)});
  let payload; try {payload=await response.json();} catch {throw new Error('服务端响应无法读取，请稍后重试');}
  if(!response.ok){if(response.status===401 && path!=='/login'){loggedIn(false);history.replaceState(null,'',base+'/login');}throw new Error(payload.message||'操作失败，请重试');}
  return payload;
}
function rows(id, values, render, empty) { $(id).replaceChildren(); if(!values.length)$(id).append(element('p',empty,'empty')); else values.forEach(value=>$(id).append(render(value))); }
function row(title, detail) { const node=element('div',undefined,'row');node.append(element('strong',title));node.append(element('p',detail,'caption'));return node; }
function table(id, headers, records) { const node=element('table');const head=element('thead');const hr=element('tr');headers.forEach(text=>{const th=element('th',text);th.scope='col';hr.append(th);});head.append(hr);node.append(head);const body=element('tbody');records.forEach(cells=>{const tr=element('tr');cells.forEach(text=>tr.append(element('td',text)));body.append(tr);});node.append(body);$(id).replaceChildren(node); }
function render(data) {
  const service=data.service;
  $('updated').textContent='更新于 '+time(data.generated_at);
  $('device-count').textContent=data.devices.length;
  $('batch-count').textContent=data.batch_count;
  $('sample-count').textContent=data.metrics.reduce((sum,m)=>sum+m.count,0);
  $('agent-state').replaceChildren(element('span',service.hermes_configured?'已配置 · '+service.hermes_profile:'尚未配置'));
  $('agent-state').append(element('span','连接以实际问答结果为准'));
  if(service.hermes_web_url)$('hermes').href=service.hermes_web_url;
  rows('devices',data.devices,d=>row(d.model,'固件 '+(d.firmware||'未知')+' · 协议 '+d.protocol),'还没有同步设备。请在 App 配对并开启上传。');
  rows('metrics',data.metrics,m=>row((metricNames[m.metric]||m.metric)+' · '+m.count+' 条', (qualityNames[m.quality]||m.quality)+' · 最近接收 '+time(m.last_received)),'暂无上传记录。');
  if(data.latest_samples.length)table('samples',['指标','数值 / 单位','来源','质量','接收时间'],data.latest_samples.map(s=>[metricNames[s.metric]||s.metric,s.value+' '+s.unit,s.source==='live_device'?'设备即时':s.source==='device_history'?'设备历史':s.source,qualityNames[s.quality]||s.quality,time(s.received_at)]));
  else $('samples').replaceChildren(element('p','暂无最近记录。没有记录不表示没有异常。','empty'));
  rows('ai',data.ai_requests,t=>{const node=row(taskNames[t.status]||t.status,time(t.created_at)+' · 尝试 '+t.attempts+' 次');if(t.error)node.append(element('p',t.error,'caption'));if(t.answer)node.append(element('p',t.answer,'answer'));return node;},'暂无问答任务。请在 App 摘要页选择窗口并提问。');
  rows('alerts',data.alerts,a=>row(a.text,time(a.created_at)+' · 已分配 '+a.assigned+' · 已收到 '+a.received+' · 已确认 '+a.confirmed),'暂无提醒。');
  rows('guardians',data.guardians,g=>row(g.name,Object.entries(scopeNames).map(([key,name])=>name+'：'+(g.consents[key]?'已同意':'未开启')).join(' · ')),'尚未配对监护人。');
}
async function refresh() { $('refresh').disabled=true;try{const data=await api('/data');loggedIn(true);render(data);message('');}catch(error){message(error.message,true);}finally{$('refresh').disabled=false;} }
$('refresh').addEventListener('click',refresh);
$('login-form').addEventListener('submit',async event=>{event.preventDefault();$('login-submit').disabled=true;message('正在验证登录…');try{await api('/login',{username:$('username').value.trim(),password:$('password').value});$('password').value='';history.replaceState(null,'',base);await refresh();}catch(error){message(error.message,true);}finally{$('login-submit').disabled=false;}});
$('logout').addEventListener('click',async()=>{$('logout').disabled=true;try{await api('/logout',{});loggedIn(false);history.replaceState(null,'',base+'/login');message('已退出登录');$('username').focus();}catch(error){message(error.message,true);}finally{$('logout').disabled=false;}});
function clearPair(){clearTimeout(expiryTimer);$('pair-code').value='';$('pair-result').hidden=true;}
$('pair-form').addEventListener('submit',async event=>{event.preventDefault();$('pair-submit').disabled=true;clearPair();try{const data=await api('/pairings',{name:$('guardian-name').value.trim()});$('pair-code').value=data.code;$('pair-result').hidden=false;$('pair-expiry').textContent='有效至 '+time(Date.now()+data.expires_in_minutes*60000)+' · 仅可使用一次';expiryTimer=setTimeout(()=>{clearPair();message('配对码已过期，请重新生成');},data.expires_in_minutes*60000);message('配对码已生成，请仅分享给该家庭的监护人');}catch(error){message(error.message,true);}finally{$('pair-submit').disabled=false;}});
$('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('pair-code').value);message('配对码已复制');}catch{$('pair-code').focus();$('pair-code').select();message('浏览器未允许自动复制，配对码已选中，请手动复制');}});
if(location.pathname.endsWith('/login')){loggedIn(false);$('username').focus();}else{loggedIn(true);refresh();}
