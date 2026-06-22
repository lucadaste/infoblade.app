"""
APScheduler configuration.

Three recurring jobs:
  1. Hourly   — ingest fresh StockTwits posts + FinBERT-score them
  2. Daily    — evaluate 3-day-old calls against Yahoo Finance prices
  3. Weekly   — rebuild the whitelist from current account_scores

Each job opens its own DB session so they can run safely in isolation.
The scheduler is started/stopped in main.py's lifespan context manager.
"""

import asyncio
import logging
import os

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from .database import AsyncSessionLocal
from . import scorer, whitelist, stocktwits, finbert

logger = logging.getLogger(__name__)


def _tracked_tickers() -> list[str]:
    """Tickers to auto-ingest. Configurable via TRACKED_TICKERS env var."""
    raw = os.getenv("TRACKED_TICKERS", "AAPL,TSLA,NVDA,MSFT,AMZN,GOOGL,META,AMD")
    return [t.strip().upper() for t in raw.split(",") if t.strip()]


# ── Job implementations ────────────────────────────────────────────────────────

async def _ingest_and_score_job() -> None:
    """Fetch new posts for all tracked tickers and run FinBERT on unscored ones."""
    from sqlalchemy import and_, select
    from .models import Tweet

    tickers = _tracked_tickers()
    logger.info("Scheduled ingest starting for %d tickers", len(tickers))

    async with AsyncSessionLocal() as db:
        for ticker in tickers:
            try:
                posts = await stocktwits.fetch_ticker_posts_paginated(ticker, pages=2)
                new_count = 0
                for post in posts:
                    existing = await db.get(Tweet, post["id"])
                    if existing:
                        continue
                    db.add(
                        Tweet(
                            id=post["id"],
                            username=post["username"],
                            text=post["text"],
                            ticker=post["ticker"],
                            timestamp=post["timestamp"],
                            native_sentiment=post["native_sentiment"],
                        )
                    )
                    new_count += 1
                await db.commit()

                # Score any unscored posts for this ticker
                stmt = (
                    select(Tweet)
                    .where(and_(Tweet.ticker == ticker, Tweet.finbert_sentiment.is_(None)))
                    .limit(200)
                )
                result = await db.execute(stmt)
                unscored = result.scalars().all()

                if unscored:
                    texts = [t.text for t in unscored]
                    loop = asyncio.get_event_loop()
                    scores = await loop.run_in_executor(None, finbert.score_batch, texts)
                    for tweet, score in zip(unscored, scores):
                        tweet.finbert_sentiment = score["sentiment"]
                        tweet.finbert_score = score["score"]
                    await db.commit()

                logger.info("Ingest %s: %d new, %d scored", ticker, new_count, len(unscored))

            except Exception:
                logger.exception("Ingest/score job failed for %s", ticker)


async def _accuracy_scoring_job() -> None:
    """Evaluate 3-day-old high-confidence calls against Yahoo Finance prices."""
    logger.info("Scheduled accuracy scoring starting")
    try:
        async with AsyncSessionLocal() as db:
            summary = await scorer.run(db)
        logger.info("Accuracy scoring done: %s", summary)
    except Exception:
        logger.exception("Accuracy scoring job failed")


async def _whitelist_refresh_job() -> None:
    """Rebuild the whitelist from current account accuracy scores."""
    logger.info("Scheduled whitelist refresh starting")
    try:
        async with AsyncSessionLocal() as db:
            result = await whitelist.refresh(db)
        logger.info("Whitelist refresh done: %s", result)
    except Exception:
        logger.exception("Whitelist refresh job failed")


# ── Scheduler factory ──────────────────────────────────────────────────────────

def create_scheduler() -> AsyncIOScheduler:
    """
    Build and return a configured AsyncIOScheduler.
    Call scheduler.start() in the FastAPI lifespan and scheduler.shutdown() on exit.
    """
    scheduler = AsyncIOScheduler()

    # Every hour at :05 past — slight offset avoids stampeding with other services
    scheduler.add_job(
        _ingest_and_score_job,
        CronTrigger(minute=5),
        id="ingest_and_score",
        replace_existing=True,
        misfire_grace_time=300,
    )

    # Daily at 06:00 UTC — prices for 3-day-old posts are available by then
    scheduler.add_job(
        _accuracy_scoring_job,
        CronTrigger(hour=6, minute=0),
        id="accuracy_scoring",
        replace_existing=True,
        misfire_grace_time=600,
    )

    # Weekly on Sunday at 07:00 UTC — after daily accuracy run finishes
    scheduler.add_job(
        _whitelist_refresh_job,
        CronTrigger(day_of_week="sun", hour=7, minute=0),
        id="whitelist_refresh",
        replace_existing=True,
        misfire_grace_time=3600,
    )

    return scheduler
