// ============================================================
//  VivaSmart Backend v3
//  Gemini API proxy + Supabase database
// ============================================================
require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const fetch        = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const app  = express();
const PORT = process.env.PORT || 3000;
const REQUIRED = ['GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
for (const key of REQUIRED) {
  if (!process.env[key]) { console.error(`Missing env var: ${key}`); process.exit(1); }
}
const ADMIN_EMAIL  = process.env.ADMIN_EMAIL  || 'saikiranjinde49@gmail.com';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'viva2026';
const FREE_TRIALS  = 3;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
app.use(helmet({ contentSecurityPolicy: false }));
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(o => o.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) cb(null, true);
    else cb(new Error('CORS not allowed'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'x-admin-secret'],
}));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 15*60*1000, max: 100, message: { error: 'Too many requests.' } }));
const analyzeLimiter = rateLimit({ windowMs: 60*60*1000, max: 15, message: { error: 'Hourly limit reached.' } });
function adminAuth(req, res, next) {
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized.' });
  next();
}
function parseGeminiJSON(raw) {
  let clean = raw.trim().replace(/^```(json)?/, '').replace(/```$/, '').trim();
  try { return JSON.parse(clean); } catch (_) {
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Could not parse AI response.');
  }
}
async function refreshUser(userId) {
  const { data: user } = await supabase.from('users').select('*').eq('id', userId).single();
  if (!user) return null;
  if (user.subscribed && user.sub_plan === 'monthly' && user.sub_expires && new Date(user.sub_expires) < new Date()) {
    await supabase.from('users').update({ subscribed: false, sub_plan: null, sub_expires: null }).eq('id', user.id);
    user.subscribed = false; user.sub_plan = null; user.sub_expires = null;
  }
  return user;
}
app.get('/', (req, res) => res.json({ status: 'ok', service: 'VivaSmart API v3' }));
app.get('/health', (req, res) => res.json({ status: 'healthy', uptime: process.uptime() }));

// LOGIN
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required.' });
    let { data: user, error } = await supabase.from('users').select('*').eq('email', email.toLowerCase()).single();
    if (error && error.code !== 'PGRST116') throw error;
    if (!user) {
      const { data: nu, error: ce } = await supabase.from('users')
        .insert({ email: email.toLowerCase(), name: name || email.split('@')[0], role: 'student' }).select().single();
      if (ce) throw ce;
      user = nu;
    } else {
      await supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', user.id);
    }
    if (user.subscribed && user.sub_plan === 'monthly' && user.sub_expires && new Date(user.sub_expires) < new Date()) {
      await supabase.from('users').update({ subscribed: false, sub_plan: null, sub_expires: null }).eq('id', user.id);
      user.subscribed = false; user.sub_plan = null; user.sub_expires = null;
    }
    return res.json({ success: true, user: {
      id: user.id, email: user.email, name: user.name, role: user.role,
      trials_used: user.trials_used, trials_total: user.trials_total || FREE_TRIALS,
      subscribed: user.subscribed, sub_plan: user.sub_plan, sub_expires: user.sub_expires,
    }});
  } catch (err) { console.error(err.message); return res.status(500).json({ error: 'Login failed.' }); }
});

// ANALYZE
app.post('/api/analyze', analyzeLimiter, async (req, res) => {
  try {
    const { text, userId } = req.body;
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'Missing text.' });
    if (text.trim().length < 60) return res.status(400).json({ error: 'Text too short.' });
    if (text.length > 15000) return res.status(400).json({ error: 'Text too long.' });
    let userRecord = null;
    if (userId) {
      userRecord = await refreshUser(userId);
      if (userRecord && userRecord.role !== 'admin' && !userRecord.subscribed) {
        const total = userRecord.trials_total || FREE_TRIALS;
        if (userRecord.trials_used >= total) {
          return res.status(403).json({ error: 'Trial limit reached.', code: 'TRIAL_LIMIT', trials_used: userRecord.trials_used, trials_total: total });
        }
      }
    }
    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const prompt = `You are an MSBTE polytechnic viva examiner. Analyze this project and return ONLY valid JSON with:
- questions: array of 10 {q,a} objects (viva questions with detailed answers)
- keywords: array of 20 strings (key technical terms)
- diagrams: array of 5 {title,explanation} objects
- projectTitle: string (inferred project name)
PROJECT TEXT: ${text}`;
    const gr = await fetch(GEMINI_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 4096 } }),
    });
    if (!gr.ok) { const e = await gr.json().catch(() => ({})); return res.status(502).json({ error: `Gemini error: ${e?.error?.message || 'Unknown'}` }); }
    const gd = await gr.json();
    const rawText = gd?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) return res.status(502).json({ error: 'Empty Gemini response.' });
    const parsed = parseGeminiJSON(rawText);
    if (userId && userRecord) {
      if (userRecord.role !== 'admin' && !userRecord.subscribed) {
        await supabase.from('users').update({ trials_used: userRecord.trials_used + 1 }).eq('id', userId);
      }
      await supabase.from('analyses').insert({ user_id: userId, email: userRecord.email, project_title: parsed.projectTitle || 'Unknown' });
    }
    return res.json({ success: true, data: {
      projectTitle: parsed.projectTitle || 'Your Project',
      questions: Array.isArray(parsed.questions) ? parsed.questions.slice(0, 10) : [],
      keywords:  Array.isArray(parsed.keywords)  ? parsed.keywords.slice(0, 20)  : [],
      diagrams:  Array.isArray(parsed.diagrams)  ? parsed.diagrams.slice(0, 5)   : [],
    }});
  } catch (err) { console.error(err.message); return res.status(500).json({ error: 'Internal error.' }); }
});

// SUBMIT PAYMENT
app.post('/api/payments/submit', async (req, res) => {
  try {
    const { userId, email, plan, planLabel, upiRef, mobile } = req.body;
    if (!upiRef || !upiRef.trim()) return res.status(400).json({ error: 'UPI Reference required.' });
    if (!plan) return res.status(400).json({ error: 'Plan required.' });
    const { data: existing } = await supabase.from('payments').select('id').eq('upi_ref', upiRef.trim()).single();
    if (existing) return res.status(400).json({ error: 'This UPI reference was already submitted.' });
    const { data: payment, error } = await supabase.from('payments').insert({
      user_id: userId || null, email: email ? email.toLowerCase() : null,
      plan: plan.toString(), plan_label: planLabel || (plan === '10' ? 'One-Time (1 Trial)' : 'Monthly Unlimited'),
      upi_ref: upiRef.trim(), mobile: mobile ? mobile.trim() : null, status: 'pending',
    }).select().single();
    if (error) throw error;
    return res.json({ success: true, message: 'Payment submitted! Admin will verify shortly.', paymentId: payment.id });
  } catch (err) { console.error(err.message); return res.status(500).json({ error: 'Failed to submit.' }); }
});

// REDEEM COUPON
app.post('/api/coupons/redeem', async (req, res) => {
  try {
    const { code, userId } = req.body;
    if (!code) return res.status(400).json({ error: 'Code required.' });
    const { data: coupon } = await supabase.from('coupons').select('*').eq('code', code.trim().toUpperCase()).single();
    if (!coupon) return res.status(404).json({ error: 'Invalid coupon code.' });
    if (!coupon.active) return res.status(400).json({ error: 'Coupon is no longer active.' });
    if (coupon.max_uses && coupon.uses >= coupon.max_uses) return res.status(400).json({ error: 'Coupon fully redeemed.' });
    if (userId) {
      const { data: used } = await supabase.from('coupon_redemptions').select('id').eq('coupon_id', coupon.id).eq('user_id', userId).single();
      if (used) return res.status(400).json({ error: 'You already used this coupon.' });
    }
    const newUses = coupon.uses + 1;
    await supabase.from('coupons').update({ uses: newUses, active: (coupon.max_uses && newUses >= coupon.max_uses) ? false : coupon.active }).eq('id', coupon.id);
    const trialGrant = coupon.trial_grant || 0;
    if (userId) {
      if (trialGrant > 0) {
        const { data: u } = await supabase.from('users').select('trials_total').eq('id', userId).single();
        await supabase.from('users').update({ trials_total: (u?.trials_total || FREE_TRIALS) + trialGrant }).eq('id', userId);
      } else {
        const subExpires = coupon.plan_grant === 'monthly' ? new Date(Date.now() + 30*24*60*60*1000).toISOString() : null;
        await supabase.from('users').update({ subscribed: true, sub_plan: coupon.plan_grant || 'one_time', sub_expires: subExpires }).eq('id', userId);
      }
      await supabase.from('coupon_redemptions').insert({ coupon_id: coupon.id, user_id: userId });
    }
    const msg = trialGrant > 0 ? `Coupon applied! ${trialGrant} trial(s) added.` : 'Coupon applied! Unlimited access granted.';
    return res.json({ success: true, message: msg, type: trialGrant > 0 ? 'trials' : 'unlimited', trial_grant: trialGrant });
  } catch (err) { console.error(err.message); return res.status(500).json({ error: 'Coupon redeem failed.' }); }
});

// USER STATUS
app.get('/api/users/:userId/status', async (req, res) => {
  try {
    const user = await refreshUser(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    return res.json({ success: true, user: {
      id: user.id, email: user.email, name: user.name, role: user.role,
      trials_used: user.trials_used, trials_total: user.trials_total || FREE_TRIALS,
      subscribed: user.subscribed, sub_plan: user.sub_plan, sub_expires: user.sub_expires,
    }});
  } catch (err) { return res.status(500).json({ error: 'Server error.' }); }
});

// USER HISTORY
app.get('/api/users/:userId/history', async (req, res) => {
  try {
    const [pr, ar] = await Promise.all([
      supabase.from('payments').select('*').eq('user_id', req.params.userId).order('submitted_at', { ascending: false }),
      supabase.from('analyses').select('*').eq('user_id', req.params.userId).order('analyzed_at', { ascending: false }),
    ]);
    return res.json({ success: true, payments: pr.data || [], analyses: ar.data || [] });
  } catch (err) { return res.status(500).json({ error: 'Failed to load history.' }); }
});

// ADMIN STATS
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const [ur, pr, cr] = await Promise.all([
      supabase.from('users').select('id, subscribed'),
      supabase.from('payments').select('id, plan, status'),
      supabase.from('coupons').select('id, active'),
    ]);
    const payments = pr.data || [];
    const verified = payments.filter(p => p.status === 'verified');
    return res.json({ success: true, stats: {
      total_users: (ur.data||[]).length, subscribed_users: (ur.data||[]).filter(u=>u.subscribed).length,
      total_payments: payments.length, pending_payments: payments.filter(p=>p.status==='pending').length,
      verified_payments: verified.length, total_revenue: verified.reduce((s,p)=>s+parseInt(p.plan||0),0),
      active_coupons: (cr.data||[]).filter(c=>c.active).length,
    }});
  } catch (err) { return res.status(500).json({ error: 'Failed to load stats.' }); }
});

// ADMIN USERS
app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return res.json({ success: true, users: data });
  } catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

// ADMIN PAYMENTS
app.get('/api/admin/payments', adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('payments').select('*').order('submitted_at', { ascending: false });
    if (error) throw error;
    return res.json({ success: true, payments: data });
  } catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

// VERIFY PAYMENT
app.post('/api/admin/payments/:id/verify', adminAuth, async (req, res) => {
  try {
    const { notes, trialsToGrant } = req.body;
    const { data: payment, error: fe } = await supabase.from('payments').select('*').eq('id', req.params.id).single();
    if (fe || !payment) return res.status(404).json({ error: 'Not found.' });
    if (payment.status === 'verified') return res.status(400).json({ error: 'Already verified.' });
    const numTrials = parseInt(trialsToGrant) || 1;
    await supabase.from('payments').update({
      status: 'verified', verified_at: new Date().toISOString(), verified_by: ADMIN_EMAIL,
      notes: notes || null, trials_granted: payment.plan === '99' ? null : numTrials,
    }).eq('id', payment.id);
    if (payment.plan === '99') {
      const subExpires = new Date(Date.now() + 30*24*60*60*1000).toISOString();
      const ud = { subscribed: true, sub_plan: 'monthly', sub_expires: subExpires };
      if (payment.user_id) await supabase.from('users').update(ud).eq('id', payment.user_id);
      else if (payment.email) await supabase.from('users').update(ud).eq('email', payment.email);
    } else {
      let uid = payment.user_id;
      let currentTotal = FREE_TRIALS;
      if (uid) {
        const { data: u } = await supabase.from('users').select('trials_total').eq('id', uid).single();
        currentTotal = u?.trials_total || FREE_TRIALS;
      } else if (payment.email) {
        const { data: u } = await supabase.from('users').select('id, trials_total').eq('email', payment.email).single();
        if (u) { uid = u.id; currentTotal = u.trials_total || FREE_TRIALS; }
      }
      const ud = { trials_total: currentTotal + numTrials };
      if (uid) await supabase.from('users').update(ud).eq('id', uid);
      else if (payment.email) await supabase.from('users').update(ud).eq('email', payment.email);
    }
    return res.json({ success: true, message: 'Payment verified and access granted.' });
  } catch (err) { console.error(err.message); return res.status(500).json({ error: 'Failed to verify.' }); }
});

// REJECT PAYMENT
app.post('/api/admin/payments/:id/reject', adminAuth, async (req, res) => {
  try {
    const { notes } = req.body;
    await supabase.from('payments').update({ status: 'rejected', verified_at: new Date().toISOString(), verified_by: ADMIN_EMAIL, notes: notes || 'Rejected' }).eq('id', req.params.id);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

// ADMIN COUPONS
app.get('/api/admin/coupons', adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('coupons').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return res.json({ success: true, coupons: data });
  } catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/admin/coupons', adminAuth, async (req, res) => {
  try {
    let { code, maxUses, planGrant, trialGrant } = req.body;
    if (!code || !code.trim()) {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      code = 'VS-' + Array.from({length:8}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
    }
    code = code.trim().toUpperCase();
    maxUses = parseInt(maxUses) || 100;
    trialGrant = parseInt(trialGrant) || 0;
    planGrant = trialGrant > 0 ? 'trials' : (['one_time','monthly'].includes(planGrant) ? planGrant : 'one_time');
    const { data: ex } = await supabase.from('coupons').select('id').eq('code', code).single();
    if (ex) return res.status(400).json({ error: 'Code already exists.' });
    const { data: coupon, error } = await supabase.from('coupons').insert({ code, max_uses: maxUses, plan_grant: planGrant, trial_grant: trialGrant, created_by: ADMIN_EMAIL }).select().single();
    if (error) throw error;
    return res.json({ success: true, coupon });
  } catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

app.put('/api/admin/coupons/:id', adminAuth, async (req, res) => {
  try {
    const { trialGrant, maxUses, planGrant } = req.body;
    const updates = {};
    if (trialGrant !== undefined) updates.trial_grant = parseInt(trialGrant) || 0;
    if (maxUses !== undefined) updates.max_uses = parseInt(maxUses) || 100;
    if (planGrant !== undefined) updates.plan_grant = planGrant;
    await supabase.from('coupons').update(updates).eq('id', req.params.id);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

app.put('/api/admin/coupons/:id/toggle', adminAuth, async (req, res) => {
  try {
    const { data: cp } = await supabase.from('coupons').select('active').eq('id', req.params.id).single();
    if (!cp) return res.status(404).json({ error: 'Not found.' });
    await supabase.from('coupons').update({ active: !cp.active }).eq('id', req.params.id);
    return res.json({ success: true, active: !cp.active });
  } catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

app.delete('/api/admin/coupons/:id', adminAuth, async (req, res) => {
  try {
    await supabase.from('coupons').delete().eq('id', req.params.id);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/admin/users/:id/grant', adminAuth, async (req, res) => {
  try {
    const { plan, trialsToGrant } = req.body;
    let ud;
    if (plan === 'monthly') ud = { subscribed: true, sub_plan: 'monthly', sub_expires: new Date(Date.now()+30*24*60*60*1000).toISOString() };
    else if (plan === 'one_time') ud = { subscribed: true, sub_plan: 'one_time', sub_expires: null };
    else {
      const { data: u } = await supabase.from('users').select('trials_total').eq('id', req.params.id).single();
      ud = { trials_total: (u?.trials_total || FREE_TRIALS) + (parseInt(trialsToGrant) || 1) };
    }
    await supabase.from('users').update(ud).eq('id', req.params.id);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/admin/users/:id/revoke', adminAuth, async (req, res) => {
  try {
    await supabase.from('users').update({ subscribed: false, sub_plan: null, sub_expires: null, trials_total: FREE_TRIALS, trials_used: 0 }).eq('id', req.params.id);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, _next) => { console.error(err.message); res.status(500).json({ error: 'Error.' }); });
app.listen(PORT, () => console.log(`VivaSmart backend v3 → http://localhost:${PORT}`));
