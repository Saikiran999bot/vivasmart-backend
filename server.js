// ============================================================
//  VivaSmart Backend v2
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

// ── Validate required env vars ────────────────────────────────
const REQUIRED = ['GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error(`❌  Missing env var: ${key}`);
    process.exit(1);
  }
}

const ADMIN_EMAIL  = process.env.ADMIN_EMAIL  || 'saikiranjinde49@gmail.com';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'viva2026';
const FREE_TRIALS  = 3;

// ── Supabase client (service role — full DB access) ───────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Security middleware ───────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(o => o.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error('CORS: origin not allowed → ' + origin));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'x-admin-secret'],
}));

app.use(express.json({ limit: '1mb' }));

// ── Rate limiters ─────────────────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, max: 60,
  message: { error: 'Too many requests. Please wait and try again.' },
}));

const analyzeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10,
  message: { error: 'Hourly analysis limit reached. Please wait before analyzing again.' },
});

// ── Admin auth middleware ─────────────────────────────────────
function adminAuth(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (secret !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
}

// ── Helpers ───────────────────────────────────────────────────
function parseGeminiJSON(raw) {
  let clean = raw.trim().replace(/^```(json)?/, '').replace(/```$/, '').trim();
  try { return JSON.parse(clean); } catch (_) {
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Could not parse AI response.');
  }
}

// ============================================================
//  PUBLIC ROUTES
// ============================================================

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', service: 'VivaSmart API v2', timestamp: new Date().toISOString() }));
app.get('/health', (req, res) => res.json({ status: 'healthy', uptime: process.uptime() }));

// ── LOGIN / REGISTER ──────────────────────────────────────────
// Creates user if not exists, returns user profile
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    // Check if user exists
    let { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = not found
      throw error;
    }

    if (!user) {
      // Create new user
      const { data: newUser, error: createErr } = await supabase
        .from('users')
        .insert({ email: email.toLowerCase(), name: name || email.split('@')[0], role: 'student' })
        .select()
        .single();
      if (createErr) throw createErr;
      user = newUser;
    } else {
      // Update last login
      await supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', user.id);
    }

    // Check if monthly subscription expired
    if (user.subscribed && user.sub_plan === 'monthly' && user.sub_expires) {
      if (new Date(user.sub_expires) < new Date()) {
        await supabase.from('users').update({ subscribed: false, sub_plan: null, sub_expires: null }).eq('id', user.id);
        user.subscribed = false;
      }
    }

    return res.json({
      success: true,
      user: {
        id:          user.id,
        email:       user.email,
        name:        user.name,
        role:        user.role,
        trials_used: user.trials_used,
        subscribed:  user.subscribed,
        sub_plan:    user.sub_plan,
        sub_expires: user.sub_expires,
      }
    });
  } catch (err) {
    console.error('Login error:', err.message);
    return res.status(500).json({ error: 'Server error during login.' });
  }
});

// ── ANALYZE ───────────────────────────────────────────────────
app.post('/api/analyze', analyzeLimiter, async (req, res) => {
  try {
    const { text, userId } = req.body;

    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'Missing text field.' });
    if (text.trim().length < 60) return res.status(400).json({ error: 'Text too short. Upload a valid project PDF.' });
    if (text.length > 15000) return res.status(400).json({ error: 'Text too long. Max 15,000 characters.' });

    // Check user access if userId provided
    if (userId) {
      const { data: user } = await supabase.from('users').select('*').eq('id', userId).single();
      if (user && user.role !== 'admin' && !user.subscribed) {
        if (user.trials_used >= FREE_TRIALS) {
          return res.status(403).json({ error: 'Trial limit reached. Please subscribe to continue.', code: 'TRIAL_LIMIT' });
        }
      }
    }

    // Call Gemini
    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const prompt = `You are an MSBTE polytechnic viva examiner. Analyze this project and return ONLY valid JSON with:
- questions: array of 10 {q,a} objects (viva questions with short, understandable,easy to read answers)
- keywords: array of 20 strings (key technical terms)
- diagrams: array of 5 {title,explanation} objects (diagrams the examiner might ask about)
- projectTitle: string (inferred project name)
PROJECT TEXT: ${text}`;

    const geminiRes = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
      }),
    });

    if (!geminiRes.ok) {
      const errData = await geminiRes.json().catch(() => ({}));
      return res.status(502).json({ error: `Gemini error: ${errData?.error?.message || 'Unknown'}` });
    }

    const geminiData = await geminiRes.json();
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) return res.status(502).json({ error: 'Gemini returned empty response.' });

    const parsed = parseGeminiJSON(rawText);

    // Deduct trial + log analysis in DB
    if (userId) {
      const { data: user } = await supabase.from('users').select('*').eq('id', userId).single();
      if (user && user.role !== 'admin' && !user.subscribed) {
        await supabase.from('users').update({ trials_used: user.trials_used + 1 }).eq('id', userId);
      }
      await supabase.from('analyses').insert({
        user_id: userId,
        email: user?.email || null,
        project_title: parsed.projectTitle || 'Unknown',
      });
    }

    return res.json({
      success: true,
      data: {
        projectTitle: parsed.projectTitle || 'Your Project',
        questions: Array.isArray(parsed.questions) ? parsed.questions.slice(0, 10) : [],
        keywords:  Array.isArray(parsed.keywords)  ? parsed.keywords.slice(0, 20)  : [],
        diagrams:  Array.isArray(parsed.diagrams)  ? parsed.diagrams.slice(0, 5)   : [],
      },
    });

  } catch (err) {
    console.error('Analyze error:', err.message);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── SUBMIT PAYMENT ────────────────────────────────────────────
app.post('/api/payments/submit', async (req, res) => {
  try {
    const { userId, email, plan, upiRef } = req.body;
    if (!email || !plan || !upiRef) return res.status(400).json({ error: 'Missing required fields.' });
    if (!['29', '99'].includes(String(plan))) return res.status(400).json({ error: 'Invalid plan.' });
    if (upiRef.trim().length < 4) return res.status(400).json({ error: 'Invalid UPI reference number.' });

    // Check for duplicate UPI ref
    const { data: dup } = await supabase.from('payments').select('id').eq('upi_ref', upiRef.trim()).single();
    if (dup) return res.status(400).json({ error: 'This UPI reference was already submitted.' });

    const planLabel = plan === '29' ? 'One-Time Analysis' : 'Monthly Unlimited';

    const { data: payment, error } = await supabase.from('payments').insert({
      user_id:    userId || null,
      email:      email.toLowerCase(),
      plan:       String(plan),
      plan_label: planLabel,
      upi_ref:    upiRef.trim(),
      status:     'pending',
    }).select().single();

    if (error) throw error;

    return res.json({ success: true, paymentId: payment.id, message: 'Payment submitted! Admin will verify shortly.' });
  } catch (err) {
    console.error('Payment submit error:', err.message);
    return res.status(500).json({ error: 'Failed to submit payment.' });
  }
});

// ── APPLY COUPON ──────────────────────────────────────────────
app.post('/api/coupons/redeem', async (req, res) => {
  try {
    const { code, userId, email } = req.body;
    if (!code) return res.status(400).json({ error: 'Coupon code is required.' });

    // Find coupon (case-insensitive)
    const { data: coupon, error: cpErr } = await supabase
      .from('coupons')
      .select('*')
      .ilike('code', code.trim())
      .single();

    if (cpErr || !coupon) return res.status(404).json({ error: 'Invalid coupon code.' });
    if (!coupon.active)   return res.status(400).json({ error: 'This coupon is no longer active.' });
    if (coupon.uses >= coupon.max_uses) return res.status(400).json({ error: 'Coupon has been fully redeemed.' });

    // Check if user already used this coupon
    if (userId) {
      const { data: alreadyUsed } = await supabase
        .from('coupon_redemptions')
        .select('id')
        .eq('coupon_id', coupon.id)
        .eq('user_id', userId)
        .single();
      if (alreadyUsed) return res.status(400).json({ error: 'You have already used this coupon.' });
    }

    // Determine subscription grant
    const subExpires = coupon.plan_grant === 'monthly'
      ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      : null;

    // Update coupon uses
    const newUses = coupon.uses + 1;
    const nowInactive = newUses >= coupon.max_uses;
    await supabase.from('coupons').update({
      uses: newUses,
      active: nowInactive ? false : coupon.active,
    }).eq('id', coupon.id);

    // Grant subscription to user
    if (userId) {
      await supabase.from('users').update({
        subscribed:  true,
        sub_plan:    coupon.plan_grant,
        sub_expires: subExpires,
      }).eq('id', userId);

      await supabase.from('coupon_redemptions').insert({
        coupon_id: coupon.id,
        user_id:   userId,
      });
    }

    return res.json({
      success: true,
      message: 'Coupon applied! You now have unlimited access.',
      plan:    coupon.plan_grant,
    });
  } catch (err) {
    console.error('Coupon redeem error:', err.message);
    return res.status(500).json({ error: 'Failed to redeem coupon.' });
  }
});

// ── GET USER STATUS ───────────────────────────────────────────
app.get('/api/users/:userId/status', async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, name, role, trials_used, subscribed, sub_plan, sub_expires')
      .eq('id', req.params.userId)
      .single();

    if (error || !user) return res.status(404).json({ error: 'User not found.' });

    // Check subscription expiry
    if (user.subscribed && user.sub_plan === 'monthly' && user.sub_expires) {
      if (new Date(user.sub_expires) < new Date()) {
        await supabase.from('users').update({ subscribed: false, sub_plan: null, sub_expires: null }).eq('id', user.id);
        user.subscribed = false;
      }
    }

    return res.json({ success: true, user });
  } catch (err) {
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ============================================================
//  ADMIN ROUTES — protected by x-admin-secret header
// ============================================================

// Dashboard stats
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('admin_stats').select('*').single();
    if (error) throw error;
    return res.json({ success: true, stats: data });
  } catch (err) {
    console.error('Stats error:', err.message);
    return res.status(500).json({ error: 'Failed to load stats.' });
  }
});

// All users
app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return res.json({ success: true, users: data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load users.' });
  }
});

// All payments
app.get('/api/admin/payments', adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('payments')
      .select('*, users(name)')
      .order('submitted_at', { ascending: false });
    if (error) throw error;
    return res.json({ success: true, payments: data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load payments.' });
  }
});

// Verify payment → activate user subscription
app.post('/api/admin/payments/:id/verify', adminAuth, async (req, res) => {
  try {
    const { notes } = req.body;

    const { data: payment, error: fetchErr } = await supabase
      .from('payments')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (fetchErr || !payment) return res.status(404).json({ error: 'Payment not found.' });
    if (payment.status === 'verified') return res.status(400).json({ error: 'Already verified.' });

    // Update payment status
    await supabase.from('payments').update({
      status:      'verified',
      verified_at: new Date().toISOString(),
      verified_by: ADMIN_EMAIL,
      notes:       notes || null,
    }).eq('id', payment.id);

    // Grant subscription to user
    const subPlan    = payment.plan === '99' ? 'monthly' : 'one_time';
    const subExpires = subPlan === 'monthly'
      ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      : null;

    if (payment.user_id) {
      await supabase.from('users').update({
        subscribed:  true,
        sub_plan:    subPlan,
        sub_expires: subExpires,
      }).eq('id', payment.user_id);
    } else {
      // Find user by email
      await supabase.from('users').update({
        subscribed:  true,
        sub_plan:    subPlan,
        sub_expires: subExpires,
      }).eq('email', payment.email);
    }

    return res.json({ success: true, message: 'Payment verified and subscription activated.' });
  } catch (err) {
    console.error('Verify payment error:', err.message);
    return res.status(500).json({ error: 'Failed to verify payment.' });
  }
});

// Reject payment
app.post('/api/admin/payments/:id/reject', adminAuth, async (req, res) => {
  try {
    const { notes } = req.body;
    const { error } = await supabase.from('payments').update({
      status:      'rejected',
      verified_at: new Date().toISOString(),
      verified_by: ADMIN_EMAIL,
      notes:       notes || 'Rejected by admin',
    }).eq('id', req.params.id);
    if (error) throw error;
    return res.json({ success: true, message: 'Payment rejected.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reject payment.' });
  }
});

// All coupons
app.get('/api/admin/coupons', adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('coupons')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return res.json({ success: true, coupons: data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load coupons.' });
  }
});

// Create coupon
app.post('/api/admin/coupons', adminAuth, async (req, res) => {
  try {
    let { code, maxUses, planGrant } = req.body;

    // Auto-generate code if blank
    if (!code || !code.trim()) {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      code = 'VS-' + Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    }

    code = code.trim().toUpperCase();
    maxUses = parseInt(maxUses) || 100;
    planGrant = ['one_time', 'monthly'].includes(planGrant) ? planGrant : 'one_time';

    // Check duplicate
    const { data: existing } = await supabase.from('coupons').select('id').eq('code', code).single();
    if (existing) return res.status(400).json({ error: 'Coupon code already exists.' });

    const { data: coupon, error } = await supabase
      .from('coupons')
      .insert({ code, max_uses: maxUses, plan_grant: planGrant, created_by: ADMIN_EMAIL })
      .select()
      .single();

    if (error) throw error;
    return res.json({ success: true, coupon });
  } catch (err) {
    console.error('Create coupon error:', err.message);
    return res.status(500).json({ error: 'Failed to create coupon.' });
  }
});

// Toggle coupon active/inactive
app.put('/api/admin/coupons/:id/toggle', adminAuth, async (req, res) => {
  try {
    const { data: cp } = await supabase.from('coupons').select('active').eq('id', req.params.id).single();
    if (!cp) return res.status(404).json({ error: 'Coupon not found.' });
    const { error } = await supabase.from('coupons').update({ active: !cp.active }).eq('id', req.params.id);
    if (error) throw error;
    return res.json({ success: true, active: !cp.active });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to toggle coupon.' });
  }
});

// Delete coupon
app.delete('/api/admin/coupons/:id', adminAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('coupons').delete().eq('id', req.params.id);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete coupon.' });
  }
});

// Manual grant subscription
app.post('/api/admin/users/:id/grant', adminAuth, async (req, res) => {
  try {
    const { plan } = req.body; // 'one_time' | 'monthly'
    const subPlan    = plan === 'monthly' ? 'monthly' : 'one_time';
    const subExpires = subPlan === 'monthly'
      ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      : null;
    const { error } = await supabase.from('users').update({
      subscribed: true, sub_plan: subPlan, sub_expires: subExpires,
    }).eq('id', req.params.id);
    if (error) throw error;
    return res.json({ success: true, message: 'Subscription granted.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to grant subscription.' });
  }
});

// Revoke subscription
app.post('/api/admin/users/:id/revoke', adminAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('users').update({
      subscribed: false, sub_plan: null, sub_expires: null,
    }).eq('id', req.params.id);
    if (error) throw error;
    return res.json({ success: true, message: 'Subscription revoked.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to revoke subscription.' });
  }
});

// ── Error handlers ────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route not found.' }));
app.use((err, req, res, _next) => {
  console.error('Unhandled:', err.message);
  res.status(500).json({ error: 'Something went wrong.' });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  VivaSmart backend v2 → http://localhost:${PORT}`);
  console.log(`🔑  Gemini API key: ${process.env.GEMINI_API_KEY ? 'loaded ✓' : 'MISSING ✗'}`);
  console.log(`🗄️   Supabase URL:   ${process.env.SUPABASE_URL}`);
  console.log(`🌐  CORS origins:   ${ALLOWED_ORIGINS.join(', ')}`);
});
