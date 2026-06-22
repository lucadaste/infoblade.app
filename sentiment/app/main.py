import asyncio
import logging
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession

from .database import Base, engine, get_db
from .models import Tweet
from . import stocktwits as st
from . import finbert
from . import scorer

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

    yield


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

    # Count remaining unscored rows for this ticker
    remaining_stmt = select(Tweet).where(
        and_(Tweet.ticker == ticker, Tweet.finbert_sentiment.is_(None))
    )
    remaining_result = await db.execute(remaining_stmt)
    remaining = len(remaining_result.scalars().all())

    logger.info("Scored %d posts for %s (%d still unscored)", len(tweets), ticker, remaining)
    return {"ticker": ticker, "scored": len(tweets), "remaining_unscored": remaining}


@app.post("/ingest-and-score/{ticker}")
async def ingest_and_score(
    ticker: str,
    pages: int = Query(default=1, ge=1, le=5),
    db: AsyncSession = Depends(get_db),
):
    """Convenience endpoint: fetch new posts then immediately score them."""
    ingest_result = await ingest_ticker(ticker, pages=pages, db=db)
    score_result = await score_ticker(ticker, limit=pages * 30, db=db)
    return {**ingest_result, **score_result}


# ── Step 3: account accuracy scoring ──────────────────────────────────────────

@app.post("/run-accuracy-scoring")
async def run_accuracy_scoring(db: AsyncSession = Depends(get_db)):
    """
    Evaluate high-confidence tweets that are >= 3 days old and haven't been
    checked yet. Fetches Yahoo Finance prices to determine if the call was
    correct, then updates account_scores for every affected user.
    This is safe to call repeatedly — already-evaluated tweets are skipped.
    """
    summary = await scorer.run(db)
    return summary
