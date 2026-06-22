"""
Whitelist logic.

Promotes accounts to whitelisted_accounts when they meet the accuracy threshold,
and demotes them when they fall below it. Designed to be called both from the
weekly APScheduler job and the manual /refresh-whitelist endpoint.
"""

import logging
import os

from sqlalchemy import and_, delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import AccountScore, WhitelistedAccount

logger = logging.getLogger(__name__)


def _thresholds() -> tuple[float, int]:
    """Read threshold config from env, with safe defaults."""
    threshold = float(os.getenv("WHITELIST_ACCURACY_THRESHOLD", "0.60"))
    min_calls = int(os.getenv("WHITELIST_MIN_CALLS", "20"))
    return threshold, min_calls


async def refresh(db: AsyncSession) -> dict:
    """
    Rebuild the whitelisted_accounts table from current account_scores.

    - Accounts that newly meet the threshold are inserted.
    - Accounts already on the whitelist have their cached scores updated.
    - Accounts that no longer meet the threshold are removed.

    Returns {"added": n, "updated": n, "removed": n, "total": n}.
    """
    threshold, min_calls = _thresholds()

    # Qualifying accounts from account_scores
    q_stmt = select(AccountScore).where(
        and_(
            AccountScore.accuracy_score >= threshold,
            AccountScore.total_calls >= min_calls,
        )
    )
    q_result = await db.execute(q_stmt)
    qualifying: dict[str, AccountScore] = {r.username: r for r in q_result.scalars().all()}

    # Current whitelist
    w_result = await db.execute(select(WhitelistedAccount))
    current: dict[str, WhitelistedAccount] = {r.username: r for r in w_result.scalars().all()}

    added = updated = removed = 0

    # Upsert qualifiers
    for username, score in qualifying.items():
        if username in current:
            current[username].accuracy_score = score.accuracy_score
            current[username].total_calls = score.total_calls
            updated += 1
        else:
            db.add(
                WhitelistedAccount(
                    username=username,
                    accuracy_score=score.accuracy_score,
                    total_calls=score.total_calls,
                )
            )
            added += 1
            logger.info("Whitelisted new account: %s (%.0f%%, %d calls)",
                        username, score.accuracy_score * 100, score.total_calls)

    # Remove accounts that no longer qualify
    for username in current:
        if username not in qualifying:
            await db.execute(
                delete(WhitelistedAccount).where(WhitelistedAccount.username == username)
            )
            removed += 1
            logger.info("Removed from whitelist: %s", username)

    await db.commit()

    total = len(qualifying)
    logger.info(
        "Whitelist refresh complete — added=%d updated=%d removed=%d total=%d "
        "(threshold=%.0f%% min_calls=%d)",
        added, updated, removed, total, threshold * 100, min_calls,
    )
    return {"added": added, "updated": updated, "removed": removed, "total": total}
