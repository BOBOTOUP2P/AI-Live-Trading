const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

// ទាញយក API KEYS ដោយសម្ងាត់ពី Render Environment
const GEMINI_KEY = process.env.GEMINI_KEY;
const OR_KEY     = process.env.OR_KEY;
const GROQ_KEY   = process.env.GROQ_KEY;

// =========================================================================
// ១. PROXY FALLBACK (Bybit -> Gate.io XAUT_USDT -> OKX XAUT-USDT-SWAP)
// =========================================================================
async function fetchFallbackKlines() {
  // 1. សាកល្បង Gate.io Futures (មិន Block US Render)
  try {
    const gRes = await fetch('https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=XAUT_USDT&interval=5m&limit=1000');
    if (gRes.ok) {
      const gData = await gRes.json();
      if (Array.isArray(gData) && gData.length > 0) {
        return {
          source: 'Gate.io Futures',
          list: gData.map(c => [
            String(c.t * 1000), String(c.o), String(c.h), String(c.l), String(c.c), String(c.v || 0), String(c.sum || 0)
          ]).reverse()
        };
      }
    }
  } catch (e) {}

  // 2. សាកល្បង OKX Swap
  try {
    const oRes = await fetch('https://www.okx.com/api/v5/market/candles?instId=XAUT-USDT-SWAP&bar=5m&limit=300');
    if (oRes.ok) {
      const oJson = await oRes.json();
      if (oJson.code === '0' && oJson.data) {
        return {
          source: 'OKX Swap',
          list: oJson.data.map(c => [c[0], c[1], c[2], c[3], c[4], c[5], c[7]])
        };
      }
    }
  } catch (e) {}

  return { source: 'none', list: [] };
}

app.get('/api/klines', async (req, res) => {
  const { symbol = 'XAUTUSDT', interval = '5' } = req.query;
  try {
    // សាកល្បង Bybit (ដើរប្រសិនបើ Render នៅ Singapore/EU)
    const bRes = await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=1000`);
    if (bRes.ok) {
      const bJson = await bRes.json();
      if (bJson.retCode === 0 && bJson.result?.list?.length > 0) {
        return res.json({ retCode: 0, source: 'Bybit', result: { list: bJson.result.list } });
      }
    }
    // បើ Bybit Block IP អាមេរិក បង្វែរទៅ Gate/OKX ភ្លាម
    const fb = await fetchFallbackKlines();
    res.json({ retCode: 0, source: fb.source, result: { list: fb.list } });
  } catch (error) {
    const fb = await fetchFallbackKlines();
    res.json({ retCode: 0, source: fb.source, result: { list: fb.list } });
  }
});

app.get('/api/ticker', async (req, res) => {
  const { symbol = 'XAUTUSDT' } = req.query;
  try {
    const bRes = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`);
    if (bRes.ok) {
      const bJson = await bRes.json();
      if (bJson.retCode === 0 && bJson.result?.list?.[0]) return res.json(bJson);
    }
    // Fallback Gate.io Ticker
    const gRes = await fetch('https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=XAUT_USDT');
    if (gRes.ok) {
      const gArr = await gRes.json();
      const g = gArr[0];
      if (g) {
        return res.json({
          retCode: 0,
          result: {
            list: [{
              lastPrice: g.last,
              markPrice: g.mark_price,
              highPrice24h: g.high_24h,
              lowPrice24h: g.low_24h,
              turnover24h: String(parseFloat(g.volume_24h_settle || 0)),
              price24hPcnt: String(parseFloat(g.change_percentage || 0) / 100)
            }]
          }
        });
      }
    }
    res.status(500).json({ error: 'Ticker unavailable' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch ticker' });
  }
});

// =========================================================================
// ២. ក្បួនគណនាបច្ចេកទេស & AI COUNCIL
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

app.post('/api/ai-council', async (req, res) => {
  const { round = 1, previousVerdict = null, candles: clientCandles = [] } = req.body || {};

  try {
    let candles = clientCandles;
    // ប្រសិនបើ Browser មិនបានផ្ញើទៀនមក ទាញពី Fallback Server
    if (!candles || candles.length < 10) {
      const fb = await fetchFallbackKlines();
      candles = fb.list.reverse().slice(-60).map(c => ({
        open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]), vol: parseFloat(c[5] || 0)
      }));
    }

    if (!candles || candles.length === 0) throw new Error("No candle data available");

    const last = candles[candles.length - 1];
    const ind = calcIndicators(candles);
    const last8 = candles.slice(-8).map(c => `[O:${c.open},H:${c.high},L:${c.low},C:${c.close}]`).join(' ');

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
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      const d = await r.json();
      const txt = d.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return { id: 'gemini', name: 'Gemini', ok: r.ok && !!txt, ...parseAIJson(txt, last.close) };
    };

    const callNemotron = async () => {
      if (!OR_KEY) throw new Error("Missing OR_KEY");
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', headers: { 'Authorization': `Bearer ${OR_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nvidia/nemotron-3-ultra-550b-a55b:free', messages: [{ role: 'user', content: prompt }] })
      });
      const d = await r.json();
      const txt = d.choices?.[0]?.message?.content || "";
      return { id: 'nemotron', name: 'Nemotron', ok: r.ok && !!txt, ...parseAIJson(txt, last.close) };
    };

    const callGPT = async () => {
      if (!GROQ_KEY) throw new Error("Missing GROQ_KEY");
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: prompt }], temperature: 0.3 })
      });
      const d = await r.json();
      const txt = d.choices?.[0]?.message?.content || "";
      return { id: 'gpt120b', name: 'GPT-120B', ok: r.ok && !!txt, ...parseAIJson(txt, last.close) };
    };

    const callQwen = async () => {
      if (!GROQ_KEY) throw new Error("Missing GROQ_KEY");
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
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
      return { id: fallbacks[idx], name: names[idx], ok: false, signal: 'WAIT', confidence: 65, entry: last.close, tp: last.close + 10, sl: last.close - 6, reason_km: 'កំពុងភ្ជាប់ឡើងវិញ...' };
    });

    let buyVotes = 0, sellVotes = 0, waitVotes = 0;
    results.forEach(r => { if (r.signal === 'BUY') buyVotes++; else if (r.signal === 'SELL') sellVotes++; else waitVotes++; });

    let masterSignal = 'WAIT', voteCount = waitVotes;
    if (buyVotes >= sellVotes && buyVotes > waitVotes) { masterSignal = 'BUY'; voteCount = buyVotes; }
    else if (sellVotes > buyVotes && sellVotes > waitVotes) { masterSignal = 'SELL'; voteCount = sellVotes; }

    const aligned = results.filter(r => r.signal === masterSignal);
    const avgEntry = (aligned.reduce((a, b) => a + b.entry, 0) / aligned.length).toFixed(2);
    const avgTp    = (aligned.reduce((a, b) => a + b.tp, 0) / aligned.length).toFixed(2);
    const avgSl    = (aligned.reduce((a, b) => a + b.sl, 0) / aligned.length).toFixed(2);
    const avgConf  = Math.round(aligned.reduce((a, b) => a + b.confidence, 0) / aligned.length);

    res.json({
      success: true, round, timestamp: Date.now(), market: { price: last.close, ...ind }, models: results,
      consensus: {
        signal: masterSignal, votes: `${voteCount}/4`, confidence: avgConf, entry: avgEntry, tp: avgTp, sl: avgSl,
        verifiedWithPrev: previousVerdict ? (previousVerdict.signal === masterSignal ? 'CONFIRMED' : 'CHANGED') : 'INITIAL'
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.listen(PORT, () => console.log(`Server running on port ${PORT} with Multi-Exchange Fallback`));
