const byId = id=>document.getElementById(id);
const content = byId('content'), dialog = byId('dialog');
const titles = {overview:'财务仪表盘',bills:'账单列表',customers:'客户汇总',tasks:'催款任务',risk:'放货风控'};
let data, page = 'overview', filter = '', query = '', requestId = 0, formatter;
const escape = value=>String(value ?? '—').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const cash = value=>value == null ? '—' : formatter.format(value/100);
const pill = label=>'<span class="pill '+(['已逾期','暂停放货'].includes(label)?'red':['待核对','人工复核','今日到期','即将到期'].includes(label)?'amber':'')+'">'+escape(label)+'</span>';
const link = (kind,id,name)=>'<button class="link" data-'+kind+'="'+escape(id)+'">'+escape(name)+'</button>';
function table(headers,rows) {
  if (!rows.length) return '<div class="empty">没有符合条件的记录。</div>';
  return '<div class="scroll"><table><thead><tr>'+headers.map(h=>'<th scope="col">'+escape(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map(cell=>'<td>'+cell+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
}
const panel = (title,body,extra='')=>'<section class="panel"><div class="section-head"><h2>'+escape(title)+'</h2>'+extra+'</div>'+body+'</section>';
const billTable = bills=>table(['单号','客户 / 门店','开单日','到期日','剩余货款','状态'],bills.map(b=>[link('bill',b.id,b.number),escape(b.store || '待核对'),escape(b.signed),escape(b.due),cash(b.balance),pill(b.status)]));
const matches = (...values)=>values.some(v=>String(v ?? '').toLowerCase().includes(query.toLowerCase()));
const search = (placeholder,options)=>'<div class="filters"><input id="query" type="text" aria-label="搜索" placeholder="'+placeholder+'" value="'+escape(query)+'">'+(options.length?'<select id="filter" aria-label="状态筛选"><option value="">全部状态</option>'+options.map(o=>'<option'+(o===filter?' selected':'')+'>'+o+'</option>').join('')+'</select>':'')+'</div>';
function overview() {
  const cards = [['应收余额',data.stats.outstanding,'全部未结清账单'],['逾期金额',data.stats.overdue,'到期日早于今天'],['今日到期',data.stats.today,'今日到期的未收款'],['累计回款',data.stats.paid,'两次还款金额合计']];
  const max = Math.max(1,...data.buckets.map(b=>b.value));
  const chart = '<div class="bar-list">'+data.buckets.map(b=>'<div class="bar"><span>'+escape(b.label)+'</span><meter aria-label="'+escape(b.label)+'" min="0" max="'+max+'" value="'+b.value+'"></meter><strong>'+cash(b.value)+'</strong></div>').join('')+'</div>';
  const quick = '<div class="quick">'+[['tasks','待跟进客户',data.customers.filter(c=>c.collection).length],['risk','暂停放货客户',data.customers.filter(c=>c.risk==='暂停放货').length],['bills','待核对账单',data.stats.issues]].map(([p,label,n])=>'<button class="action" data-page="'+p+'"'+(label==='待核对账单'?' data-filter="待核对"':'')+'><span>'+label+'</span><strong>'+n+' →</strong></button>').join('')+'</div>';
  const urgent = data.bills.filter(b=>b.balance>0 && b.late!=null && b.late>=0).sort((a,b)=>b.late-a.late).slice(0,6);
  return '<div class="stats">'+cards.map(([label,value,sub])=>'<div class="card"><p>'+label+'</p><strong>'+cash(value)+'</strong><small>'+sub+'</small></div>').join('')+'</div><div class="overview-grid">'+panel('应收账龄',chart)+panel('待处理',quick)+'</div>'+panel('到期及逾期账单',billTable(urgent),'<button class="action" data-page="bills">查看账单</button>');
}
function list() {
  if (page==='bills') return panel('全部账单',billTable(data.bills.filter(b=>matches(b.number,b.store) && (!filter || b.status===filter))),search('搜索单号或门店',['未到期','即将到期','今日到期','已逾期','已结清','待核对']));
  const rows = data.customers.filter(c=>matches(c.name,...c.stores) && (!filter || c.risk===filter) && (page!=='tasks' || c.collection));
  if (page==='tasks') return panel('到期及即将到期的客户',table(['客户','未收总额','逾期金额','最近反馈','操作'],rows.map(c=>{
    const note = data.notes.find(n=>n.customer===c.id);
    return [link('customer',c.id,c.name),cash(c.outstanding),cash(c.overdue),escape(note ? note.owner+' · '+note.feedback.slice(0,24) : '待跟进'),link('note',c.id,'记录催款')];
  })),search('搜索客户或门店',[]));
  if (page==='risk') return panel('门店放货风险',table(['客户','关联门店','等级','未收 / 额度','放货建议','判定依据'],rows.map(c=>[link('customer',c.id,c.name),escape(c.stores.join('、')),escape(c.grade),cash(c.outstanding)+' / '+cash(c.limit),pill(c.risk),escape(c.reasons.join('；') || '未触发风控规则')])),search('搜索客户或门店',['暂停放货','人工复核','可放货']));
  return panel('按客户合并应收',table(['客户','关联门店','等级','未收总额','逾期金额','额度','预警线'],rows.map(c=>[link('customer',c.id,c.name),escape(c.stores.join('、')),escape(c.grade),cash(c.outstanding),cash(c.overdue),cash(c.limit),cash(c.warning)])),search('搜索客户或门店',[])+'<button class="action" data-config>配置客户与门店</button>');
}
function render(keepFocus=false) {
  byId('title').textContent = titles[page];
  document.querySelectorAll('nav button').forEach(b=>b.setAttribute('aria-current',b.dataset.page===page?'page':'false'));
  if (!data) return;
  const selection = keepFocus && document.activeElement.id==='query' ? byId('query').selectionStart : null;
  content.innerHTML = (data.stats.issues ? '<div class="notice">'+data.stats.issues+' 张账单需核对。应收统计仅计入可识别的余额。</div>' : '')+(page==='overview'?overview():list());
  if (selection!=null) {byId('query').focus();byId('query').setSelectionRange(selection,selection);}
}
async function api(path,options) {
  const response = await fetch(path,options);
  const result = await response.json();
  if (!response.ok) throw Error(result.error || '请求失败');
  return result;
}
async function refresh() {
  const current = ++requestId;
  byId('refresh').disabled=true;
  byId('alert').textContent='正在读取数据…';
  try {
    const result = await api('/api/snapshot');
    if (current!==requestId) return;
    data=result;
    formatter=new Intl.NumberFormat('zh-CN',{style:'currency',currency:data.currency});
    byId('date').textContent=data.date+' · '+data.timezone;
    byId('source').textContent=data.mode==='demo'?'演示数据':'Lark Base · 只读';
    byId('alert').textContent='';
    render();
  } catch(error) {
    if (current!==requestId) return;
    data=undefined;content.replaceChildren();
    byId('source').textContent='读取失败';
    byId('alert').textContent=error.message || '请检查服务是否已启动';
  } finally {if(current===requestId) byId('refresh').disabled=false;}
}
function openDialog(title,html) {
  byId('dialog-title').textContent=title;
  byId('dialog-content').innerHTML=html;
  if(!dialog.open) dialog.showModal();
}
function customer(id) {
  const c=data.customers.find(row=>row.id===id);
  if (!c) return;
  const notes=data.notes.filter(n=>n.customer===id);
  openDialog(c.name,'<p>'+pill(c.risk)+' <span class="muted">'+escape(c.reasons.join('；'))+'</span></p><p>未收总额 <strong>'+cash(c.outstanding)+'</strong> · 逾期 '+cash(c.overdue)+'</p><h3>未结清账单与待核对记录</h3>'+billTable(data.bills.filter(b=>b.customer===id && (b.balance>0 || b.issue)))+'<div class="section-head"><h3>催款记录</h3><button class="action" data-note="'+escape(id)+'">记录催款</button></div>'+ (notes.length?notes.map(n=>'<div class="note"><strong>'+escape(n.owner)+'</strong> · '+escape(new Date(n.at).toLocaleString('zh-CN',{timeZone:data.timezone}))+(n.promise?' · 承诺付款 '+escape(n.promise):'')+'<br>'+escape(n.feedback)+'</div>').join(''):'<p class="muted">暂无催款记录。</p>'));
}
const ruleRow = (c={})=>'<div class="rule"><label>客户编号<input name="id" required value="'+escape(c.id??'')+'"></label><label>客户名称<input name="name" required value="'+escape(c.name??'')+'"></label><label>等级<select name="grade">'+['A','B','C','D'].map(g=>'<option'+(g===c.grade?' selected':'')+'>'+g+'</option>').join('')+'</select></label><label>信用额度<input name="limit" required type="number" min="0.01" step="0.01" value="'+escape(c.limit??'')+'"></label><label>预警金额<input name="warning" type="number" min="0.01" step="0.01" value="'+escape(c.warning??'')+'"></label><label class="wide">门店别名（每行一个）<textarea name="aliases" required rows="2">'+escape((c.aliases||[]).join('\n'))+'</textarea></label><div><button class="action" type="button" data-remove>移除此客户</button></div></div>';
document.addEventListener('click',event=>{
  const button=event.target.closest('button');
  if (!button) return;
  const {page:target,bill,customer:id,note}=button.dataset;
  if (target) {page=target;filter=button.dataset.filter||'';query='';render();}
  if (button.id==='refresh') refresh();
  if (button.id==='close') dialog.close();
  if (bill && data) {
    const b=data.bills.find(row=>row.id===bill);
    if (b) openDialog('账单 '+b.number,'<p>'+pill(b.status)+' · 到期日 '+escape(b.due)+' · '+escape(b.dueSource)+' · '+b.term+' 天账期</p><dl>'+Object.entries(b.detail).map(([key,value])=>'<div><dt>'+escape(key)+'</dt><dd>'+escape(value||'—')+'</dd></div>').join('')+'</dl>');
  }
  if (id && data) customer(id);
  if (note && data) {
    const name=data.customers.find(c=>c.id===note)?.name;
    openDialog('记录催款 · '+name,'<form id="note-form" data-customer="'+escape(note)+'"><label>负责人<input name="owner" required maxlength="80"></label><label>承诺付款日期<input name="promise" type="date"></label><label>催款反馈<textarea name="feedback" required maxlength="1000" rows="4"></textarea></label><div class="error" role="alert"></div><div><button class="primary">保存催款记录</button></div></form>');
  }
  if (button.hasAttribute('data-config') && data) openDialog('配置客户与门店','<p class="muted">别名需与 Lark「客户名字」一致。客户编号用于关联催款历史。</p><form id="rule-form"><div class="error" role="alert"></div>'+data.rules.map(ruleRow).join('')+'<div class="controls"><button class="action" type="button" data-add>＋ 添加客户</button><button class="primary">保存配置</button></div></form>');
  if (button.hasAttribute('data-add')) button.parentElement.insertAdjacentHTML('beforebegin',ruleRow());
  if (button.hasAttribute('data-remove')) button.closest('.rule').remove();
});
document.addEventListener('input',event=>{if(event.target.id==='query'){query=event.target.value;render(true);}});
document.addEventListener('change',event=>{if(event.target.id==='filter'){filter=event.target.value;render();byId('filter').focus();}});
dialog.addEventListener('submit',async event=>{
  event.preventDefault();
  const form=event.target, button=form.querySelector('.primary'), message=form.querySelector('.error');
  button.disabled=true;message.textContent='';
  const values=Object.fromEntries(new FormData(form));
  const payload=form.id==='note-form' ? {type:'note',customer:form.dataset.customer,...values} : {type:'customers',customers:[...form.querySelectorAll('.rule')].map(row=>{
    const value=name=>row.querySelector('[name="'+name+'"]').value;
    return {id:value('id'),name:value('name'),grade:value('grade'),limit:Number(value('limit')),warning:value('warning')?Number(value('warning')):null,aliases:value('aliases').split(/\r?\n/).map(v=>v.trim()).filter(Boolean)};
  })};
  try {
    await api('/api/workflow',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    dialog.close();
    await refresh();
    if(data) byId('alert').textContent='已保存到 DAFU。';
  } catch(error) {message.textContent=error.message;}
  finally {button.disabled=false;}
});
refresh();


