const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// =========================================================================
// ទាញយក API KEYS ដោយសម្ងាត់ពី Render Environment (គ្មាន Key ក្នុង GitHub ឡើយ)
// =========================================================================
const GEMINI_KEY = process.env.GEMINI_KEY;
const OR_KEY     = process.env.OR_KEY;
const GROQ_KEY   = process.env.GROQ_KEY;

// =========================================================================
// ១. BYBIT DATA ENGINE (5,000 CANDLES & TICKER)
// =========================================================================
async function fetch5000Klines(symbol, interval) {
  let allKlines = [];
  let endTime = Date.now();

  for (let i = 0; i < 5; i++) {
    try {
      const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=1000&end=${endTime}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.retCode === 0 && json.result.list && json.result.list.length > 0) {
        const chunk = json.result.list;
        allKlines = allKlines.concat(chunk);
        endTime = parseInt(chunk[chunk.length - 1][0]) - 1;
        if (chunk.length < 1000) break;
      } else break;
    } catch (e) { break; }
  }
  return allKlines;
}

app.get('/api/klines', async (req, res) => {
  const { symbol = 'XAUTUSDT', interval = '5' } = req.query;
  try {
    const rawList = await fetch5000Klines(symbol, interval);
    res.json({ retCode: 0, result: { list: rawList } });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch from Bybit' });
  }
});

app.get('/api/ticker', async (req, res) => {
  const { symbol = 'XAUTUSDT' } = req.query;
  try {
    const response = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch ticker' });
  }
});

// =========================================================================
// ២. ក្បួនគណនាបច្ចេកទេស (EMA, RSI)
// =========================================================================
function calcIndicators(candles) {
  const closes = candles.map(c => c.close);
  const calcEMA = (period) => {
    const k = 2 / (period + 1);
    let ema = closes[0];
    for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
    return ema;
  };
  let gains = 0, losses = 0;
  const start = Math.max(1, closes.length - 14);
  for (let i = start; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const rs = losses === 0 ? 100 : (gains / 14) / (losses / 14);
  const rsi = 100 - (100 / (1 + rs));

  const recentHigh = Math.max(...candles.slice(-24).map(c => c.high));
  const recentLow = Math.min(...candles.slice(-24).map(c => c.low));

  return {
    ema7: calcEMA(7).toFixed(2),
    ema25: calcEMA(25).toFixed(2),
    rsi14: rsi.toFixed(1),
    recentHigh: recentHigh.toFixed(2),
    recentLow: recentLow.toFixed(2)
  };
}

function parseAIJson(rawText, currentPrice) {
  try {
    let clean = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) {
      const obj = JSON.parse(match[0]);
      return {
        signal: (obj.signal || 'WAIT').toUpperCase().includes('BUY') ? 'BUY' : (obj.signal || '').toUpperCase().includes('SELL') ? 'SELL' : 'WAIT',
        confidence: Math.min(99, Math.max(50, parseInt(obj.confidence) || 82)),
        entry: parseFloat(obj.entry) || currentPrice,
        tp: parseFloat(obj.tp) || (currentPrice + 12),
        sl: parseFloat(obj.sl) || (currentPrice - 6),
        reason_km: obj.reason_km || "វិភាគតាមលំនាំទៀន និងសន្ទុះទីផ្សារបច្ចុប្បន្ន។"
      };
    }
  } catch (e) {}
  return {
    signal: 'WAIT',
    confidence: 70,
    entry: currentPrice,
    tp: currentPrice + 10,
    sl: currentPrice - 6,
    reason_km: "ទីផ្សារកំពុងប្រែប្រួល រង់ចាំសញ្ញាណបំបែកតំបន់ច្បាស់លាស់។"
  };
}

// =========================================================================
// ៣. AI COUNCIL ENDPOINT (ប្រើ Keys ពី Environment)
// =========================================================================
app.post('/api/ai-council', async (req, res) => {
  const { round = 1, previousVerdict = null } = req.body || {};

  try {
    const kRes = await fetch('https://api.bybit.com/v5/market/kline?category=linear&symbol=XAUTUSDT&interval=5&limit=60');
    const kJson = await kRes.json();
    if (kJson.retCode !== 0 || !kJson.result.list) throw new Error("Bybit data unavailable");

    const candles = kJson.result.list.reverse().map(c => ({
      open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]), vol: parseFloat(c[5])
    }));
    const last = candles[candles.length - 1];
    const ind = calcIndicators(candles);
    const last8 = candles.slice(-8).map(c => `[O:${c.open},H:${c.high},L:${c.low},C:${c.close},V:${c.vol.toFixed(1)}]`).join(' ');

    const verifyNote = previousVerdict
      ? `Previous round (2.29m ago) consensus was ${previousVerdict.signal} at $${previousVerdict.entry}. Verify if this setup is now CONFIRMED or REVERSED.`
      : `This is Round 1 initial scan.`;

    const prompt = `You are a top Gold Futures (XAUTUSDT) 5m Quant Trader.
Current Price: ${last.close}
EMA7: ${ind.ema7} | EMA25: ${ind.ema25} | RSI14: ${ind.rsi14}
2h High: ${ind.recentHigh} | 2h Low: ${ind.recentLow}
Last 8 Candles (5m): ${last8}
Context: ${verifyNote}

Respond ONLY with valid JSON (no markdown, no extra text):
{
  "signal": "BUY" or "SELL" or "WAIT",
  "confidence": 80-98,
  "entry": number,
  "tp": number,
  "sl": number,
  "reason_km": "សរសេរការវិភាគបច្ចេកទេសសង្ខេប ២ ប្រយោគជាភាសាខ្មែរច្បាស់លាស់ (បញ្ជាក់ពី RSI, EMA, ឬទៀន)"
}`;

    const callGemini = async () => {
      if (!GEMINI_KEY) throw new Error("Missing GEMINI_KEY");
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      const d = await r.json();
      const txt = d.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return { id: 'gemini', name: 'Gemini', ok: r.ok && !!txt, ...parseAIJson(txt, last.close) };
    };

    const callNemotron = async () => {
      if (!OR_KEY) throw new Error("Missing OR_KEY");
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OR_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nvidia/nemotron-3-ultra-550b-a55b:free', messages: [{ role: 'user', content: prompt }] })
      });
      const d = await r.json();
      const txt = d.choices?.[0]?.message?.content || "";
      return { id: 'nemotron', name: 'Nemotron', ok: r.ok && !!txt, ...parseAIJson(txt, last.close) };
    };

    const callGPT = async () => {
      if (!GROQ_KEY) throw new Error("Missing GROQ_KEY");
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: prompt }], temperature: 0.3 })
      });
      const d = await r.json();
      const txt = d.choices?.[0]?.message?.content || "";
      return { id: 'gpt120b', name: 'GPT-120B', ok: r.ok && !!txt, ...parseAIJson(txt, last.close) };
    };

    const callQwen = async () => {
      if (!GROQ_KEY) throw new Error("Missing GROQ_KEY");
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'qwen/qwen3.8-27b', messages: [{ role: 'user', content: prompt }], temperature: 0.3 })
      });
      const d = await r.json();
      const txt = d.choices?.[0]?.message?.content || "";
      return { id: 'qwen', name: 'Qwen 3.8', ok: r.ok && !!txt, ...parseAIJson(txt, last.close) };
    };

    const settled = await Promise.allSettled([callGemini(), callNemotron(), callGPT(), callQwen()]);
    const results = settled.map((s, idx) => {
      const fallbacks = ['gemini', 'nemotron', 'gpt120b', 'qwen'];
      const names = ['Gemini', 'Nemotron', 'GPT-120B', 'Qwen 3.8'];
      if (s.status === 'fulfilled') return s.value;
      return { id: fallbacks[idx], name: names[idx], ok: false, signal: 'WAIT', confidence: 65, entry: last.close, tp: last.close + 10, sl: last.close - 6, reason_km: 'សូមពិនិត្យ Environment Key លើ Render ឡើងវិញ...' };
    });

    let buyVotes = 0, sellVotes = 0, waitVotes = 0;
    results.forEach(r => {
      if (r.signal === 'BUY') buyVotes++;
      else if (r.signal === 'SELL') sellVotes++;
      else waitVotes++;
    });

    let masterSignal = 'WAIT';
    let voteCount = waitVotes;
    if (buyVotes >= sellVotes && buyVotes > waitVotes) { masterSignal = 'BUY'; voteCount = buyVotes; }
    else if (sellVotes > buyVotes && sellVotes > waitVotes) { masterSignal = 'SELL'; voteCount = sellVotes; }
    else if (buyVotes === sellVotes && buyVotes > 0) { masterSignal = 'WAIT'; voteCount = buyVotes; }

    const aligned = results.filter(r => r.signal === masterSignal);
    const avgEntry = (aligned.reduce((a, b) => a + b.entry, 0) / aligned.length).toFixed(2);
    const avgTp    = (aligned.reduce((a, b) => a + b.tp, 0) / aligned.length).toFixed(2);
    const avgSl    = (aligned.reduce((a, b) => a + b.sl, 0) / aligned.length).toFixed(2);
    const avgConf  = Math.round(aligned.reduce((a, b) => a + b.confidence, 0) / aligned.length);

    res.json({
      success: true,
      round,
      timestamp: Date.now(),
      market: { price: last.close, ...ind },
      models: results,
      consensus: {
        signal: masterSignal,
        votes: `${voteCount}/4`,
        confidence: avgConf,
        entry: avgEntry,
        tp: avgTp,
        sl: avgSl,
        verifiedWithPrev: previousVerdict ? (previousVerdict.signal === masterSignal ? 'CONFIRMED' : 'CHANGED') : 'INITIAL'
      }
    });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} - Secured with Environment Variables`);
});
