// Everything stored in Supabase that belongs to one Clerk user. Used when an
// account is deleted — both from the account page (api/account.js) and from
// Clerk's user.deleted webhook (api/clerk-webhook.js), which also covers
// deletions made in the Clerk dashboard.

const USER_TABLES = ['watchlists', 'crypto_watchlists', 'market_watchlists'];

export async function deleteUserData(sb, userId) {
  if (!userId || typeof userId !== 'string') throw new Error('userId required');

  const errors = [];
  for (const table of USER_TABLES) {
    const { error } = await sb.from(table).delete().eq('user_id', userId);
    if (error) errors.push(`${table}: ${error.message}`);
  }

  // Predictions feed the public track record, so they're kept but detached
  // from the user rather than deleted.
  const { error: predError } = await sb.from('predictions').update({ user_id: null }).eq('user_id', userId);
  if (predError) errors.push(`predictions: ${predError.message}`);

  if (errors.length) throw new Error(errors.join('; '));
}
