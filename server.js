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
// ១. FOREX FACTORY ECONOMIC CALENDAR ENGINE (10-Min Cache)
// =========================================================================
let ffCache = { timestamp: 0, events: [] };

async function getForexFactoryUSDNews() {
  const now = Date.now();
  if (ffCache.events.length > 0 && (now - ffCache.timestamp) < 10 * 60 * 1000) {
    return ffCache.events;
  }

  try {
    const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
    if (res.ok) {
      const allEvents = await res.json();
      if (Array.isArray(allEvents)) {
        const usdEvents = allEvents
          .filter(ev => ev.country === 'USD' && (ev.impact === 'High' || ev.impact === 'Medium'))
          .map(ev => {
            const eventMs = new Date(ev.date).getTime();
            const khTime = new Date(eventMs).toLocaleString('en-GB', {
              timeZone: 'Asia/Phnom_Penh',
              day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
            });
            return {
              title: ev.title,
              impact: ev.impact,
              timestamp: eventMs,
              khTime: khTime,
              forecast: ev.forecast || '--',
              previous: ev.previous || '--'
            };
          })
          .sort((a, b) => a.timestamp - b.timestamp);

        ffCache = { timestamp: now, events: usdEvents };
        return usdEvents;
      }
    }
  } catch (e) {
    console.error('Forex Factory Fetch Error:', e.message);
  }
  return ffCache.events;
}

app.get('/api/news', async (req, res) => {
  const events = await getForexFactoryUSDNews();
  const now = Date.now();
  const relevant = events.filter(ev => ev.timestamp >= now - 2 * 3600 * 1000).slice(0, 8);
  res.json({ success: true, events: relevant });
});

// =========================================================================
// ២. BYBIT / OKX / GATE.IO MARKET DATA PROXY (សម្រាប់ទៀន 2h)
// =========================================================================
async function fetchFallback2hKlines() {
  // 1. OKX Swap 2H (គាំទ្រ 2H ដោយផ្ទាល់ និងមិន Block US Render)
  try {
    const oRes = await fetch('https://www.okx.com/api/v5/market/candles?instId=XAUT-USDT-SWAP&bar=2H&limit=300');
    if (oRes.ok) {
      const oJson = await oRes.json();
      if (oJson.code === '0' && oJson.data && oJson.data.length > 0) {
        return { source: 'OKX', list: oJson.data.map(c => [c[0], c[1], c[2], c[3], c[4], c[5], c[7]]) };
      }
    }
  } catch (e) {}

  // 2. Gate.io Futures (ទាញ 1h មកផ្គុំជា 2h)
  try {
    const gRes = await fetch('https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=XAUT_USDT&interval=1h&limit=1000');
    if (gRes.ok) {
      const gData = await gRes.json();
      if (Array.isArray(gData) && gData.length > 0) {
        const grouped = new Map();
        gData.forEach(c => {
          const t2h = c.t - (c.t % 7200);
          if (!grouped.has(t2h)) {
            grouped.set(t2h, { t: t2h, o: parseFloat(c.o), h: parseFloat(c.h), l: parseFloat(c.l), c: parseFloat(c.c), v: parseFloat(c.v || 0), sum: parseFloat(c.sum || 0) });
          } else {
            const cur = grouped.get(t2h);
            cur.h = Math.max(cur.h, parseFloat(c.h));
            cur.l = Math.min(cur.l, parseFloat(c.l));
            cur.c = parseFloat(c.c);
            cur.v += parseFloat(c.v || 0);
            cur.sum += parseFloat(c.sum || 0);
          }
        });
        const list2h = Array.from(grouped.values()).map(x => [
          String(x.t * 1000), String(x.o), String(x.h), String(x.l), String(x.c), String(x.v), String(x.sum)
        ]).reverse();
        return { source: 'Gate.io', list: list2h };
      }
    }
  } catch (e) {}

  return { source: 'none', list: [] };
}

app.get('/api/klines', async (req, res) => {
  const { symbol = 'XAUTUSDT', interval = '120' } = req.query;
  try {
    const bRes = await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=1000`);
    if (bRes.ok) {
      const bJson = await bRes.json();
      if (bJson.retCode === 0 && bJson.result?.list?.length > 0) {
        return res.json({ retCode: 0, source: 'Bybit', result: { list: bJson.result.list } });
      }
    }
    const fb = await fetchFallback2hKlines();
    res.json({ retCode: 0, source: fb.source, result: { list: fb.list } });
  } catch (error) {
    const fb = await fetchFallback2hKlines();
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
    const gRes = await fetch('https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=XAUT_USDT');
    if (gRes.ok) {
      const gArr = await gRes.json();
      const g = gArr[0];
      if (g) {
        return res.json({
          retCode: 0,
          result: {
            list: [{
              lastPrice: g.last, markPrice: g.mark_price, highPrice24h: g.high_24h, lowPrice24h: g.low_24h,
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
// ៣. ក្បួនគណនាបច្ចេកទេស & AI COUNCIL (SHARED 30-MINUTE CACHE LOCK)
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
        tp: parseFloat(obj.tp) || (currentPrice + 35),
        sl: parseFloat(obj.sl) || (currentPrice - 18),
        reason_km: obj.reason_km || "វិភាគតាមរចនាសម្ព័ន្ធទៀន 2h និងព័ត៌មានសេដ្ឋកិច្ចបច្ចុប្បន្ន។"
      };
    }
  } catch (e) {}
  return {
    signal: 'WAIT', confidence: 70, entry: currentPrice, tp: currentPrice + 30, sl: currentPrice - 15,
    reason_km: "ទីផ្សារកំពុងប្រែប្រួល រង់ចាំសញ្ញាណបំបែកតំបន់ច្បាស់លាស់។"
  };
}

// ប្រព័ន្ធរក្សាទុកលទ្ធផលរួមរៀងរាល់ 30 នាទី (1,800,000 ms) ការពារអស់ Limit
const SCAN_INTERVAL_MS = 30 * 60 * 1000;
let councilState = {
  round: 0,
  lastScanTime: 0,
  nextScanTime: 0,
  previousConsensus: null,
  latestResponse: null
};
let activeScanPromise = null;

async function executeCouncilScan(clientCandles) {
  let candles = clientCandles;
  if (!candles || candles.length < 10) {
    const fb = await fetchFallback2hKlines();
    candles = fb.list.reverse().slice(-60).map(c => ({
      open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]), vol: parseFloat(c[5] || 0)
    }));
  }
  if (!candles || candles.length === 0) throw new Error("No 2h candle data available");

  councilState.round += 1;
  const round = councilState.round;
  const previousVerdict = councilState.previousConsensus;

  const last = candles[candles.length - 1];
  const ind = calcIndicators(candles);
  const last10 = candles.slice(-10).map(c => `[O:${c.open},H:${c.high},L:${c.low},C:${c.close}]`).join(' ');

  // ទាញយកព័ត៌មាន Forex Factory មកឱ្យ AI វិភាគរួមគ្នា (មិនរារាំងការចូលផ្សារទេ)
  const nowMs = Date.now();
  const allNews = await getForexFactoryUSDNews();
  const nearNews = allNews.filter(n => Math.abs(n.timestamp - nowMs) <= 6 * 3600 * 1000).slice(0, 4);
  const newsSummary = nearNews.length > 0
    ? nearNews.map(n => {
        const diffMin = Math.round((n.timestamp - nowMs) / 60000);
        const timing = diffMin >= 0 ? `in ${diffMin} mins` : `${Math.abs(diffMin)} mins ago`;
        return `${n.impact} Impact USD News: "${n.title}" (${timing}, Forecast: ${n.forecast}, Prev: ${n.previous})`;
      }).join(' | ')
    : "No High/Medium Impact USD news within ±6 hours.";

  const verifyNote = previousVerdict
    ? `Previous 30m round consensus was ${previousVerdict.signal} at $${previousVerdict.entry}. Verify if setup is CONFIRMED or REVERSED.`
    : `This is Round 1 initial 2h scan.`;

  const prompt = `You are an elite Gold Futures (XAUTUSDT) 2-Hour (2h) Swing & Quant Trader.
Current Price: ${last.close}
2h Indicators -> EMA7: ${ind.ema7} | EMA25: ${ind.ema25} | RSI14: ${ind.rsi14}
48h High: ${ind.recentHigh} | 48h Low: ${ind.recentLow}
Last 10 Candles (2h): ${last10}
Forex Factory USD Economic News: ${newsSummary}
Context: ${verifyNote}

Rules:
- Analyze the 2h trend structure, momentum, liquidity, and Forex Factory macro expectations.
- Do NOT hold back or output WAIT solely because major news (like CPI/NFP) is approaching; provide clear directional analysis (BUY or SELL) with smart 2h Entry, TP, and SL levels unless price action has zero directional edge.
- Respond ONLY with valid JSON (no markdown, no extra text):
{
  "signal": "BUY" or "SELL" or "WAIT",
  "confidence": 80-98,
  "entry": number,
  "tp": number,
  "sl": number,
  "reason_km": "សរសេរការវិភាគបច្ចេកទេស 2h និងព័ត៌មានសេដ្ឋកិច្ចសង្ខេប ២ ប្រយោគជាភាសាខ្មែរច្បាស់លាស់"
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
    return { id: fallbacks[idx], name: names[idx], ok: false, signal: 'WAIT', confidence: 65, entry: last.close, tp: last.close + 30, sl: last.close - 15, reason_km: 'កំពុងភ្ជាប់ឡើងវិញ...' };
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

  const responsePayload = {
    success: true,
    round,
    timestamp: nowMs,
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
    },
    prevSignal: previousVerdict ? previousVerdict.signal : null
  };

  councilState.lastScanTime = nowMs;
  councilState.nextScanTime = nowMs + SCAN_INTERVAL_MS;
  councilState.previousConsensus = { signal: masterSignal, entry: avgEntry, tp: avgTp, sl: avgSl };
  councilState.latestResponse = responsePayload;

  return responsePayload;
}

app.post('/api/ai-council', async (req, res) => {
  const now = Date.now();
  const { candles: clientCandles = [] } = req.body || {};

  try {
    // ការពារ Limit៖ បើមិនទាន់គ្រប់ ៣០ នាទីទេ បញ្ជូនលទ្ធផល Cache រួមទៅអ្នកមើលទាំងអស់ភ្លាម!
    if (councilState.latestResponse && now < councilState.nextScanTime) {
      const remainingSeconds = Math.max(1, Math.ceil((councilState.nextScanTime - now) / 1000));
      return res.json({ ...councilState.latestResponse, remainingSeconds, fromCache: true });
    }

    // ប្រសិនបើកំពុងស្កេនស្រាប់ រង់ចាំលទ្ធផលតែមួយរួមគ្នា
    if (!activeScanPromise) {
      activeScanPromise = executeCouncilScan(clientCandles).finally(() => {
        activeScanPromise = null;
      });
    }

    const result = await activeScanPromise;
    const remainingSeconds = Math.max(1, Math.ceil((councilState.nextScanTime - Date.now()) / 1000));
    res.json({ ...result, remainingSeconds, fromCache: false });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.listen(PORT, () => console.log(`Server running on port ${PORT} - 2h Chart & 30-Min Shared AI Council`));
