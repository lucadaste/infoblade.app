export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { headline } = req.body;

  if (!headline) {
    return res.status(400).json({ error: 'No headline provided' });
  }

  const prompt = `You are a financial analyst AI. Analyze this news headline for market implications:

"${headline}"

Respond ONLY with a valid JSON object, no markdown, no extra text:

{
  "why_it_matters": "2-3 sentence explanation of the economic significance",
  "sectors": {
    "positive": ["sector1", "sector2"],
    "negative": ["sector3"],
    "neutral": []
  },
  "winners": {
    "explanation": "1-2 sentences on why these companies benefit",
    "tickers": ["TICK1", "TICK2", "TICK3"]
  },
  "losers": {
    "explanation": "1-2 sentences on why these companies are hurt",
    "tickers": ["TICK4", "TICK5"]
  },
  "confidence": "High/Medium/Low — brief reason"
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();

    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    const raw = data.content[0].text;
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const analysis = JSON.parse(cleaned);

    return res.status(200).json(analysis);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
