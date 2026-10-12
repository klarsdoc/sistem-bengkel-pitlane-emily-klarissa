'use strict';
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const app = express();
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = "https://ttfrkvdrloceyqxhjauv.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0ZnJrdmRybG9jZXlxeGhqYXV2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MTgyODc3MSwiZXhwIjoyMTA3NDA0NzcxfQ.6OMCYi4AMcUWDKlTyoY1DkcBC5JAwZHYTl2U81BdbY4";
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable.'); process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
app.use(cors()); app.use(express.json({ limit: '1mb' }));
const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
const fail = (res,status,message) => res.status(status).json({error:message});
const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
const nonnegative = v => Math.max(0,num(v));
const round = v => Math.round(num(v)*100)/100;
const today = () => new Date().toISOString().slice(0,10);
const throwIf = error => { if (error) throw error; };

function movementToLegacy(m) {
  return { id:m.id, date:m.movement_date, type:m.movement_type, reference:m.reference||'', qty_in:m.qty_in, qty_out:m.qty_out,
    balance:m.balance_after, unit_cost:Number(m.unit_cost||0), unit_price:Number(m.unit_price||0), notes:m.notes||'', work_order_id:m.work_order_id||null };
}
function mapPart(p) {
  const movements = p.inventory_movements || [];
  return { ...p, inventory_movements:movements, inventory_history:movements.map(movementToLegacy) };
}
function mapJob(j) {
  const details = (j.work_order_parts || []).map(d => ({
    id:d.id, part_id:d.part_id, qty:d.quantity, quantity:d.quantity,
    name:d.parts?.name || d.part_name || 'Suku cadang', sku:d.parts?.sku || '',
    unit_cost:Number(d.unit_cost||0), selling_price:Number(d.unit_price||0),
    subtotal_cost:Number(d.subtotal_cost ?? d.quantity*d.unit_cost), subtotal_price:Number(d.subtotal_price ?? d.quantity*d.unit_price)
  }));
  return { ...j, parts_used:details };
}
async function recordMovement(partId, type, quantity, opts={}) {
  const {data,error}=await supabase.rpc('record_inventory_movement', {
    p_part_id:partId, p_movement_type:type, p_quantity:quantity ?? null,
    p_movement_date:opts.date||today(), p_unit_cost:opts.unit_cost ?? null, p_unit_price:opts.unit_price ?? null,
    p_reference:opts.reference||null, p_notes:opts.notes||null, p_target_stock:opts.target_stock ?? null,
    p_work_order_id:opts.work_order_id||null
  });
  if(error)throw error; return data;
}
async function getPart(id) {
  const {data,error}=await supabase.from('parts').select('*').eq('id',id).single(); throwIf(error); return data;
}
async function normalizeJobParts(input) {
  const aggregate = new Map();
  for (const row of (Array.isArray(input)?input:[])) {
    if(!row.part_id || !Number.isInteger(num(row.qty)) || num(row.qty)<=0) throw new Error('Suku cadang dan jumlah unit pada work order tidak valid.');
    const old=aggregate.get(row.part_id); aggregate.set(row.part_id,(old||0)+num(row.qty));
  }
  const result=[];
  for(const [partId,qty] of aggregate.entries()) {
    const part=await getPart(partId);
    result.push({part_id:part.id,quantity:qty,unit_cost:num(part.unit_cost),unit_price:num(part.selling_price),part});
  }
  return result;
}
function calcJob(body, details) {
  const partsCost=details.reduce((s,p)=>s+p.quantity*p.unit_cost,0);
  const partsRevenue=details.reduce((s,p)=>s+p.quantity*p.unit_price,0);
  const laborHours=nonnegative(body.labor_hours), laborRate=nonnegative(body.labor_rate), overhead=nonnegative(body.overhead), serviceCharge=nonnegative(body.service_charge);
  const totalCost=round(partsCost+laborHours*laborRate+overhead), totalRevenue=round(partsRevenue+serviceCharge);
  return { labor_hours:laborHours,labor_rate:laborRate,overhead,service_charge:serviceCharge,parts_revenue:round(partsRevenue),total_cost:totalCost,total_revenue:totalRevenue,gross_profit:round(totalRevenue-totalCost) };
}
async function insertJobParts(jobId, details) {
  if(!details.length)return;
  const rows=details.map(p=>({work_order_id:jobId,part_id:p.part_id,quantity:p.quantity,unit_cost:p.unit_cost,unit_price:p.unit_price}));
  const {error}=await supabase.from('work_order_parts').insert(rows); throwIf(error);
}
async function setJobPartsStock(details, direction, job) {
  for(const p of details) {
    await recordMovement(p.part_id, direction<0?'work_order_issue':'work_order_return', p.quantity, {
      reference:job.job_number, notes:direction<0?`Pemakaian suku cadang untuk ${job.job_number}`:`Pengembalian suku cadang dari ${job.job_number}`,
      unit_cost:p.unit_cost,unit_price:p.unit_price,work_order_id:job.id
    });
  }
}
async function deleteJobPartRows(jobId) { const {error}=await supabase.from('work_order_parts').delete().eq('work_order_id',jobId); throwIf(error); }

async function createInvoiceForJob(job) {
  const { data: existing, error: findError } = await supabase.from('invoices').select('*').eq('work_order_id', job.id).maybeSingle();
  throwIf(findError);
  if (existing) return existing;
  const invoiceNumber = `INV-${job.job_number}`;
  const invoiceDate = String(job.created_at || new Date().toISOString()).slice(0,10);
  const { data, error } = await supabase.from('invoices').insert({
    invoice_number: invoiceNumber, work_order_id: job.id, invoice_date: invoiceDate,
    due_date: new Date(Date.now()+7*86400000).toISOString().slice(0,10),
    total_amount: Math.max(0,num(job.total_revenue)), paid_amount: 0, status: 'Belum Dibayar',
    notes: 'Invoice otomatis dari work order'
  }).select().single();
  if (error && error.code === '23505') {
    const { data: retry, error: retryError } = await supabase.from('invoices').select('*').eq('work_order_id', job.id).single();
    throwIf(retryError); return retry;
  }
  throwIf(error); return data;
}
function invoiceStatus(total, paid) { return paid >= total ? 'Lunas' : paid > 0 ? 'Dibayar Sebagian' : 'Belum Dibayar'; }

app.get('/api/health',(req,res)=>res.json({ok:true,app:'PITLANE Garage API',schema:'normalized-v2'}));
app.get('/api/summary',asyncRoute(async(req,res)=>{
  const [jr,pr,cr]=await Promise.all([supabase.from('work_orders').select('id,status,total_revenue'),supabase.from('parts').select('id,stock,min_stock'),supabase.from('customers').select('id')]);
  throwIf(jr.error||pr.error||cr.error); const jobs=jr.data||[],parts=pr.data||[];
  res.json({jobs:jobs.length,activeJobs:jobs.filter(j=>!['Selesai','Diambil'].includes(j.status)).length,lowStock:parts.filter(p=>p.stock<=p.min_stock).length,revenue:jobs.reduce((s,j)=>s+num(j.total_revenue),0),customers:(cr.data||[]).length});
}));

app.get('/api/customers',asyncRoute(async(req,res)=>{const {data,error}=await supabase.from('customers').select('*').order('created_at',{ascending:false});throwIf(error);res.json(data||[]);}));
app.post('/api/customers',asyncRoute(async(req,res)=>{const b=req.body,name=String(b.name||'').trim();if(!name)return fail(res,400,'Nama pelanggan wajib diisi.');const {data,error}=await supabase.from('customers').insert({name,phone:String(b.phone||''),email:String(b.email||''),address:String(b.address||'')}).select().single();throwIf(error);res.status(201).json(data);}));
app.patch('/api/customers/:id',asyncRoute(async(req,res)=>{const body={};for(const k of ['name','phone','email','address'])if(req.body[k]!==undefined)body[k]=req.body[k];const {data,error}=await supabase.from('customers').update(body).eq('id',req.params.id).select().single();throwIf(error);if(!data)return fail(res,404,'Pelanggan tidak ditemukan.');res.json(data);}));
app.delete('/api/customers/:id',asyncRoute(async(req,res)=>{const {data,error}=await supabase.from('customers').delete().eq('id',req.params.id).select('id');throwIf(error);if(!data?.length)return fail(res,404,'Pelanggan tidak ditemukan atau masih memiliki kendaraan/work order.');res.json({ok:true});}));

app.get('/api/vehicles',asyncRoute(async(req,res)=>{const {data,error}=await supabase.from('vehicles').select('*,customers(name,phone)').order('created_at',{ascending:false});throwIf(error);res.json(data||[]);}));
app.post('/api/vehicles',asyncRoute(async(req,res)=>{const b=req.body;if(!b.customer_id||!b.plate_number||!b.make||!b.model)return fail(res,400,'Pelanggan, nomor polisi, merek, dan model wajib diisi.');const {data,error}=await supabase.from('vehicles').insert({customer_id:b.customer_id,plate_number:String(b.plate_number).trim().toUpperCase(),make:String(b.make).trim(),model:String(b.model).trim(),vehicle_type:b.vehicle_type||'Motor',year:b.year?Number(b.year):null}).select().single();throwIf(error);res.status(201).json(data);}));
app.patch('/api/vehicles/:id',asyncRoute(async(req,res)=>{const body={};for(const k of ['customer_id','plate_number','make','model','vehicle_type','year'])if(req.body[k]!==undefined)body[k]=req.body[k];if(body.plate_number)body.plate_number=String(body.plate_number).trim().toUpperCase();const {data,error}=await supabase.from('vehicles').update(body).eq('id',req.params.id).select().single();throwIf(error);if(!data)return fail(res,404,'Kendaraan tidak ditemukan.');res.json(data);}));
app.delete('/api/vehicles/:id',asyncRoute(async(req,res)=>{const {data,error}=await supabase.from('vehicles').delete().eq('id',req.params.id).select('id');throwIf(error);if(!data?.length)return fail(res,404,'Kendaraan tidak ditemukan atau masih digunakan work order.');res.json({ok:true});}));

app.get('/api/parts',asyncRoute(async(req,res)=>{const {data,error}=await supabase.from('parts').select('*,inventory_movements(*)').order('name');throwIf(error);res.json((data||[]).map(p=>mapPart({...p,inventory_movements:(p.inventory_movements||[]).sort((a,b)=>String(b.movement_date).localeCompare(String(a.movement_date))||String(b.created_at).localeCompare(String(a.created_at)))})));}));
app.post('/api/parts',asyncRoute(async(req,res)=>{
  const b=req.body;if(!String(b.sku||'').trim()||!String(b.name||'').trim())return fail(res,400,'SKU dan nama suku cadang wajib diisi.');
  const stock=Math.max(0,Math.floor(num(b.stock))),cost=nonnegative(b.unit_cost),price=nonnegative(b.selling_price);
  const {data,error}=await supabase.from('parts').insert({sku:String(b.sku).trim().toUpperCase(),name:String(b.name).trim(),category:String(b.category||'Umum').trim(),stock:0,min_stock:Math.max(0,Math.floor(num(b.min_stock??3))),unit_cost:cost,selling_price:price}).select().single();throwIf(error);
  try { if(stock>0) await recordMovement(data.id,'opening',stock,{date:today(),unit_cost:cost,unit_price:price,reference:'SALDO-AWAL',notes:'Saldo awal saat item dibuat'}); }
  catch(e){await supabase.from('parts').delete().eq('id',data.id);throw e;}
  res.status(201).json(await getPart(data.id));
}));
app.patch('/api/parts/:id',asyncRoute(async(req,res)=>{const allowed=['sku','name','category','min_stock','unit_cost','selling_price'];const body={};for(const k of allowed)if(req.body[k]!==undefined)body[k]=req.body[k];if(body.sku)body.sku=String(body.sku).trim().toUpperCase();if(body.name)body.name=String(body.name).trim();if('min_stock'in body)body.min_stock=Math.max(0,Math.floor(num(body.min_stock)));for(const k of ['unit_cost','selling_price'])if(k in body)body[k]=nonnegative(body[k]);const {data,error}=await supabase.from('parts').update(body).eq('id',req.params.id).select().single();throwIf(error);if(!data)return fail(res,404,'Suku cadang tidak ditemukan.');res.json(data);}));
app.post('/api/parts/:id/movements',asyncRoute(async(req,res)=>{const b=req.body,type=String(b.type||'');if(!['purchase','sale','adjustment'].includes(type))return fail(res,400,'Jenis transaksi tidak valid.');const opts={date:b.date||today(),unit_cost:b.unit_cost,unit_price:b.unit_price,reference:b.reference,notes:b.notes};await recordMovement(req.params.id,type,type==='adjustment'?null:Number(b.quantity),{...opts,target_stock:type==='adjustment'?Number(b.quantity):null});res.status(201).json(mapPart({...await getPart(req.params.id),inventory_movements:[]}));}));
app.delete('/api/parts/:id',asyncRoute(async(req,res)=>{const [w,m]=await Promise.all([supabase.from('work_order_parts').select('id').eq('part_id',req.params.id).limit(1),supabase.from('inventory_movements').select('id').eq('part_id',req.params.id).limit(1)]);throwIf(w.error||m.error);if(w.data?.length||m.data?.length)return fail(res,409,'Suku cadang sudah memiliki work order atau riwayat persediaan. Nonaktifkan item atau pertahankan untuk audit; item tidak dapat dihapus.');const {data,error}=await supabase.from('parts').delete().eq('id',req.params.id).select('id');throwIf(error);if(!data?.length)return fail(res,404,'Suku cadang tidak ditemukan.');res.json({ok:true});}));

app.get('/api/jobs',asyncRoute(async(req,res)=>{const {data,error}=await supabase.from('work_orders').select('*,customers(name,phone),vehicles(plate_number,make,model,vehicle_type),work_order_parts(id,part_id,quantity,unit_cost,unit_price,subtotal_cost,subtotal_price,parts(name,sku))').order('created_at',{ascending:false});throwIf(error);res.json((data||[]).map(mapJob));}));
app.post('/api/jobs',asyncRoute(async(req,res)=>{
  const b=req.body;if(!b.customer_id||!b.vehicle_id||!String(b.complaint||'').trim())return fail(res,400,'Pelanggan, kendaraan, dan keluhan wajib diisi.');
  const {data:vehicleCheck,error:vehicleCheckErr}=await supabase.from('vehicles').select('id,customer_id').eq('id',b.vehicle_id).single();throwIf(vehicleCheckErr);if(vehicleCheck.customer_id!==b.customer_id)return fail(res,400,'Kendaraan yang dipilih bukan milik pelanggan tersebut.');
  const details=await normalizeJobParts(b.parts_used||[]);
  // Verify available stock before creating any rows. Each actual movement also locks the stock row.
  for(const p of details){const part=await getPart(p.part_id);if(num(part.stock)<p.quantity)throw new Error(`Stok ${part.name} tidak cukup. Tersedia ${part.stock} unit.`);}
  const calc=calcJob(b,details),jobNumber=`PL-${today().slice(2).replaceAll('-','')}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
  const record={job_number:jobNumber,customer_id:b.customer_id,vehicle_id:b.vehicle_id,complaint:String(b.complaint).trim(),diagnosis:b.diagnosis||'',mechanic:b.mechanic||'',status:b.status||'Masuk',notes:b.notes||'',...calc};
  const {data,error}=await supabase.from('work_orders').insert(record).select().single();throwIf(error);
  const consumed=[];
  try { await insertJobParts(data.id,details); for(const p of details){ await setJobPartsStock([p],-1,{...data}); consumed.push(p); } }
  catch(e){ for(const p of consumed.reverse()) await setJobPartsStock([p],+1,{...data}).catch(()=>{}); await supabase.from('inventory_movements').delete().eq('work_order_id',data.id); await deleteJobPartRows(data.id); await supabase.from('work_orders').delete().eq('id',data.id); throw e; }
  await createInvoiceForJob(data);
  res.status(201).json(mapJob({...data,work_order_parts:details.map(p=>({part_id:p.part_id,quantity:p.quantity,unit_cost:p.unit_cost,unit_price:p.unit_price,parts:{name:p.part.name,sku:p.part.sku}}))}));
}));
app.patch('/api/jobs/:id',asyncRoute(async(req,res)=>{
  const {data:old,error:oldErr}=await supabase.from('work_orders').select('*,work_order_parts(id,part_id,quantity,unit_cost,unit_price,parts(name,sku))').eq('id',req.params.id).single();throwIf(oldErr);if(!old)return fail(res,404,'Work order tidak ditemukan.');
  const b=req.body;const customerId=b.customer_id??old.customer_id,vehicleId=b.vehicle_id??old.vehicle_id;const {data:vehicleCheck,error:vehicleCheckErr}=await supabase.from('vehicles').select('id,customer_id').eq('id',vehicleId).single();throwIf(vehicleCheckErr);if(vehicleCheck.customer_id!==customerId)return fail(res,400,'Kendaraan yang dipilih bukan milik pelanggan tersebut.');
  const oldDetails=(old.work_order_parts||[]).map(d=>({part_id:d.part_id,quantity:d.quantity,qty:d.quantity,unit_cost:Number(d.unit_cost),unit_price:Number(d.unit_price),selling_price:Number(d.unit_price)}));
  const details=Array.isArray(b.parts_used)?await normalizeJobParts(b.parts_used):oldDetails.map(d=>({part_id:d.part_id,quantity:d.quantity,unit_cost:d.unit_cost,unit_price:d.unit_price,part:null}));
  const partsChanged=Array.isArray(b.parts_used);
  if(partsChanged){for(const p of details){const part=await getPart(p.part_id);const oldQty=oldDetails.filter(x=>x.part_id===p.part_id).reduce((s,x)=>s+x.quantity,0);if(num(part.stock)+oldQty<p.quantity)throw new Error(`Stok ${part.name} tidak cukup. Tersedia ${num(part.stock)+oldQty} unit termasuk stok yang sedang dipakai work order ini.`);}}
  const calc=calcJob({...old,...b},details);const patch={complaint:b.complaint??old.complaint,diagnosis:b.diagnosis??old.diagnosis,mechanic:b.mechanic??old.mechanic,status:b.status??old.status,notes:b.notes??old.notes,customer_id:b.customer_id??old.customer_id,vehicle_id:b.vehicle_id??old.vehicle_id,...calc};
  if(partsChanged){
    // Return old components, then issue the edited list. If issuing fails, try restoring the old consumption.
    await setJobPartsStock(oldDetails.map(d=>({...d,unit_price:d.unit_price})),+1,{...old});
    try { await setJobPartsStock(details,-1,{...old}); }
    catch(e){await setJobPartsStock(oldDetails.map(d=>({...d,unit_price:d.unit_price})), -1,{...old}).catch(()=>{});throw e;}
    await deleteJobPartRows(old.id);
    try { await insertJobParts(old.id,details); }
    catch(e){await setJobPartsStock(details,+1,{...old}).catch(()=>{});await setJobPartsStock(oldDetails,-1,{...old}).catch(()=>{});await insertJobParts(old.id,oldDetails.map(d=>({...d,unit_price:d.unit_price})).map(d=>({...d,part_id:d.part_id,quantity:d.quantity,unit_cost:d.unit_cost,unit_price:d.unit_price})).map(d=>({part_id:d.part_id,quantity:d.quantity,unit_cost:d.unit_cost,unit_price:d.unit_price}))).catch(()=>{});throw e;}
  }
  const {data,error}=await supabase.from('work_orders').update(patch).eq('id',req.params.id).select().single();throwIf(error);
  const {data:inv,error:invErr}=await supabase.from('invoices').select('id,paid_amount').eq('work_order_id',data.id).maybeSingle();throwIf(invErr);
  if(inv){const total=Math.max(num(data.total_revenue),num(inv.paid_amount));const {error:syncErr}=await supabase.from('invoices').update({total_amount:total,status:invoiceStatus(total,num(inv.paid_amount))}).eq('id',inv.id);throwIf(syncErr);}else await createInvoiceForJob(data);
  res.json(mapJob({...data,work_order_parts:details.map(p=>({part_id:p.part_id,quantity:p.quantity,unit_cost:p.unit_cost,unit_price:p.unit_price,parts:{name:p.part?.name||'',sku:p.part?.sku||''}}))}));
}));
app.delete('/api/jobs/:id',asyncRoute(async(req,res)=>{const {data:job,error:getErr}=await supabase.from('work_orders').select('*,work_order_parts(id,part_id,quantity,unit_cost,unit_price)').eq('id',req.params.id).single();throwIf(getErr);if(!job)return fail(res,404,'Work order tidak ditemukan.');const {data:inv,error:invErr}=await supabase.from('invoices').select('id,paid_amount').eq('work_order_id',job.id).maybeSingle();throwIf(invErr);if(inv){const {count,error:payErr}=await supabase.from('payments').select('id',{count:'exact',head:true}).eq('invoice_id',inv.id);throwIf(payErr);if(Number(inv.paid_amount)>0||(count||0)>0)return fail(res,409,'Work order memiliki riwayat pembayaran. Untuk menjaga audit piutang, work order ini tidak dapat dihapus.');}const details=(job.work_order_parts||[]).map(d=>({part_id:d.part_id,quantity:d.quantity,unit_cost:d.unit_cost,unit_price:d.unit_price}));await setJobPartsStock(details,+1,job);const {error}=await supabase.from('work_orders').delete().eq('id',req.params.id);throwIf(error);res.json({ok:true});}));

// Accounts receivable and invoice endpoints.
app.get('/api/invoices',asyncRoute(async(req,res)=>{
  const {data,error}=await supabase.from('invoices').select('*,work_orders(id,job_number,complaint,status,total_cost,total_revenue,gross_profit,labor_hours,labor_rate,overhead,service_charge,customers(id,name,phone,email,address),vehicles(plate_number,make,model,vehicle_type,year),work_order_parts(id,quantity,unit_cost,unit_price,subtotal_cost,subtotal_price,parts(name,sku))),payments(*)').order('created_at',{ascending:false});
  throwIf(error); const rows=(data||[]).map(i=>({...i, payments:(i.payments||[]).sort((a,b)=>String(b.payment_date).localeCompare(String(a.payment_date))),outstanding:Math.max(0,num(i.total_amount)-num(i.paid_amount))})); res.json(rows);
}));
app.post('/api/invoices/:id/payments',asyncRoute(async(req,res)=>{
  const b=req.body,amount=round(b.amount); if(!Number.isFinite(amount)||amount<=0)return fail(res,400,'Jumlah pembayaran harus lebih besar dari nol.');
  const {data,error}=await supabase.rpc('record_invoice_payment',{p_invoice_id:req.params.id,p_amount:amount,p_payment_date:b.payment_date||today(),p_method:b.method||'Tunai',p_notes:String(b.notes||'')});
  throwIf(error); res.status(201).json(data);
}));
app.patch('/api/invoices/:id',asyncRoute(async(req,res)=>{
  const body={}; if(req.body.due_date)body.due_date=req.body.due_date; if(req.body.notes!==undefined)body.notes=String(req.body.notes);
  const {data,error}=await supabase.from('invoices').update(body).eq('id',req.params.id).select().single();throwIf(error);if(!data)return fail(res,404,'Invoice tidak ditemukan.');res.json(data);
}));

app.use((err,req,res,next)=>{console.error(err);const msg=String(err.message||'Terjadi kesalahan pada server.');res.status(/not found/i.test(msg)?404:400).json({error:msg});});
app.listen(PORT,()=>console.log(`PITLANE Garage API running at http://localhost:${PORT}`));
