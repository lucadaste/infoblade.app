import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession

from .database import AsyncSessionLocal, Base, engine, get_db
from .models import Tweet
from . import stocktwits as st
from . import finbert
from . import scorer
from . import whitelist
from . import aggregator
from .scheduler import create_scheduler

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
logger = logging.getLogger(__name__)

_ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("ALLOWED_ORIGINS", "https://infoblade.app").split(",")
    if o.strip()
]


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure tables exist
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    logger.info("Database tables verified")

    # Warm FinBERT in a thread so startup doesn't block the event loop
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, finbert.warmup)

    # Start background scheduler
    _scheduler = create_scheduler()
    _scheduler.start()
    logger.info("Scheduler started — jobs: %s", [j.id for j in _scheduler.get_jobs()])

    yield

    _scheduler.shutdown(wait=False)
    logger.info("Scheduler stopped")


app = FastAPI(title="Infoblade Sentiment Service", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


# ── Step 1: ingest ─────────────────────────────────────────────────────────────

@app.post("/ingest/{ticker}")
async def ingest_ticker(
    ticker: str,
    pages: int = Query(default=1, ge=1, le=5),
    db: AsyncSession = Depends(get_db),
):
    """
    Fetch recent StockTwits posts for `ticker` and store any new ones.
    `pages` controls how many pages of 30 posts to fetch (max 5 = 150 posts).
    Posts are stored without FinBERT scores yet; call /score/{ticker} next.
    """
    ticker = ticker.upper()
    if len(ticker) > 10 or not ticker.isalpha():
        raise HTTPException(status_code=400, detail="Invalid ticker symbol")

    posts = await st.fetch_ticker_posts_paginated(ticker, pages=pages)
    if not posts:
        return {"ticker": ticker, "fetched": 0, "new": 0}

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
    logger.info("Ingested %d new posts for %s (%d fetched)", new_count, ticker, len(posts))
    return {"ticker": ticker, "fetched": len(posts), "new": new_count}


# ── Step 2: FinBERT scoring ────────────────────────────────────────────────────

@app.post("/score/{ticker}")
async def score_ticker(
    ticker: str,
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """
    Run FinBERT on unscored posts for `ticker` and write results back.
    `limit` caps how many posts are scored per call (process in batches for large backlogs).
    """
    ticker = ticker.upper()
    if len(ticker) > 10 or not ticker.isalpha():
        raise HTTPException(status_code=400, detail="Invalid ticker symbol")

    stmt = (
        select(Tweet)
        .where(and_(Tweet.ticker == ticker, Tweet.finbert_sentiment.is_(None)))
        .order_by(Tweet.timestamp.desc())
        .limit(limit)
    )
    result = await db.execute(stmt)
    tweets = result.scalars().all()

    if not tweets:
        return {"ticker": ticker, "scored": 0, "remaining_unscored": 0}

    texts = [t.text for t in tweets]

    # Run FinBERT in a thread pool — CPU-bound, must not block the event loop
    loop = asyncio.get_event_loop()
    scores = await loop.run_in_executor(None, finbert.score_batch, texts)

    for tweet, score in zip(tweets, scores):
        tweet.finbert_sentiment = score["sentiment"]
        tweet.finbert_score = score["score"]

    await db.commit()

    remaining_stmt = select(Tweet).where(
        and_(Tweet.ticker == ticker, Tweet.finbert_sentiment.is_(None))
    )
    remaining_result = await db.execute(remaining_stmt)
    remaining = len(remaining_result.scalars().all())

    logger.info("Scored %d posts for %s (%d still unscored)", len(tweets), ticker, remaining)
    return {"ticker": ticker, "scored": len(tweets), "remaining_unscored": remaining}


async def _background_score(ticker: str, limit: int) -> None:
    """Run FinBERT scoring in the background after ingest returns."""
    try:
        async with AsyncSessionLocal() as db:
            await score_ticker(ticker, limit=limit, db=db)
    except Exception:
        logger.exception("Background scoring failed for %s", ticker)


@app.post("/ingest-and-score/{ticker}")
async def ingest_and_score(
    ticker: str,
    background_tasks: BackgroundTasks,
    pages: int = Query(default=1, ge=1, le=5),
    db: AsyncSession = Depends(get_db),
):
    """
    Fetch new posts then kick off FinBERT scoring as a background task.
    Returns immediately after ingest; scoring runs in the background.
    """
    ingest_result = await ingest_ticker(ticker, pages=pages, db=db)
    background_tasks.add_task(_background_score, ticker, pages * 30)
    return {**ingest_result, "scoring": "started in background"}


# ── Step 3: account accuracy scoring ──────────────────────────────────────────

@app.post("/run-accuracy-scoring")
async def run_accuracy_scoring(db: AsyncSession = Depends(get_db)):
    """
    Evaluate high-confidence tweets that are >= 3 days old and haven't been
    checked yet. Fetches Yahoo Finance prices to determine if the call was
    correct, then updates account_scores for every affected user.
    Safe to call repeatedly — already-evaluated tweets are skipped.
    """
    summary = await scorer.run(db)
    return summary


# ── Step 4: whitelist ─────────────────────────────────────────────────────────

@app.post("/refresh-whitelist")
async def refresh_whitelist(db: AsyncSession = Depends(get_db)):
    """
    Manually trigger a whitelist refresh (the scheduler also runs this weekly).
    Promotes accounts with accuracy >= threshold and calls >= min_calls;
    demotes accounts that have fallen below the threshold.
    """
    result = await whitelist.refresh(db)
    return result


@app.get("/whitelist")
async def get_whitelist(db: AsyncSession = Depends(get_db)):
    """Return the current whitelisted accounts sorted by accuracy descending."""
    from .models import WhitelistedAccount
    from sqlalchemy import desc

    stmt = (
        select(WhitelistedAccount)
        .order_by(desc(WhitelistedAccount.accuracy_score))
    )
    result = await db.execute(stmt)
    accounts = result.scalars().all()
    return {
        "count": len(accounts),
        "accounts": [
            {
                "username": a.username,
                "accuracy_score": a.accuracy_score,
                "total_calls": a.total_calls,
                "added_at": a.added_at.isoformat(),
            }
            for a in accounts
        ],
    }


# ── Step 5: sentiment signal ───────────────────────────────────────────────────

@app.get("/api/sentiment")
async def get_sentiment(
    ticker: str = Query(..., min_length=1, max_length=10),
    window_hours: int = Query(default=48, ge=1, le=168),
    db: AsyncSession = Depends(get_db),
):
    """
    Aggregated sentiment signal for a ticker from whitelisted accounts only.

    Query params:
      ticker       — stock symbol, e.g. AAPL
      window_hours — how far back to look (default 48h, max 7 days)

    Response:
      {
        ticker, signal, confidence, post_count, window_hours,
        top_accounts: [{username, accuracy_score, post_count, sentiment}],
        message  // present when data is insufficient
      }
    """
    ticker = ticker.upper()
    if not ticker.replace(".", "").replace("-", "").isalpha():
        raise HTTPException(status_code=400, detail="Invalid ticker symbol")

    cutoff = datetime.now(timezone.utc) - timedelta(hours=window_hours)

    # Load whitelisted accounts
    from .models import WhitelistedAccount
    wl_result = await db.execute(select(WhitelistedAccount))
    whitelisted = {a.username: a for a in wl_result.scalars().all()}

    if not whitelisted:
        result = aggregator._empty(ticker, "Whitelist is empty — accuracy data is still building up")
    else:
        # Fetch recent scored posts from whitelisted accounts only
        stmt = (
            select(Tweet)
            .where(
                and_(
                    Tweet.ticker == ticker,
                    Tweet.timestamp >= cutoff,
                    Tweet.username.in_(list(whitelisted.keys())),
                    Tweet.finbert_sentiment.is_not(None),
                )
            )
            .order_by(Tweet.timestamp.desc())
        )
        posts_result = await db.execute(stmt)
        posts = posts_result.scalars().all()

        result = aggregator.aggregate(ticker, posts, whitelisted)

    return {
        "ticker": result.ticker,
        "signal": result.signal,
        "confidence": result.confidence,
        "post_count": result.post_count,
        "window_hours": window_hours,
        "top_accounts": [
            {
                "username": a.username,
                "accuracy_score": a.accuracy_score,
                "post_count": a.post_count,
                "sentiment": a.sentiment,
            }
            for a in result.top_accounts
        ],
        **({"message": result.message} if result.message else {}),
    }
