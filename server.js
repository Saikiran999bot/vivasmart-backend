// ============================================================
//  VivaSmart Backend — Gemini API Proxy
//  Keeps your API key safe on the server side
// ============================================================
require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const rateLimit = require('express-rate-limit');
const fetch    = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Validate env ──────────────────────────────────────────────
if (!process.env.GEMINI_API_KEY) {
  console.error('❌  GEMINI_API_KEY is not set in .env file!');
  process.exit(1);
}

// ── Security middleware ───────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,   // allow frontend to call API freely
}));

// CORS — only allow your frontend origin
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(o => o.trim());
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl) or matching origins
    if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS: origin not allowed → ' + origin));
    }
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json({ limit: '1mb' }));  // Limit body size

// ── Rate limiting — prevent API abuse ─────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 30,                     // max 30 requests per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a few minutes and try again.' },
});

const analyzeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour
  max: 10,                     // max 10 analyses per hour per IP
  message: { error: 'Hourly analysis limit reached. Please wait before analyzing again.' },
});

app.use(limiter);

// ── Health check endpoint ─────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'VivaSmart API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', uptime: process.uptime() });
});

// ── MAIN: Gemini Analyze Endpoint ─────────────────────────────
app.post('/api/analyze', analyzeLimiter, async (req, res) => {
  try {
    const { text } = req.body;

    // Validate input
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid "text" field in request body.' });
    }
    if (text.trim().length < 60) {
      return res.status(400).json({ error: 'Text too short. Please upload a valid project PDF.' });
    }
    if (text.length > 15000) {
      return res.status(400).json({ error: 'Text too long. Max 15,000 characters.' });
    }

    const prompt = `You are an MSBTE polytechnic viva examiner. Analyze this project and return ONLY valid JSON with:
- questions: array of 10 {q,a} objects (viva questions with short and understandable answers)
- keywords: array of 20 strings (key technical terms)
- diagrams: array of 5 {title,explanation} objects (diagrams the examiner might ask about)
- projectTitle: string (inferred project name)

PROJECT TEXT:
${text}`;

    // Call Gemini API (key stays on server!)
    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

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
      console.error('Gemini error:', errData);
      return res.status(502).json({
        error: `Gemini API error (${geminiRes.status}): ${errData?.error?.message || 'Unknown error'}`,
      });
    }

    const geminiData = await geminiRes.json();
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!rawText) {
      return res.status(502).json({ error: 'Gemini returned an empty response. Please try again.' });
    }

    // Parse and validate JSON from Gemini
    let parsed;
    try {
      let clean = rawText.trim().replace(/^```(json)?/, '').replace(/```$/, '').trim();
      parsed = JSON.parse(clean);
    } catch (_) {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); }
        catch (_) { return res.status(502).json({ error: 'Could not parse AI response. Please try again.' }); }
      } else {
        return res.status(502).json({ error: 'Could not parse AI response. Please try again.' });
      }
    }

    // Return clean result (never expose API key or internal details)
    return res.json({
      success: true,
      data: {
        projectTitle: parsed.projectTitle || 'Your Project',
        questions:    Array.isArray(parsed.questions)  ? parsed.questions.slice(0,10)  : [],
        keywords:     Array.isArray(parsed.keywords)   ? parsed.keywords.slice(0,20)   : [],
        diagrams:     Array.isArray(parsed.diagrams)   ? parsed.diagrams.slice(0,5)    : [],
      },
    });

  } catch (err) {
    console.error('Server error:', err.message);
    return res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
});

// ── 404 handler ───────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

// ── Global error handler ──────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Something went wrong.' });
});

// ── Start server ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  VivaSmart backend running on http://localhost:${PORT}`);
  console.log(`🔑  Gemini API key loaded: ${process.env.GEMINI_API_KEY ? '✓ YES (hidden)' : '✗ MISSING'}`);
  console.log(`🌐  CORS allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
