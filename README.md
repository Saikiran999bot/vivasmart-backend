# VivaSmart v4.0 — AI Viva Prep Platform

> AI-powered MSBTE polytechnic viva preparation — upload your project PDF and get tailored questions, keywords, and diagram tips in 30 seconds.

---

## 📦 Files

| File | Description |
|------|-------------|
| `index.html` | Frontend — single-page app (upload, results, profile, admin) |
| `server.js` | Backend — Node.js/Express API (Gemini + Supabase) |
| `package.json` | Node dependencies |
| `supabase_schema.sql` | Database schema + seed coupons |
| `README.md` | This file |

---

## ✨ Features

### For Students
- **Free tier** — 3 analyses included at signup
- **Profile & Account** — view subscription status, days/trials left, full history
- **Analysis History** — all past project analyses with project titles
- **Payment History** — payment status (pending/verified/rejected), UPI ref, trials granted
- **Coupon History** — which coupons were redeemed and what was received
- **Coupon Redemption** — enter a code to get extra trials or unlimited access
- **PDF Report Download** — download full viva Q&A, keywords, diagrams as PDF
- **Edit Display Name** — update name from profile modal

### Subscription Plans
- **Free** — 3 analyses at signup
- **Rs.10 One-Time** — 1 extra analysis trial (pay once)
- **Rs.99 Monthly** — unlimited analyses for 30 days

### For Admin (`saikiranjinde49@gmail.com`)
- **Dashboard Stats** — users, revenue, payments, analyses, coupons
- **Payment Management** — verify/reject with custom trial grants
- **Coupon Creation** — custom code, max uses, type, note, expiry date
- **Coupon Management** — toggle active/inactive, edit, delete
- **User Management** — search users, view subscription + trials
- **User Editing** — grant monthly (custom days), grant one-time, add/set trials, reset used count, update name, revoke all access
- **Live User Updates** — changes reflect immediately in user's profile modal

---

## 🚀 Deployment

### 1. Supabase Setup
1. Go to [supabase.com](https://supabase.com) → create project
2. SQL Editor → paste `supabase_schema.sql` → Run
3. Copy **Project URL** and **service_role key** from Settings → API

### 2. Render Deployment
1. Push all files to a GitHub repo
2. Create a **Web Service** on [render.com](https://render.com)
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Add Environment Variables:

| Variable | Value |
|----------|-------|
| `GEMINI_API_KEY` | Your Gemini API key from [aistudio.google.com](https://aistudio.google.com) |
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Supabase service_role key |
| `ADMIN_EMAIL` | `saikiranjinde49@gmail.com` |
| `ADMIN_SECRET` | `viva2026` |

6. Deploy → copy the URL (e.g. `https://vivasmart-abc123.onrender.com`)

### 3. Connect Frontend
Open `index.html` — find line ~985:
```js
var BACKEND_URL = 'https://vivasmart-backend.onrender.com'; // ← change this
```
Replace with your actual Render URL. Open in browser — done!

### 4. Test
```
GET  https://your-url.onrender.com/health  → {"status":"healthy"}
```

---

## 🔑 Default Admin Credentials
```
Email:  saikiranjinde49@gmail.com
Secret: viva2026
```
Change `ADMIN_SECRET` in Render environment to something secure for production.

---

## 🗃️ Database Tables

| Table | Description |
|-------|-------------|
| `users` | Student accounts with trial counts and subscription |
| `coupons` | Coupon codes with type, uses, expiry |
| `coupon_redemptions` | Which user used which coupon |
| `payments` | UPI payment submissions and verification status |
| `analyses` | Log of every AI analysis run |

### Key Fields
**users:**
- `trials_used` / `trials_total` — free analysis quota
- `subscribed` / `sub_plan` / `sub_expires` — subscription state
- Backend auto-expires monthly plans on login

**coupons:**
- `trial_grant = 0` → grants full unlimited access
- `trial_grant = N` → adds N extra analyses
- `plan_grant = 'monthly'` → grants 30-day access
- `expiry_date` — optional auto-deactivation date

---

## 📡 API Reference

### Auth
```
POST /api/auth/login          { email, name }         → user object
```

### User
```
GET  /api/users/:id/status    → refreshed user data
PUT  /api/users/:id/name      { name }                → update display name
GET  /api/users/:id/history   → { payments, analyses, coupons }
```

### Core
```
POST /api/analyze             { text, userId }        → { questions, keywords, diagrams }
POST /api/payments/submit     { userId, email, plan, upiRef, mobile }
POST /api/coupons/redeem      { code, userId }
```

### Admin (x-admin-secret header required)
```
GET  /api/admin/stats
GET  /api/admin/payments
POST /api/admin/payments/:id/verify  { trialsToGrant }
POST /api/admin/payments/:id/reject  { notes }
GET  /api/admin/coupons
POST /api/admin/coupons              { code, maxUses, planGrant, trialGrant, note, expiryDate }
PUT  /api/admin/coupons/:id          { trialGrant, maxUses, planGrant, note, expiryDate }
PUT  /api/admin/coupons/:id/toggle
DELETE /api/admin/coupons/:id
GET  /api/admin/users
GET  /api/admin/users/:id
PUT  /api/admin/users/:id    { action, daysToGrant, trialsToAdd, trialsTotal, name }
```

**User actions:** `grant_monthly`, `grant_one_time`, `add_trials`, `set_trials`, `reset_used`, `revoke_all`, `update_name`

---

## 🛠 Local Development
```bash
# 1. Create .env file
cat > .env << 'ENVEOF'
GEMINI_API_KEY=your_key_here
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=your_service_key_here
ADMIN_EMAIL=saikiranjinde49@gmail.com
ADMIN_SECRET=viva2026
ENVEOF

# 2. Install and run
npm install
npm start

# 3. Open index.html in browser
# Update BACKEND_URL to http://localhost:3000
```

---

## 🔄 Upgrade from v3
Just run the migration section in `supabase_schema.sql`:
```sql
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS expiry_date TIMESTAMPTZ;
-- (all other ALTER TABLE lines are safe to re-run)
```

---

Made with ❤️ by **Saikiran Jinde** | Powered by **Gemini 2.5 Flash** + **Supabase**
