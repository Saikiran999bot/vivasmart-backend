// ============================================================
//  VivaSmart Backend v4.0
//  Gemini 2.5 Flash + Supabase | Full Feature Build
//  Author: Saikiran Jinde
// ============================================================
require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const fetch     = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Validate env vars ────────────────────────────────────────
const REQUIRED = ['GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
for (const key of REQUIRED) {
  if (!process.env[key]) { console.error(`Missing env var: ${key}`); process.exit(1); }
}
const ADMIN_EMAIL  = process.env.ADMIN_EMAIL  || 'saikiranjinde49@gmail.com';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'viva2026';
const FREE_TRIALS  = 3;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Middleware ───────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','x-admin-secret'] }));
app.options('*', cors());
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 15*60*1000, max: 200, message: { error: 'Too many requests.' } }));
const analyzeLimiter = rateLimit({ windowMs: 60*60*1000, max: 20, message: { error: 'Hourly limit reached.' } });

// ── Helpers ──────────────────────────────────────────────────
function adminAuth(req, res, next) {
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized.' });
  next();
}
function parseGeminiJSON(raw) {
  let clean = raw.trim().replace(/^```(json)?/,'').replace(/```$/,'').trim();
  try { return JSON.parse(clean); } catch (_) {
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Could not parse AI response.');
  }
}
function daysLeft(iso) {
  if (!iso) return null;
  return Math.max(0, Math.ceil((new Date(iso) - new Date()) / 86400000));
}
function formatUser(u) {
  const trials_total   = u.trials_total || FREE_TRIALS;
  const trials_used    = u.trials_used  || 0;
  const trials_left    = Math.max(0, trials_total - trials_used);
  const days_remaining = (u.sub_plan === 'monthly' && u.sub_expires) ? daysLeft(u.sub_expires) : null;
  return { id:u.id, email:u.email, name:u.name, role:u.role,
    trials_used, trials_total, trials_left,
    subscribed:u.subscribed, sub_plan:u.sub_plan, sub_expires:u.sub_expires,
    days_remaining, created_at:u.created_at, last_login:u.last_login };
}
async function refreshUser(userId) {
  const { data: u } = await supabase.from('users').select('*').eq('id', userId).single();
  if (!u) return null;
  if (u.subscribed && u.sub_plan === 'monthly' && u.sub_expires && new Date(u.sub_expires) < new Date()) {
    await supabase.from('users').update({ subscribed:false, sub_plan:null, sub_expires:null }).eq('id', u.id);
    u.subscribed=false; u.sub_plan=null; u.sub_expires=null;
  }
  return u;
}

// ── Routes ───────────────────────────────────────────────────
app.get('/',       (req,res) => res.json({ status:'ok', service:'VivaSmart API', version:'4.0.0' }));
app.get('/health', (req,res) => res.json({ status:'healthy', uptime: Math.round(process.uptime()) }));

// LOGIN / REGISTER
app.post('/api/auth/login', async (req,res) => {
  try {
    const { email, name } = req.body;
    if (!email) return res.status(400).json({ error:'Email required.' });
    const em = email.toLowerCase().trim();
    let { data:u, error } = await supabase.from('users').select('*').eq('email', em).maybeSingle();
    if (error) throw error;
    if (!u) {
      const { data:nu, error:ce } = await supabase.from('users')
        .insert({ email:em, name:(name||em.split('@')[0]).trim(), role:'student' })
        .select().single();
      if (ce) throw ce;
      u = nu;
    } else {
      const upd = { last_login: new Date().toISOString() };
      if (name && name.trim()) upd.name = name.trim();
      await supabase.from('users').update(upd).eq('id', u.id);
      if (name && name.trim()) u.name = name.trim();
    }
    if (u.subscribed && u.sub_plan==='monthly' && u.sub_expires && new Date(u.sub_expires)<new Date()) {
      await supabase.from('users').update({ subscribed:false, sub_plan:null, sub_expires:null }).eq('id',u.id);
      u.subscribed=false; u.sub_plan=null; u.sub_expires=null;
    }
    return res.json({ success:true, user:formatUser(u) });
  } catch(err) { console.error('Login:',err.message); return res.status(500).json({ error:'Login failed: '+err.message }); }
});

// USER STATUS
app.get('/api/users/:id/status', async (req,res) => {
  try {
    const u = await refreshUser(req.params.id);
    if (!u) return res.status(404).json({ error:'User not found.' });
    return res.json({ success:true, user:formatUser(u) });
  } catch(err) { return res.status(500).json({ error:'Server error.' }); }
});

// UPDATE NAME
app.put('/api/users/:id/name', async (req,res) => {
  try {
    const { name } = req.body;
    if (!name||!name.trim()) return res.status(400).json({ error:'Name required.' });
    await supabase.from('users').update({ name:name.trim() }).eq('id', req.params.id);
    return res.json({ success:true, name:name.trim() });
  } catch(err) { return res.status(500).json({ error:'Failed to update name.' }); }
});

// USER HISTORY
app.get('/api/users/:id/history', async (req,res) => {
  try {
    const id = req.params.id;
    const [pr,ar,cr] = await Promise.all([
      supabase.from('payments').select('*').eq('user_id',id).order('submitted_at',{ascending:false}),
      supabase.from('analyses').select('*').eq('user_id',id).order('analyzed_at',{ascending:false}),
      supabase.from('coupon_redemptions').select('*, coupons(code,plan_grant,trial_grant,note)').eq('user_id',id).order('redeemed_at',{ascending:false}),
    ]);
    return res.json({ success:true, payments:pr.data||[], analyses:ar.data||[], coupons:cr.data||[] });
  } catch(err) { return res.status(500).json({ error:'Failed to load history.' }); }
});

// ANALYZE
app.post('/api/analyze', analyzeLimiter, async (req,res) => {
  try {
    const { text, userId } = req.body;
    if (!text||typeof text!=='string') return res.status(400).json({ error:'Missing text.' });
    if (text.trim().length<60)  return res.status(400).json({ error:'Text too short.' });
    if (text.length>15000)      return res.status(400).json({ error:'Text too long.' });
    let ur = null;
    if (userId) {
      ur = await refreshUser(userId);
      if (ur && ur.role!=='admin' && !ur.subscribed) {
        const total = ur.trials_total||FREE_TRIALS;
        if (ur.trials_used >= total)
          return res.status(403).json({ error:'Trial limit reached.', code:'TRIAL_LIMIT', trials_used:ur.trials_used, trials_total:total });
      }
    }
    const URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const prompt = `You are an expert viva examiner. Analyze this student project and return ONLY valid JSON with:
- questions: array of 10 {q, a} objects — viva questions with short,understandable and easy to read answers
- keywords: array of 10 strings — key technical terms
- diagrams: array of 5 {title, explanation} objects — important diagrams to prepare
- projectTitle: string — inferred project name
PROJECT TEXT: ${text}`;
    const gr = await fetch(URL, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ contents:[{role:'user',parts:[{text:prompt}]}], generationConfig:{temperature:0.3,maxOutputTokens:8192,responseMimeType:'application/json'} }),
    });
    if (!gr.ok) { const e=await gr.json().catch(()=>({})); return res.status(502).json({ error:`Gemini: ${e?.error?.message||'Unknown'}` }); }
    const gd = await gr.json();
    let rawText = '';
    for (const p of (gd?.candidates?.[0]?.content?.parts||[])) { if (p.text) rawText += p.text; }
    if (!rawText) return res.status(502).json({ error:'Empty Gemini response.' });
    const parsed = parseGeminiJSON(rawText);
    if (userId && ur) {
      if (ur.role!=='admin' && !ur.subscribed)
        await supabase.from('users').update({ trials_used: ur.trials_used+1 }).eq('id', userId);
      await supabase.from('analyses').insert({ user_id:userId, email:ur.email, project_title:parsed.projectTitle||'Unknown' });
    }
    return res.json({ success:true, data:{
      projectTitle: parsed.projectTitle||'Your Project',
      questions: Array.isArray(parsed.questions)?parsed.questions.slice(0,10):[],
      keywords:  Array.isArray(parsed.keywords) ?parsed.keywords.slice(0,20) :[],
      diagrams:  Array.isArray(parsed.diagrams) ?parsed.diagrams.slice(0,5)  :[],
    }});
  } catch(err) { console.error('Analyze:',err.message); return res.status(500).json({ error:'Analysis failed: '+err.message }); }
});

// SUBMIT PAYMENT
app.post('/api/payments/submit', async (req,res) => {
  try {
    const { userId, email, plan, planLabel, upiRef, mobile } = req.body;
    if (!upiRef||!upiRef.trim()) return res.status(400).json({ error:'UPI Reference required.' });
    if (!mobile||!mobile.trim()) return res.status(400).json({ error:'Mobile number required.' });
    if (!plan)                   return res.status(400).json({ error:'Plan required.' });
    if (!email&&!userId)         return res.status(400).json({ error:'Please login before payment.' });
    const { data:ex } = await supabase.from('payments').select('id').eq('upi_ref',upiRef.trim()).maybeSingle();
    if (ex) return res.status(400).json({ error:'UPI reference already submitted.' });
    const payload = { plan:plan.toString(), plan_label:planLabel||(plan==='10'?'One-Time':'Monthly'), upi_ref:upiRef.trim(), mobile:mobile.trim(), status:'pending' };
    if (userId) payload.user_id = userId;
    if (email)  payload.email   = email.toLowerCase().trim();
    const { data:payment, error } = await supabase.from('payments').insert(payload).select().single();
    if (error) { console.error('Payment insert:',error.message); return res.status(500).json({ error:'DB error: '+error.message }); }
    return res.json({ success:true, message:'Payment submitted! Admin will verify within 30 minutes.', paymentId:payment.id });
  } catch(err) { return res.status(500).json({ error:'Failed: '+err.message }); }
});

// REDEEM COUPON
app.post('/api/coupons/redeem', async (req,res) => {
  try {
    const { code, userId } = req.body;
    if (!code)   return res.status(400).json({ error:'Code required.' });
    if (!userId) return res.status(400).json({ error:'Please login to redeem a coupon.' });
    const { data:cp } = await supabase.from('coupons').select('*').eq('code',code.trim().toUpperCase()).maybeSingle();
    if (!cp)         return res.status(404).json({ error:'Invalid coupon code.' });
    if (!cp.active)  return res.status(400).json({ error:'Coupon is no longer active.' });
    if (cp.max_uses && cp.uses >= cp.max_uses) return res.status(400).json({ error:'Coupon fully redeemed.' });
    if (cp.expiry_date && new Date(cp.expiry_date)<new Date()) return res.status(400).json({ error:'Coupon has expired.' });
    const { data:used } = await supabase.from('coupon_redemptions').select('id').eq('coupon_id',cp.id).eq('user_id',userId).maybeSingle();
    if (used) return res.status(400).json({ error:'You already used this coupon.' });
    const newUses = cp.uses+1;
    await supabase.from('coupons').update({ uses:newUses, active:(cp.max_uses&&newUses>=cp.max_uses)?false:cp.active }).eq('id',cp.id);
    const tg = cp.trial_grant||0;
    if (tg > 0) {
      const { data:u } = await supabase.from('users').select('trials_total').eq('id',userId).single();
      await supabase.from('users').update({ trials_total:(u?.trials_total||FREE_TRIALS)+tg }).eq('id',userId);
    } else {
      const exp = cp.plan_grant==='monthly' ? new Date(Date.now()+30*86400000).toISOString() : null;
      await supabase.from('users').update({ subscribed:true, sub_plan:cp.plan_grant||'one_time', sub_expires:exp }).eq('id',userId);
    }
    await supabase.from('coupon_redemptions').insert({ coupon_id:cp.id, user_id:userId });
    return res.json({ success:true, message: tg>0?`${tg} trial(s) added!`:'Unlimited access granted!', type:tg>0?'trials':'unlimited', trial_grant:tg });
  } catch(err) { return res.status(500).json({ error:'Coupon redeem failed.' }); }
});

// ADMIN STATS
app.get('/api/admin/stats', adminAuth, async (req,res) => {
  try {
    const [ur,pr,cr,ar] = await Promise.all([
      supabase.from('users').select('id,subscribed,sub_plan,role'),
      supabase.from('payments').select('id,plan,status'),
      supabase.from('coupons').select('id,active'),
      supabase.from('analyses').select('id'),
    ]);
    const pays=pr.data||[], ver=pays.filter(p=>p.status==='verified');
    const students=(ur.data||[]).filter(u=>u.role!=='admin');
    return res.json({ success:true, stats:{
      total_users:students.length, subscribed_users:students.filter(u=>u.subscribed).length,
      monthly_users:students.filter(u=>u.sub_plan==='monthly').length,
      total_payments:pays.length, pending_payments:pays.filter(p=>p.status==='pending').length,
      verified_payments:ver.length, rejected_payments:pays.filter(p=>p.status==='rejected').length,
      total_revenue:ver.reduce((s,p)=>s+parseInt(p.plan||0),0),
      active_coupons:(cr.data||[]).filter(c=>c.active).length, total_analyses:(ar.data||[]).length,
    }});
  } catch(err) { return res.status(500).json({ error:'Stats failed.' }); }
});

// ADMIN USERS
app.get('/api/admin/users', adminAuth, async (req,res) => {
  try {
    const { data,error } = await supabase.from('users').select('*').order('created_at',{ascending:false});
    if (error) throw error;
    return res.json({ success:true, users:data.map(formatUser) });
  } catch(err) { return res.status(500).json({ error:'Failed.' }); }
});

app.get('/api/admin/users/:id', adminAuth, async (req,res) => {
  try {
    const u = await refreshUser(req.params.id);
    if (!u) return res.status(404).json({ error:'Not found.' });
    const [pr,ar] = await Promise.all([
      supabase.from('payments').select('*').eq('user_id',req.params.id).order('submitted_at',{ascending:false}),
      supabase.from('analyses').select('*').eq('user_id',req.params.id).order('analyzed_at',{ascending:false}),
    ]);
    return res.json({ success:true, user:formatUser(u), payments:pr.data||[], analyses:ar.data||[] });
  } catch(err) { return res.status(500).json({ error:'Failed.' }); }
});

app.put('/api/admin/users/:id', adminAuth, async (req,res) => {
  try {
    const { action, daysToGrant, trialsToAdd, trialsTotal, name } = req.body;
    const u = await refreshUser(req.params.id);
    if (!u) return res.status(404).json({ error:'User not found.' });
    let updates = {};
    if      (action==='grant_monthly')  { const d=Math.max(1,parseInt(daysToGrant)||30); updates={ subscribed:true, sub_plan:'monthly', sub_expires:new Date(Date.now()+d*86400000).toISOString() }; }
    else if (action==='grant_one_time') { updates={ subscribed:true, sub_plan:'one_time', sub_expires:null }; }
    else if (action==='add_trials')     { updates={ trials_total:(u.trials_total||FREE_TRIALS)+Math.max(1,parseInt(trialsToAdd)||1) }; }
    else if (action==='set_trials')     { updates={ trials_total:Math.max(0,parseInt(trialsTotal)||FREE_TRIALS), trials_used:0 }; }
    else if (action==='reset_used')     { updates={ trials_used:0 }; }
    else if (action==='revoke_all')     { updates={ subscribed:false, sub_plan:null, sub_expires:null, trials_total:FREE_TRIALS, trials_used:0 }; }
    else if (action==='update_name')    { if (!name||!name.trim()) return res.status(400).json({ error:'Name required.' }); updates={ name:name.trim() }; }
    else return res.status(400).json({ error:'Unknown action.' });
    const { error } = await supabase.from('users').update(updates).eq('id', req.params.id);
    if (error) throw error;
    const updated = await refreshUser(req.params.id);
    return res.json({ success:true, user:formatUser(updated) });
  } catch(err) { return res.status(500).json({ error:'Update failed: '+err.message }); }
});

// ADMIN PAYMENTS
app.get('/api/admin/payments', adminAuth, async (req,res) => {
  try {
    const { data,error } = await supabase.from('payments').select('*').order('submitted_at',{ascending:false});
    if (error) throw error;
    return res.json({ success:true, payments:data });
  } catch(err) { return res.status(500).json({ error:'Failed.' }); }
});

app.post('/api/admin/payments/:id/verify', adminAuth, async (req,res) => {
  try {
    const { notes, trialsToGrant } = req.body;
    const { data:pay,error:fe } = await supabase.from('payments').select('*').eq('id',req.params.id).single();
    if (fe||!pay) return res.status(404).json({ error:'Not found.' });
    if (pay.status==='verified') return res.status(400).json({ error:'Already verified.' });
    const nt = Math.max(1,parseInt(trialsToGrant)||1);
    await supabase.from('payments').update({ status:'verified', verified_at:new Date().toISOString(), verified_by:ADMIN_EMAIL, notes:notes||null, trials_granted:pay.plan==='99'?null:nt }).eq('id',pay.id);
    if (pay.plan==='99') {
      const ud={ subscribed:true, sub_plan:'monthly', sub_expires:new Date(Date.now()+30*86400000).toISOString() };
      if (pay.user_id)  await supabase.from('users').update(ud).eq('id',pay.user_id);
      else if (pay.email) await supabase.from('users').update(ud).eq('email',pay.email);
    } else {
      let uid=pay.user_id, cur=FREE_TRIALS;
      if (uid) { const {data:u}=await supabase.from('users').select('trials_total').eq('id',uid).single(); cur=u?.trials_total||FREE_TRIALS; }
      else if (pay.email) { const {data:u}=await supabase.from('users').select('id,trials_total').eq('email',pay.email).maybeSingle(); if(u){uid=u.id;cur=u.trials_total||FREE_TRIALS;} }
      const ud={ trials_total:cur+nt };
      if (uid) await supabase.from('users').update(ud).eq('id',uid);
      else if (pay.email) await supabase.from('users').update(ud).eq('email',pay.email);
    }
    return res.json({ success:true, message:'Verified and access granted.' });
  } catch(err) { return res.status(500).json({ error:'Failed: '+err.message }); }
});

app.post('/api/admin/payments/:id/reject', adminAuth, async (req,res) => {
  try {
    const { notes } = req.body;
    await supabase.from('payments').update({ status:'rejected', verified_at:new Date().toISOString(), verified_by:ADMIN_EMAIL, notes:notes||'Rejected' }).eq('id',req.params.id);
    return res.json({ success:true });
  } catch(err) { return res.status(500).json({ error:'Failed.' }); }
});

// ADMIN COUPONS
app.get('/api/admin/coupons', adminAuth, async (req,res) => {
  try {
    const { data,error } = await supabase.from('coupons').select('*').order('created_at',{ascending:false});
    if (error) throw error;
    return res.json({ success:true, coupons:data });
  } catch(err) { return res.status(500).json({ error:'Failed.' }); }
});

app.post('/api/admin/coupons', adminAuth, async (req,res) => {
  try {
    let { code, maxUses, planGrant, trialGrant, note, expiryDate } = req.body;
    if (!code||!code.trim()) {
      const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      code='VS-'+Array.from({length:8},()=>c[Math.floor(Math.random()*c.length)]).join('');
    }
    code=code.trim().toUpperCase(); maxUses=parseInt(maxUses)||100; trialGrant=parseInt(trialGrant)||0;
    planGrant=trialGrant>0?'trials':(['one_time','monthly'].includes(planGrant)?planGrant:'one_time');
    const { data:ex } = await supabase.from('coupons').select('id').eq('code',code).maybeSingle();
    if (ex) return res.status(400).json({ error:`Code "${code}" already exists.` });
    const payload={ code, max_uses:maxUses, plan_grant:planGrant, trial_grant:trialGrant, created_by:ADMIN_EMAIL };
    if (note)       payload.note=note.trim();
    if (expiryDate) payload.expiry_date=new Date(expiryDate).toISOString();
    const { data:cp,error } = await supabase.from('coupons').insert(payload).select().single();
    if (error) throw error;
    return res.json({ success:true, coupon:cp });
  } catch(err) { return res.status(500).json({ error:'Failed: '+err.message }); }
});

app.put('/api/admin/coupons/:id', adminAuth, async (req,res) => {
  try {
    const { trialGrant, maxUses, planGrant, note, expiryDate, active } = req.body;
    const u={};
    if (trialGrant!==undefined) u.trial_grant=parseInt(trialGrant)||0;
    if (maxUses!==undefined)    u.max_uses=parseInt(maxUses)||100;
    if (planGrant!==undefined)  u.plan_grant=planGrant;
    if (note!==undefined)       u.note=note;
    if (active!==undefined)     u.active=active;
    if (expiryDate!==undefined) u.expiry_date=expiryDate?new Date(expiryDate).toISOString():null;
    await supabase.from('coupons').update(u).eq('id',req.params.id);
    return res.json({ success:true });
  } catch(err) { return res.status(500).json({ error:'Failed.' }); }
});

app.put('/api/admin/coupons/:id/toggle', adminAuth, async (req,res) => {
  try {
    const { data:cp } = await supabase.from('coupons').select('active').eq('id',req.params.id).single();
    if (!cp) return res.status(404).json({ error:'Not found.' });
    await supabase.from('coupons').update({ active:!cp.active }).eq('id',req.params.id);
    return res.json({ success:true, active:!cp.active });
  } catch(err) { return res.status(500).json({ error:'Failed.' }); }
});

app.delete('/api/admin/coupons/:id', adminAuth, async (req,res) => {
  try {
    await supabase.from('coupons').delete().eq('id',req.params.id);
    return res.json({ success:true });
  } catch(err) { return res.status(500).json({ error:'Failed.' }); }
});

// Fallback
app.use((req,res) => res.status(404).json({ error:'Not found.' }));
app.use((err,req,res,_) => { console.error(err.message); res.status(500).json({ error:'Server error.' }); });
app.listen(PORT, () => console.log(`VivaSmart v4.0 → http://localhost:${PORT}`));
