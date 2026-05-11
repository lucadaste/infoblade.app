import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const _dir = path.dirname(fileURLToPath(import.meta.url));
const reputationPath = path.resolve(_dir, '../data/source-reputation.json');

async function readReputation() {
  try { return JSON.parse(await fs.readFile(reputationPath, 'utf-8') || '{}'); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}

const SOURCE_QUALITY = {
  // Wire / Financial
  'Reuters': 'High', 'Associated Press': 'High', 'AP': 'High',
  'Bloomberg': 'High', 'Financial Times': 'High', 'Wall Street Journal': 'High',
  'BBC': 'High', 'NPR': 'High', 'CNBC': 'High',
  // Sports
  'ESPN': 'High', 'The Athletic': 'High', 'CBS Sports': 'Medium',
  'Sports Illustrated': 'Medium', 'Yahoo Sports': 'Medium',
  'Bleacher Report': 'Medium', 'Sporting News': 'Medium',
  'NBC Sports': 'Medium', 'Fox Sports': 'Medium',
  // Politics / Law
  'Politico': 'High', 'Axios': 'Medium', 'The Hill': 'Medium',
  'NBC News': 'Medium', 'CBS News': 'Medium', 'ABC News': 'Medium',
  'CNN': 'Medium', 'Washington Post': 'High', 'New York Times': 'High',
  // Entertainment
  'Variety': 'High', 'Hollywood Reporter': 'High', 'Deadline': 'High',
  'Entertainment Weekly': 'Medium', 'People': 'Medium', 'TMZ': 'Medium',
  'E! News': 'Medium', 'Billboard': 'Medium',
  // Low
  'Fox News': 'Low', 'Breitbart': 'Low', 'Daily Mail': 'Low',
  'New York Post': 'Low', 'US Weekly': 'Low', 'In Touch': 'Low',
  'National Enquirer': 'Low', 'OK Magazine': 'Low'
};

function getSourceGrade(source) {
  const norm = source.toLowerCase();
  for (const key of Object.keys(SOURCE_QUALITY)) {
    if (norm.includes(key.toLowerCase())) return SOURCE_QUALITY[key];
  }
  return 'Unknown';
}

function buildSearchQuery(question) {
  return question
    .replace(/^(will|is|are|does|did|can|who|what|when|how|which)\s+/i, '')
    .replace(/\?$/, '')
    .trim()
    .split(/\s+/)
    .slice(0, 8)
    .join(' ');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { question, currentOdds } = req.body;
  if (!question) return res.status(400).json({ error: 'No question provided' });

  const [searchQuery, reputation] = [buildSearchQuery(question), await readReputation()];

  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(searchQuery)}&hl=en-US&gl=US&ceid=US:en`;
    const rssRes = await fetch(rssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000)
    });
    const rssText = await rssRes.text();

    const items = [];
    const matches = [...rssText.matchAll(/<item>([\s\S]*?)<\/item>/g)];
    for (const match of matches.slice(0, 15)) {
      const item = match[1];
      const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/);
      const sourceMatch = item.match(/<source[^>]*>(.*?)<\/source>/);
      if (!titleMatch) continue;
      const title = titleMatch[1].replace(/<[^>]*>/g, '').trim();
      const source = sourceMatch ? sourceMatch[1].replace(/<[^>]*>/g, '').trim() : 'Unknown';
      if (title.length > 10) {
        const grade = getSourceGrade(source);
        const rep = reputation[source];
        const empirical = rep && rep.attempts >= 10
          ? `, ${Math.round(rep.correct / rep.attempts * 100)}% empirical (${rep.attempts} tracked)`
          : '';
        items.push({ title, source, grade, empirical });
      }
    }

    if (items.length < 5) {
      return res.status(200).json({
        lean: 'Uncertain',
        lean_confidence: 'Low',
        reasoning: `Only ${items.length} article${items.length === 1 ? '' : 's'} found — not enough coverage to form a reliable lean. The market price is the best available signal.`,
        key_sources: [],
        signal: 'Inconclusive',
        signal_detail: 'Insufficient news coverage (minimum 5 articles required) to compare against the market odds.',
        articlesFound: items.length,
        searchQuery
      });
    }

    const oddsContext = currentOdds !== undefined
      ? `Current market odds: ${currentOdds}% chance of YES`
      : 'Market odds: not provided';

    const prompt = `You are a research analyst evaluating a prediction market question using news sources.

Market question: "${question}"
${oddsContext}

Recent news (${items.length} articles):
${items.map(i => `- "${i.title}" — ${i.source} [${i.grade}${i.empirical}]`).join('\n')}

Based ONLY on what the news reporting indicates, determine the likely outcome. Weight High-grade sources more heavily. Where empirical accuracy is shown, prioritize that over the static grade. Be direct — if sources clearly point one way, say so.

Consider: official statements, confirmed facts, injury reports, results, direct reporting. If the question may already be resolved, note that.

Respond ONLY with valid JSON, no markdown:
{
  "lean": "Yes" | "No" | "Uncertain",
  "lean_confidence": "High" | "Medium" | "Low",
  "reasoning": "2-3 sentences on what the sources specifically indicate",
  "key_sources": ["source1", "source2"],
  "signal": "Aligns with market" | "Contradicts market" | "Inconclusive",
  "signal_detail": "One sentence comparing the news lean to the ${currentOdds !== undefined ? currentOdds + '% market odds' : 'current market price'}"
}`;

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(30000)
    });

    const data = await apiRes.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const raw = data.content[0].text.replace(/```json|```/g, '').trim();
    const analysis = JSON.parse(raw);

    return res.status(200).json({ ...analysis, articlesFound: items.length, searchQuery });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
