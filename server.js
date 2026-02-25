// ============================================================
//  VivaSmart Backend v3 — Gemini proxy + Supabase
//  New in v3: coupon access types, trial grants, mobile field,
//             Rs.10 one-time (1 trial), user history endpoints
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

// ── Validate env ────────────────────────────────────────────
if (!process.env.GEMINI_API_KEY)       { console.error('❌ GEMINI_API_KEY missing'); process.exit(1); }
if (!process.env.SUPABASE_URL)         { console.error('❌ SUPABASE_URL missing');   process.exit(1); }
if (!process.env.SUPABASE_SERVICE_KEY) { console.error('❌ SUPABASE_SERVICE_KEY missing'); process.exit(1); }

const ADMIN_EMAIL  = process.env.ADMIN_EMAIL  || 'saikiranjinde49@gmail.com';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'viva2026';
const FREE_TRIALS  = parseInt(process.env.FREE_TRIALS || '3');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Security middleware ─────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(o => o.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) cb(null, true);
    else cb(new Error('CORS origin not allowed: ' + origin));
  },
  methods: ['GET','POST','PUT','DELETE'],
  allowedHeaders: ['Content-Type','X-Admin-Secret'],
}));
app.use(express.json({ limit: '2mb' }));

// ── Rate limiting ───────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 100,
  message: { error: 'Too many requests. Please wait a few minutes.' },
});
const analyzeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10,
  message: { error: 'Hourly analysis limit reached. Please wait.' },
});
app.use(limiter);

// ── Admin auth middleware ───────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden – admin secret required.' });
  }
  next();
}

// ── Helpers ─────────────────────────────────────────────────
function sanitizeUser(u) {
  return {
    id:           u.id,
    email:        u.email,
    name:         u.name,
    role:         u.role,
    mobile:       u.mobile,
    trials_used:  u.trials_used,
    extra_trials: u.extra_trials,
    subscribed:   u.subscribed,
    sub_plan:     u.sub_plan,
    sub_expires:  u.sub_expires,
    created_at:   u.created_at,
    last_login:   u.last_login,
  };
}

function totalTrialsAllowed(u) {
  return FREE_TRIALS + (u.extra_trials || 0);
}

function userCanAnalyze(u) {
  if (!u) return false;
  if (u.role === 'admin') return true;
  if (u.subscribed) {
    if (!u.sub_expires) return true;
    return new Date(u.sub_expires) > new Date();
  }
  return (u.trials_used || 0) < totalTrialsAllowed(u);
}

// ── Health ──────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'VivaSmart API', version: '3.0.0', timestamp: new Date().toISOString() }));
app.get('/health', (req, res) => res.json({ status: 'healthy', uptime: process.uptime() }));

// ── CONFIG for frontend ─────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({ freeTrials: FREE_TRIALS });
});

// ════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════

// POST /api/auth/login  { email, name }
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required.' });
    const normalEmail = email.trim().toLowerCase();

    // Admin shortcut
    if (normalEmail === ADMIN_EMAIL.toLowerCase()) {
      return res.json({
        success: true,
        user: { id: 'admin', email: normalEmail, name: 'Admin', role: 'admin', subscribed: true, trials_used: 0, extra_trials: 0 }
      });
    }

    // Try to find existing user
    let { data: user, error } = await supabase.from('users').select('*').eq('email', normalEmail).single();

    if (error && error.code === 'PGRST116') {
      // New user — create
      const { data: newUser, error: cErr } = await supabase
        .from('users')
        .insert({ email: normalEmail, name: (name || normalEmail.split('@')[0]).trim() })
        .select().single();
      if (cErr) throw cErr;
      user = newUser;
    } else if (error) {
      throw error;
    } else {
      // Existing — update last_login and name if newly provided
      const updates = { last_login: new Date().toISOString() };
      if (name && name.trim() && name.trim() !== user.name) updates.name = name.trim();
      await supabase.from('users').update(updates).eq('email', normalEmail);
      user = { ...user, ...updates };
    }

    res.json({ success: true, user: sanitizeUser(user) });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ════════════════════════════════════════════════════════════
// USER
// ════════════════════════════════════════════════════════════

// GET /api/user/status?email=...
app.get('/api/user/status', async (req, res) => {
  try {
    const email = (req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email required.' });

    const { data: user, error } = await supabase.from('users').select('*').eq('email', email).single();
    if (error) return res.status(404).json({ error: 'User not found.' });

    const u = sanitizeUser(user);
    u.can_analyze    = userCanAnalyze(user);
    u.trials_allowed = totalTrialsAllowed(user);
    u.free_trials    = FREE_TRIALS;

    res.json({ success: true, user: u });
  } catch (err) {
    res.status(500).json({ error: 'Error fetching status.' });
  }
});

// GET /api/user/history?email=...
app.get('/api/user/history', async (req, res) => {
  try {
    const email = (req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email required.' });

    const [{ data: analyses }, { data: payments }] = await Promise.all([
      supabase.from('analyses').select('id,project_title,analyzed_at').eq('email', email)
        .order('analyzed_at', { ascending: false }).limit(30),
      supabase.from('payments').select('id,plan,upi_ref,mobile,status,submitted_at,verified_at')
        .eq('email', email).order('submitted_at', { ascending: false }),
    ]);

    res.json({ success: true, analyses: analyses || [], payments: payments || [] });
  } catch (err) {
    res.status(500).json({ error: 'Error fetching history.' });
  }
});

// ════════════════════════════════════════════════════════════
// ANALYZE
// ════════════════════════════════════════════════════════════

app.post('/api/analyze', analyzeLimiter, async (req, res) => {
  try {
    const { text, email } = req.body;

    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'Missing or invalid "text" field.' });
    if (text.trim().length < 60) return res.status(400).json({ error: 'Text too short – upload a valid project PDF.' });
    if (text.length > 15000)     return res.status(400).json({ error: 'Text too long – max 15,000 characters.' });

    // Check if user can analyze (if email provided)
    let dbUser = null;
    if (email) {
      const normalEmail = email.trim().toLowerCase();
      if (normalEmail !== ADMIN_EMAIL.toLowerCase()) {
        const { data: u } = await supabase.from('users').select('*').eq('email', normalEmail).single();
        dbUser = u;
        if (dbUser && !userCanAnalyze(dbUser)) {
          return res.status(403).json({ error: 'Trial limit reached. Please subscribe or use a coupon.' });
        }
      }
    }

    const prompt = `You are an MSBTE polytechnic viva examiner. Analyze this student project and return a JSON object with exactly these fields:
- projectTitle: string — the inferred name of the project
- questions: array of exactly 10 objects, each with "q" (question string) and "a" (detailed answer string)
- keywords: array of exactly 20 strings — key technical terms from the project
- diagrams: array of exactly 5 objects, each with "title" (diagram name) and "explanation" (what to say about it)

PROJECT TEXT:
${text}`;

    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const geminiRes = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!geminiRes.ok) {
      const errData = await geminiRes.json().catch(() => ({}));
      return res.status(502).json({ error: `Gemini API error (${geminiRes.status}): ${errData?.error?.message || 'Unknown'}` });
    }

    const geminiData = await geminiRes.json();

    // Extract text — handle both standard and thinking model formats
    let rawText = '';
    const parts = geminiData?.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.text) { rawText += part.text; }
    }
    if (!rawText) return res.status(502).json({ error: 'Gemini returned empty response. Please try again.' });

    let parsed;
    try {
      // Strip markdown code fences if Gemini wraps in ```json ... ```
      let clean = rawText.trim();
      clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      parsed = JSON.parse(clean);
    } catch (_) {
      // Fallback: pull out the first { ... } block
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); }
        catch (_) { return res.status(502).json({ error: 'Could not parse AI response. Please try again.' }); }
      } else {
        return res.status(502).json({ error: 'Could not parse AI response. Please try again.' });
      }
    }

    const result = {
      projectTitle: parsed.projectTitle || 'Your Project',
      questions:    Array.isArray(parsed.questions) ? parsed.questions.slice(0, 10) : [],
      keywords:     Array.isArray(parsed.keywords)  ? parsed.keywords.slice(0, 20)  : [],
      diagrams:     Array.isArray(parsed.diagrams)  ? parsed.diagrams.slice(0, 5)   : [],
    };

    // Log to DB and increment trials
    if (dbUser) {
      await supabase.from('analyses').insert({ user_id: dbUser.id, email: dbUser.email, project_title: result.projectTitle });
      if (!dbUser.subscribed) {
        await supabase.from('users').update({ trials_used: dbUser.trials_used + 1 }).eq('id', dbUser.id);
      }
    } else if (email && email.trim().toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
      // Admin — log but don't count
      await supabase.from('analyses').insert({ email: email.trim().toLowerCase(), project_title: result.projectTitle });
    }

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Analyze error:', err.message);
    res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
});

// ════════════════════════════════════════════════════════════
// PAYMENTS
// ════════════════════════════════════════════════════════════

// POST /api/payments/submit  { email, mobile, plan, upiRef }
app.post('/api/payments/submit', async (req, res) => {
  try {
    const { email, mobile, plan, upiRef } = req.body;
    if (!email || !plan || !upiRef) return res.status(400).json({ error: 'Email, plan, and UPI ref required.' });
    if (!['10','99'].includes(plan)) return res.status(400).json({ error: 'Invalid plan. Must be 10 or 99.' });

    const normalEmail = email.trim().toLowerCase();
    const { data: user } = await supabase.from('users').select('id').eq('email', normalEmail).single();

    const { error } = await supabase.from('payments').insert({
      user_id:  user?.id || null,
      email:    normalEmail,
      mobile:   mobile ? mobile.trim() : null,
      plan,
      upi_ref:  upiRef.trim(),
      status:   'pending',
    });
    if (error) throw error;

    res.json({ success: true, message: '✅ Payment submitted! Admin will verify within 30 minutes and activate your access.' });
  } catch (err) {
    console.error('Payment submit error:', err.message);
    res.status(500).json({ error: 'Failed to submit payment. Please try again.' });
  }
});

// ════════════════════════════════════════════════════════════
// COUPONS
// ════════════════════════════════════════════════════════════

// POST /api/coupons/redeem  { email, code }
app.post('/api/coupons/redeem', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and code required.' });

    const normalEmail = email.trim().toLowerCase();
    const upperCode   = code.trim().toUpperCase();

    const { data: coupon, error: cErr } = await supabase.from('coupons').select('*').eq('code', upperCode).single();
    if (cErr || !coupon)          return res.status(404).json({ error: 'Invalid coupon code.' });
    if (!coupon.active)           return res.status(400).json({ error: 'This coupon is no longer active.' });
    if (coupon.max_uses !== null && coupon.uses >= coupon.max_uses)
                                  return res.status(400).json({ error: 'This coupon has been fully redeemed.' });

    const { data: user, error: uErr } = await supabase.from('users').select('*').eq('email', normalEmail).single();
    if (uErr || !user) return res.status(404).json({ error: 'User not found.' });

    // Check already redeemed
    const { data: existing } = await supabase.from('coupon_redemptions').select('id')
      .eq('coupon_id', coupon.id).eq('user_id', user.id).single();
    if (existing) return res.status(400).json({ error: 'You have already used this coupon.' });

    // Apply
    const updates = {};
    let message = '';
    if (coupon.access_type === 'unlimited') {
      updates.subscribed = true;
      updates.sub_plan   = 'coupon';
      message = '🎉 Coupon applied! You now have unlimited access.';
    } else {
      updates.extra_trials = user.extra_trials + coupon.trials_count;
      message = `🎉 Coupon applied! You got ${coupon.trials_count} extra trial${coupon.trials_count !== 1 ? 's' : ''}.`;
    }

    await Promise.all([
      supabase.from('users').update(updates).eq('id', user.id),
      supabase.from('coupons').update({ uses: coupon.uses + 1 }).eq('id', coupon.id),
      supabase.from('coupon_redemptions').insert({ coupon_id: coupon.id, user_id: user.id }),
    ]);

    // Deactivate if max reached
    if (coupon.max_uses !== null && coupon.uses + 1 >= coupon.max_uses) {
      await supabase.from('coupons').update({ active: false }).eq('id', coupon.id);
    }

    // Return updated user
    const { data: updatedUser } = await supabase.from('users').select('*').eq('id', user.id).single();
    const u = sanitizeUser(updatedUser);
    u.can_analyze    = userCanAnalyze(updatedUser);
    u.trials_allowed = totalTrialsAllowed(updatedUser);
    u.free_trials    = FREE_TRIALS;

    res.json({ success: true, message, user: u });
  } catch (err) {
    console.error('Coupon redeem error:', err.message);
    res.status(500).json({ error: 'Failed to redeem coupon.' });
  }
});

// ════════════════════════════════════════════════════════════
// ADMIN
// ════════════════════════════════════════════════════════════

// Stats
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    // Fetch each stat individually so one failure doesn't kill everything
    const safeCount = async (query) => {
      try { const r = await query; return (r.count !== null && r.count !== undefined) ? r.count : 0; }
      catch { return 0; }
    };
    const safeData = async (query) => {
      try { const r = await query; return r.data || []; }
      catch { return []; }
    };

    const [totalUsers, subUsers, activeCoupons, pendingPay, verifiedPay, totalAnalyses] = await Promise.all([
      safeCount(supabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'student')),
      safeCount(supabase.from('users').select('*', { count: 'exact', head: true }).eq('subscribed', true)),
      safeCount(supabase.from('coupons').select('*', { count: 'exact', head: true }).eq('active', true)),
      safeCount(supabase.from('payments').select('*', { count: 'exact', head: true }).eq('status', 'pending')),
      safeData(supabase.from('payments').select('plan').eq('status', 'verified')),
      safeCount(supabase.from('analyses').select('*', { count: 'exact', head: true })),
    ]);

    const revenue = verifiedPay.reduce((s, p) => s + parseInt(p.plan || 0), 0);
    res.json({ success: true, stats: { totalUsers, subUsers, activeCoupons, pendingPay, revenue, totalAnalyses } });
  } catch (err) {
    console.error('Stats error:', err.message);
    res.status(500).json({ error: 'Failed to get stats.' });
  }
});

// All users
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, users: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get users.' });
  }
});

// All payments
app.get('/api/admin/payments', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('payments').select('*').order('submitted_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, payments: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get payments.' });
  }
});

// Verify payment
app.post('/api/admin/payments/verify', requireAdmin, async (req, res) => {
  try {
    const { paymentId } = req.body;
    if (!paymentId) return res.status(400).json({ error: 'paymentId required.' });

    const { data: payment, error } = await supabase.from('payments').select('*').eq('id', paymentId).single();
    if (error || !payment) return res.status(404).json({ error: 'Payment not found.' });

    await supabase.from('payments').update({ status: 'verified', verified_at: new Date().toISOString(), verified_by: 'admin' }).eq('id', paymentId);

    // Grant access based on plan
    const { data: user } = await supabase.from('users').select('*').eq('email', payment.email).single();
    if (user) {
      if (payment.plan === '99') {
        const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        await supabase.from('users').update({ subscribed: true, sub_plan: 'monthly', sub_expires: expires }).eq('id', user.id);
        await supabase.from('payments').update({ trials_granted: null }).eq('id', paymentId);
      } else if (payment.plan === '10') {
        // One-time = 1 extra trial
        await supabase.from('users').update({ extra_trials: user.extra_trials + 1 }).eq('id', user.id);
        await supabase.from('payments').update({ trials_granted: 1 }).eq('id', paymentId);
      }
    }

    res.json({ success: true, message: 'Payment verified and access granted.' });
  } catch (err) {
    console.error('Verify error:', err.message);
    res.status(500).json({ error: 'Failed to verify payment.' });
  }
});

// Reject payment
app.post('/api/admin/payments/reject', requireAdmin, async (req, res) => {
  try {
    const { paymentId } = req.body;
    await supabase.from('payments').update({ status: 'rejected', verified_at: new Date().toISOString(), verified_by: 'admin' }).eq('id', paymentId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reject payment.' });
  }
});

// All coupons
app.get('/api/admin/coupons', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('coupons').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, coupons: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get coupons.' });
  }
});

// Create coupon
app.post('/api/admin/coupons', requireAdmin, async (req, res) => {
  try {
    const { code, access_type, trials_count, max_uses } = req.body;
    if (!code) return res.status(400).json({ error: 'Coupon code required.' });
    if (!['trials','unlimited'].includes(access_type)) return res.status(400).json({ error: 'access_type must be trials or unlimited.' });

    const { data, error } = await supabase.from('coupons').insert({
      code:         code.trim().toUpperCase(),
      access_type:  access_type,
      trials_count: access_type === 'trials' ? (parseInt(trials_count) || 1) : 1,
      max_uses:     max_uses ? parseInt(max_uses) : null,
      active:       true,
      uses:         0,
    }).select().single();

    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: 'Coupon code already exists.' });
      throw error;
    }

    res.json({ success: true, coupon: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create coupon.' });
  }
});

// Toggle coupon active
app.put('/api/admin/coupons/:id/toggle', requireAdmin, async (req, res) => {
  try {
    const { data: c } = await supabase.from('coupons').select('active').eq('id', req.params.id).single();
    await supabase.from('coupons').update({ active: !c.active }).eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle coupon.' });
  }
});

// Delete coupon
app.delete('/api/admin/coupons/:id', requireAdmin, async (req, res) => {
  try {
    await supabase.from('coupons').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete coupon.' });
  }
});

// Grant extra trials to user
app.post('/api/admin/users/grant-trials', requireAdmin, async (req, res) => {
  try {
    const { email, trials } = req.body;
    if (!email || !trials) return res.status(400).json({ error: 'Email and trials required.' });
    const { data: u } = await supabase.from('users').select('extra_trials').eq('email', email.trim().toLowerCase()).single();
    if (!u) return res.status(404).json({ error: 'User not found.' });
    await supabase.from('users').update({ extra_trials: u.extra_trials + parseInt(trials) }).eq('email', email.trim().toLowerCase());
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to grant trials.' });
  }
});

// ── 404 & error handlers ────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route not found.' }));
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Something went wrong.' });
});

app.listen(PORT, () => {
  console.log(`✅ VivaSmart backend v3 running on http://localhost:${PORT}`);
  console.log(`🔑 Gemini key: ${process.env.GEMINI_API_KEY ? '✓ loaded' : '✗ MISSING'}`);
  console.log(`🗄️  Supabase:   ${process.env.SUPABASE_URL ? '✓ connected' : '✗ MISSING'}`);
});
