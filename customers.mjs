import {createHash} from 'node:crypto';
export const customerFields = {id:'顾客编号',name:'顾客名称',grade:'等级',limit:'信用额度',warning:'预警金额',aliases:'门店别名'};
export const problem = (status,safe)=>Object.assign(new Error(safe),{status,safe});
const version = customer=>createHash('sha256').update(JSON.stringify(customer)).digest('hex');
const scalar = value=>Array.isArray(value) ? value.map(scalar).join('') : value && typeof value==='object' ? scalar(value.text ?? value.name ?? value.value) : value ?? '';

export function validateCustomer(input, current = []) {
  if (!input || typeof input!=='object') throw problem(400,'顾客资料格式无效');
  const {grade,limit,warning,aliases} = input;
  const id = typeof input.id==='string' ? input.id.trim() : '';
  const name = typeof input.name==='string' ? input.name.trim() : '';
  const stores = Array.isArray(aliases) && aliases.every(a=>typeof a==='string') ? aliases.map(a=>a.trim()) : [];
  const validAmount = amount=>Number.isFinite(amount) && amount>0 && amount<=1e12;
  if (!id || id.length>80 || !name || name.length>200 || !['A','B','C','D'].includes(grade) || !validAmount(limit) || (warning!=null && (!validAmount(warning) || warning>limit)) || !stores.length || stores.length>200 || stores.some(a=>!a || a.length>200 || /[\r\n]/.test(a))) throw problem(400,'请填写顾客编号、名称、等级、信用额度和门店别名');
  if (new Set(stores).size!==stores.length || current.some(c=>c.id===id || c.aliases.some(a=>stores.includes(a)))) throw problem(409,'顾客编号或门店别名已经存在');
  return {id,name,grade,limit,warning:warning ?? null,aliases:stores};
}

export function customerService(client, fields) {
  const names = Object.values(fields);
  if (names.length!==6 || names.some(n=>typeof n!=='string' || !n.trim()) || new Set(names).size!==names.length) throw Error('顾客表字段映射无效');
  let queue = Promise.resolve();
  async function list() {
    const rows = [];
    for (const row of await client.records(names)) {
      if (!row.record_id) throw problem(502,'Lark 顾客表返回了无效记录');
      const value = key=>scalar(row.fields[fields[key]]);
      const input = {id:String(value('id')),name:String(value('name')),grade:String(value('grade')),limit:Number(value('limit')),warning:value('warning')==='' ? null : Number(value('warning')),aliases:String(value('aliases')).split(/\r?\n/).filter(a=>a.trim())};
      try {
        const customer = validateCustomer(input,rows);
        rows.push({...customer,recordId:row.record_id,version:version(customer)});
      } catch (error) {
        throw problem(502,'顾客表资料需核对（'+(input.id || row.record_id)+'）。'+error.safe);
      }
    }
    return rows;
  }
  return {list,save(input,update) {
    const operation = queue.then(async ()=>{
      const rows = await list();
      const old = update ? rows.find(row=>row.recordId===input.recordId) : null;
      if (update && (!old || input.version!==old.version || input.id!==old.id)) throw problem(409,'顾客资料已变化，请刷新后重新编辑');
      const customer = validateCustomer(input,rows.filter(row=>row!==old));
      const values = {...customer,aliases:customer.aliases.join('\n')};
      await client.saveRecord(Object.fromEntries(Object.keys(values).map(key=>[fields[key],values[key]])),old?.recordId);
    });
    queue = operation.catch(()=>{});
    return operation;
  }};
}

