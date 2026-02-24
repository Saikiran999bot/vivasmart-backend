# VivaSmart Backend — Setup & Hosting Guide

## 🔑 How the API Key is Hidden

```
Browser (vivasmart.html)
       |
       | POST /api/analyze  (sends only PDF text)
       ↓
YOUR BACKEND (server.js)
       |
       | Uses GEMINI_API_KEY from .env (never sent to browser!)
       ↓
Gemini API
```

The API key **only lives on your server** in the `.env` file. The browser never sees it.

---

## 📁 File Structure

```
vivasmart-backend/
├── server.js        ← Main backend (Node.js + Express)
├── package.json     ← Dependencies
├── .env             ← Your secrets (NEVER commit to GitHub)
├── .env.example     ← Template (safe to commit)
└── .gitignore       ← Ignores .env and node_modules
```

---

## 🚀 Step 1: Run Locally (Test First)

```bash
# 1. Install Node.js from https://nodejs.org (v18 or newer)

# 2. Go into the backend folder
cd vivasmart-backend

# 3. Install dependencies
npm install

# 4. Create your .env file
cp .env.example .env

# 5. Edit .env and paste your Gemini API key
#    Get key at: https://aistudio.google.com/app/apikey

# 6. Start the server
npm start

# You should see:
# ✅  VivaSmart backend running on http://localhost:3000
# 🔑  Gemini API key loaded: ✓ YES (hidden)
```

Then open `vivasmart.html` in your browser — it will call `http://localhost:3000`.

---

## ☁️ Step 2: Deploy to the Cloud (Free Options)

### Option A: Render.com ⭐ RECOMMENDED (Free Forever)

1. Push your backend folder to GitHub (make sure `.env` is in `.gitignore`)
2. Go to [render.com](https://render.com) → Sign up free
3. Click **New → Web Service**
4. Connect your GitHub repo
5. Set these settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** `Node`
6. Click **Environment Variables** and add:
   - `GEMINI_API_KEY` = your actual key
   - `ALLOWED_ORIGINS` = URL of your frontend (or `*` for now)
7. Click **Deploy** — you'll get a URL like `https://vivasmart-backend.onrender.com`

### Option B: Railway.app (Free $5 credit/month)

1. Go to [railway.app](https://railway.app) → Sign up with GitHub
2. Click **New Project → Deploy from GitHub Repo**
3. Select your backend repo
4. Go to **Variables** tab and add `GEMINI_API_KEY`
5. Railway auto-detects Node.js and deploys
6. Get your URL from **Settings → Domains**

### Option C: Vercel (Serverless Functions)

Requires slight code restructuring. Use Render or Railway instead for simplicity.

---

## 🔧 Step 3: Update Frontend URL

Once deployed, open `vivasmart.html` and change this one line near the top of the `<script>` tag:

```javascript
// BEFORE (local testing):
const BACKEND_URL = 'http://localhost:3000';

// AFTER (production):
const BACKEND_URL = 'https://vivasmart-backend.onrender.com';
```

---

## 🌐 Step 4: Host the Frontend (vivasmart.html)

Since it's a single HTML file, you can host it anywhere for free:

| Platform | How | URL Format |
|----------|-----|------------|
| **Netlify** | Drag & drop the file at netlify.com/drop | `yoursite.netlify.app` |
| **GitHub Pages** | Put in a repo, enable Pages | `username.github.io/vivasmart` |
| **Vercel** | `npx vercel` in folder | `yoursite.vercel.app` |

---

## 🔒 Security Features Included

- ✅ API key hidden on server (never in browser)
- ✅ Rate limiting: 30 requests/15 min per IP
- ✅ Analyze rate limit: 10 analyses/hour per IP
- ✅ CORS protection (restrict to your domain)
- ✅ Input validation (length, type checks)
- ✅ Helmet.js security headers
- ✅ Error messages never expose internals

---

## ❓ Quick Checklist

- [ ] Got Gemini API key from https://aistudio.google.com/app/apikey
- [ ] Added key to `.env` (locally) and Render/Railway env vars (deployed)
- [ ] Ran `npm install` and `npm start` locally to test
- [ ] Deployed backend and got a URL
- [ ] Updated `BACKEND_URL` in `vivasmart.html`
- [ ] Hosted `vivasmart.html` on Netlify/GitHub Pages
- [ ] Set `ALLOWED_ORIGINS` to your frontend URL for security
