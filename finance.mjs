const dayMs = 86400000;
const dateFromMs = ms=>new Date(ms).toISOString().slice(0,10);
const epoch = date=>Date.parse(date+'T00:00:00Z');
const shift = (date,days)=>dateFromMs(epoch(date)+days*dayMs);
export const today = (zone, value = new Date())=>new Intl.DateTimeFormat('sv-SE',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(value);
function scalar(value) {
  if (Array.isArray(value)) return value.length === 1 ? scalar(value[0]) : value.map(scalar).filter(x=>x != null).join(' ');
  if (value && typeof value === 'object') return scalar(value.value ?? value.text ?? value.name);
  return value;
}
const text = value=>String(scalar(value) ?? '').trim();
function money(value) {
  const raw = scalar(value);
  if (typeof raw === 'number') return Number.isSafeInteger(Math.round(raw*100)) ? Math.round(raw*100) : null;
  if (typeof raw === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(raw.trim())) return money(Number(raw));
  return null;
}
function date(value,zone) {
  const v = scalar(value);
  if (typeof v === 'number' || (typeof v === 'string' && /^\d{12,15}$/.test(v))) {
    const parsed = new Date(Number(v));
    return Number.isFinite(+parsed) ? today(zone,parsed) : null;
  }
  const match = typeof v === 'string' && v.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) return null;
  const normalized = match[1]+'-'+match[2].padStart(2,'0')+'-'+match[3].padStart(2,'0');
  return Number.isFinite(epoch(normalized)) && dateFromMs(epoch(normalized)) === normalized ? normalized : null;
}
const sum = (list,key)=>list.reduce((total,row)=>total+(row[key] ?? 0),0);

export function snapshot(records,config,state,now,mode,zone=process.env.BUSINESS_TIME_ZONE || 'America/Sao_Paulo') {
  const {termDays,severeDays,dueSoonDays,warningRatio,fields} = config;
  const rules = mode === 'demo' && !state.configured && !state.customers.length ? demoCustomers : state.customers;
  const lookup = new Map(rules.flatMap(c=>c.aliases.map(alias=>[alias,c])));
  const grouped = new Map(rules.map(rule=>['customer:'+rule.id,{id:'customer:'+rule.id,name:rule.name,rule,bills:[]}]));
  const bills = records.map(({record_id,fields:raw})=>{
    const field = name=>raw?.[mode === 'demo' ? name : fields[name]];
    const store = text(field('客户名字'));
    const rule = lookup.get(store);
    const customer = rule ? 'customer:'+rule.id : store ? 'unmapped:'+store : 'missing:'+record_id;
    const signed = date(field('日期'),zone);
    const explicitDue = date(field('到期日'),zone);
    const termValue = scalar(field('账期'));
    const days = Number(termValue);
    const term = termValue != null && termValue !== '' && Number.isInteger(days) && days >= 0 && days <= 3650 ? days : termDays;
    const due = explicitDue || (signed && shift(signed,term));
    const balance = money(field('剩余货款'));
    const paid = (money(field('第一次还款金额')) ?? 0)+(money(field('第二次还款金额')) ?? 0);
    const late = due ? (epoch(now)-epoch(due))/dayMs : null;
    const issue = !store || balance == null || (balance > 0 && !due);
    const status = issue ? '待核对' : balance <= 0 ? '已结清' : late > 0 ? '已逾期' : late === 0 ? '今日到期' : late >= -dueSoonDays ? '即将到期' : '未到期';
    const detail = Object.fromEntries(Object.keys(fields).map(name=>{
      const value = field(name);
      if (['PDF 单子','还款记录'].includes(name)) return [name,(Array.isArray(value)?value:[]).map(item=>item?.name).filter(x=>typeof x === 'string').join('、')];
      if (['日期','到期日','第一次还款日期','第二次还款日期','最后付款时间'].includes(name)) return [name,date(value,zone) || text(value)];
      return [name,text(value)];
    }));
    const bill = {id:record_id,number:text(field('单号')) || record_id,store,customer,signed,due,balance,paid,late,status,detail,issue,term,dueSource:explicitDue?'Lark':'账期计算'};
    if (!grouped.has(customer)) grouped.set(customer,{id:customer,name:rule?.name || store || '客户未填写',rule,bills:[]});
    grouped.get(customer).bills.push(bill);
    return bill;
  });
  const customers = [...grouped.values()].map(({id,name,rule,bills})=>{
    const outstanding = bills.reduce((total,b)=>total+Math.max(0,b.balance ?? 0),0);
    const overdue = sum(bills.filter(b=>b.late>0 && b.balance>0),'balance');
    const limit = rule ? money(rule.limit) : null;
    const warning = limit == null ? null : money(rule.warning ?? rule.limit*warningRatio);
    const reasons = [];
    const hold = (limit != null && outstanding >= limit) || bills.some(b=>b.balance>0 && b.late>=severeDays);
    if (limit != null && outstanding >= limit) reasons.push('达到信用额度');
    else if (warning != null && outstanding >= warning) reasons.push('达到额度预警线');
    if (bills.some(b=>b.balance>0 && b.late>=severeDays)) reasons.push('逾期达到 '+severeDays+' 天');
    if (!rule) reasons.push('客户或门店未配置');
    if (bills.some(b=>b.issue)) reasons.push('账单数据待核对');
    if (overdue > 0 && !hold) reasons.push('有逾期账款');
    return {id,name,stores:rule?.aliases || [...new Set(bills.map(b=>b.store).filter(Boolean))],grade:rule?.grade || '—',outstanding,overdue,limit,warning,reasons,risk:hold?'暂停放货':reasons.length?'人工复核':'可放货',billIds:bills.map(b=>b.id),collection:bills.some(b=>b.balance>0 && b.late != null && b.late>=-dueSoonDays)};
  }).sort((a,b)=>b.overdue-a.overdue || b.outstanding-a.outstanding);
  const open = bills.filter(b=>b.balance>0);
  const buckets = [
    ['未到期',b=>b.late<0],['今日到期',b=>b.late===0],['逾期 1–30 天',b=>b.late>0&&b.late<=30],['逾期 31–60 天',b=>b.late>30&&b.late<=60],['逾期 60 天以上',b=>b.late>60],['到期日待核对',b=>b.late==null]
  ].map(([label,filter])=>({label,value:sum(open.filter(b=>b.late!=null || label==='到期日待核对').filter(filter),'balance')}));
  return {bills,customers,buckets,rules,notes:state.notes,stats:{outstanding:sum(open,'balance'),overdue:sum(open.filter(b=>b.late>0),'balance'),today:sum(open.filter(b=>b.late===0),'balance'),paid:sum(bills,'paid'),issues:bills.filter(b=>b.issue).length}};
}

const demoCustomers = [
  {id:'C001',name:'华盛商贸',aliases:['华盛 · 中央店','华盛 · 东城店'],grade:'A',limit:120000,warning:96000},
  {id:'C002',name:'新源供应',aliases:['新源 · 北区店'],grade:'B',limit:60000,warning:48000},
  {id:'C003',name:'锦禾零售',aliases:['锦禾 · 南湾店','锦禾 · 西区店'],grade:'C',limit:40000,warning:32000},
  {id:'C004',name:'瑞丰商行',aliases:['瑞丰 · 总店'],grade:'D',limit:24000,warning:19000},
  {id:'C005',name:'东泽贸易',aliases:['东泽 · 港口店'],grade:'B',limit:80000,warning:64000}
];
export function demo(now) {
  const rows = [[0,0,25,36000,8000],[0,1,-18,46000,10000],[0,0,0,22700,5000],[1,0,-8,34800,6000],[1,0,12,24200,0],[2,0,-34,34800,0],[2,1,5,10500,2000],[3,0,-67,31200,1000],[4,0,22,58000,8000],[4,0,-41,15000,15000],[0,1,3,18600,0],[2,1,13,10800,0]];
  return rows.map(([client,store,offset,total,paid],i)=>{
    const due = shift(now,offset), signed = shift(due,-60);
    return {record_id:'demo-'+i,fields:{'单号':'DF-'+String(1026-i).padStart(5,'0'),'客户名字':demoCustomers[client].aliases[store],'日期':signed,'签单金额':total,'账期':60,'到期日':due,'第一次还款方式':paid?'转账':'','第一次还款日期':paid?shift(signed,7):'','第一次还款金额':paid,'第二次还款金额':0,'剩余货款':total-paid,'状态':paid===total?'已结清':'未结清','月份':signed.slice(0,7),'最后付款时间':paid?shift(signed,7):''}};
  });
}



