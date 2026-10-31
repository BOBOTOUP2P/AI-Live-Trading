const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(__dirname));

// មុខងារទាញយក 5,000 ទៀន ដោយរត់ Loop 5 ដង (1000 candles/chunk)
async function fetch5000Klines(symbol, interval) {
  let allKlines = [];
  let endTime = Date.now(); // ចាប់ផ្តើមពីពេលបច្ចុប្បន្ន

  for (let i = 0; i < 5; i++) {
    try {
      const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=1000&end=${endTime}`;
      const res = await fetch(url);
      const json = await res.json();

      if (json.retCode === 0 && json.result.list && json.result.list.length > 0) {
        const chunk = json.result.list;
        allKlines = allKlines.concat(chunk);
        
        // កំណត់ endTime ឱ្យថយក្រោយផុតក្បាលទៀនចុងក្រោយគេនៃ Chunk នេះ
        const oldestCandleTime = parseInt(chunk[chunk.length - 1][0]);
        endTime = oldestCandleTime - 1;

        // ប្រសិនបើទិន្នន័យអស់មុន ៥០០០ ដើម ឈប់ត្រឹមហ្នឹង
        if (chunk.length < 1000) break;
      } else {
        break;
      }
    } catch (e) {
      console.error(`Chunk ${i} error:`, e);
      break;
    }
  }

  return allKlines;
}

// 1. API សម្រាប់ 5,000 Klines
app.get('/api/klines', async (req, res) => {
  const { symbol = 'XAUTUSDT', interval = '15' } = req.query;
  try {
    const rawList = await fetch5000Klines(symbol, interval);
    res.json({ retCode: 0, result: { list: rawList } });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch 5000 candles from Bybit' });
  }
});

// 2. Proxy API សម្រាប់ 24h Ticker Stats
app.get('/api/ticker', async (req, res) => {
  const { symbol = 'XAUTUSDT' } = req.query;
  try {
    const bybitUrl = `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`;
    const response = await fetch(bybitUrl);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch ticker' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} with 5000 Candles Engine`);
});
