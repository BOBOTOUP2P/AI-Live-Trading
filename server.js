const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// បម្រើឯកសារ static ពីទីតាំងបច្ចុប្បន្នផ្ទាល់ (Root Directory)
app.use(express.static(__dirname));

// 1. Proxy API សម្រាប់ Klines ពី Bybit
app.get('/api/klines', async (req, res) => {
  const { symbol = 'XAUTUSDT', interval = '15', limit = '180' } = req.query;
  try {
    const bybitUrl = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const response = await fetch(bybitUrl);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch from Bybit' });
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

// 3. បង្ហាញ index.html ដែលនៅជួរជាមួយគ្នាផ្ទាល់ (លែង Error ENOENT ទៀតហើយ)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
