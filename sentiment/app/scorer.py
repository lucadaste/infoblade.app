"""
Account accuracy scorer.

For every high-confidence tweet (finbert_score > 0.75, sentiment positive/negative)
that is at least 3 days old and hasn't been evaluated yet:
  1. Fetch the closing price on the post date and 3 trading days later via yfinance.
  2. Mark the tweet's call_correct based on whether the price moved in the
     predicted direction.
  3. Recompute accuracy_score for each affected account and upsert account_scores.

yfinance calls are synchronous and CPU/IO-bound — always run them via
run_in_executor to avoid blocking the FastAPI event loop.
"""

import asyncio
import logging
from datetime import date, datetime, timedelta, timezone
from collections import defaultdict

import yfinance as yf
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import AccountScore, Tweet

logger = logging.getLogger(__name__)

_CONFIDENCE_THRESHOLD = 0.75
_LOOKBACK_DAYS = 3          # days after post to check price direction
_CRYPTO_SUFFIX_MAP = {      # StockTwits crypto symbols → yfinance symbols
    "BTC": "BTC-USD",
    "ETH": "ETH-USD",
    "SOL": "SOL-USD",
    "DOGE": "DOGE-USD",
    "ADA": "ADA-USD",
    "XRP": "XRP-USD",
}


# ── Public API ─────────────────────────────────────────────────────────────────

async def run(db: AsyncSession) -> dict:
    """
    Evaluate all pending high-confidence tweets and update account_scores.
    Returns a summary: {evaluated, correct, incorrect, skipped_no_price}.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=_LOOKBACK_DAYS)

    stmt = (
        select(Tweet)
        .where(
            and_(
                Tweet.finbert_score > _CONFIDENCE_THRESHOLD,
                Tweet.finbert_sentiment.in_(["positive", "negative"]),
                Tweet.timestamp <= cutoff,
                Tweet.call_correct.is_(None),
            )
        )
        .order_by(Tweet.timestamp)
    )
    result = await db.execute(stmt)
    tweets = result.scalars().all()

    if not tweets:
        logger.info("Accuracy scorer: no pending tweets to evaluate")
        return {"evaluated": 0, "correct": 0, "incorrect": 0, "skipped_no_price": 0}

    # Group by ticker to minimise yfinance round-trips
    by_ticker: dict[str, list[Tweet]] = defaultdict(list)
    for t in tweets:
        by_ticker[t.ticker].append(t)

    summary = {"evaluated": 0, "correct": 0, "incorrect": 0, "skipped_no_price": 0}
    affected_users: set[str] = set()

    loop = asyncio.get_event_loop()

    for ticker, ticker_tweets in by_ticker.items():
        yf_symbol = _to_yf_symbol(ticker)
        dates = [t.timestamp for t in ticker_tweets]
        # Fetch a window that covers post dates through check dates (+buffer)
        start = min(dates).date()
        end = max(dates).date() + timedelta(days=_LOOKBACK_DAYS + 5)

        prices = await loop.run_in_executor(None, _fetch_prices, yf_symbol, start, end)

        for tweet in ticker_tweets:
            post_date = tweet.timestamp.date()
            check_date = tweet.timestamp.date() + timedelta(days=_LOOKBACK_DAYS)

            price_post = _nearest_price(prices, post_date, forward=True)
            price_check = _nearest_price(prices, check_date, forward=True)

            if price_post is None or price_check is None:
                logger.debug("No price data for %s around %s — skipping", ticker, post_date)
                summary["skipped_no_price"] += 1
                continue

            went_up = price_check > price_post
            predicted_up = tweet.finbert_sentiment == "positive"
            tweet.call_correct = went_up == predicted_up

            summary["evaluated"] += 1
            if tweet.call_correct:
                summary["correct"] += 1
            else:
                summary["incorrect"] += 1
            affected_users.add(tweet.username)

    await db.commit()

    # Recompute rolling accuracy for every user with new data
    await _update_account_scores(db, affected_users)

    logger.info(
        "Accuracy scorer finished: %d evaluated, %d correct, %d incorrect, %d skipped",
        summary["evaluated"], summary["correct"], summary["incorrect"], summary["skipped_no_price"],
    )
    return summary


# ── Helpers ────────────────────────────────────────────────────────────────────

def _to_yf_symbol(ticker: str) -> str:
    """Convert a StockTwits ticker to a yfinance-compatible symbol."""
    return _CRYPTO_SUFFIX_MAP.get(ticker.upper(), ticker.upper())


def _fetch_prices(symbol: str, start: date, end: date) -> dict[date, float]:
    """
    Fetch daily closing prices for `symbol` between `start` and `end`.
    Returns a {date: close_price} dict. Runs synchronously — use run_in_executor.
    """
    try:
        ticker = yf.Ticker(symbol)
        hist = ticker.history(start=start, end=end, auto_adjust=True)
        return {idx.date(): float(row["Close"]) for idx, row in hist.iterrows()}
    except Exception as exc:
        logger.error("yfinance error fetching %s: %s", symbol, exc)
        return {}


def _nearest_price(prices: dict[date, float], target: date, forward: bool = True) -> float | None:
    """
    Find the closest available closing price to `target`.
    `forward=True` searches forward (target day or later) to handle weekends/holidays.
    Looks up to 5 calendar days in either direction before giving up.
    """
    for offset in range(6):
        d = target + timedelta(days=offset if forward else -offset)
        if d in prices:
            return prices[d]
    return None


async def _update_account_scores(db: AsyncSession, usernames: set[str]) -> None:
    """Recompute and upsert account_scores for the given set of usernames."""
    for username in usernames:
        stmt = select(Tweet).where(
            and_(
                Tweet.username == username,
                Tweet.finbert_score > _CONFIDENCE_THRESHOLD,
                Tweet.finbert_sentiment.in_(["positive", "negative"]),
                Tweet.call_correct.is_not(None),
            )
        )
        result = await db.execute(stmt)
        evaluated = result.scalars().all()

        total = len(evaluated)
        correct = sum(1 for t in evaluated if t.call_correct)
        accuracy = round(correct / total, 4) if total > 0 else 0.0

        existing = await db.get(AccountScore, username)
        if existing:
            existing.total_calls = total
            existing.correct_calls = correct
            existing.accuracy_score = accuracy
        else:
            db.add(
                AccountScore(
                    username=username,
                    total_calls=total,
                    correct_calls=correct,
                    accuracy_score=accuracy,
                )
            )

    await db.commit()
    logger.info("Updated account_scores for %d accounts", len(usernames))
