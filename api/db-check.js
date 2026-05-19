import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    return res.status(200).json({
      ok: false,
      error: 'SUPABASE_URL or SUPABASE_SERVICE_KEY env vars are not set',
      envCheck: { hasUrl: !!url, hasKey: !!key },
    });
  }

  const supabase = createClient(url, key);

  // Count all rows in predictions table
  const { count, error: countErr } = await supabase
    .from('predictions')
    .select('id', { count: 'exact', head: true });

  if (countErr) {
    return res.status(200).json({
      ok: false,
      error: `Read failed: ${countErr.message}`,
      code: countErr.code,
    });
  }

  // Test insert with a throwaway row
  const testId = `_dbcheck_${Date.now()}`;
  const { error: insertErr } = await supabase.from('predictions').insert({
    id:       testId,
    topic:    '__db_check__',
    analysis: { test: true },
  });

  if (insertErr) {
    return res.status(200).json({
      ok: false,
      totalRows: count,
      error: `Insert failed: ${insertErr.message}`,
      code: insertErr.code,
      hint: insertErr.hint || null,
    });
  }

  // Clean up test row
  await supabase.from('predictions').delete().eq('id', testId);

  return res.status(200).json({ ok: true, totalRows: count });
}
