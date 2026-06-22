import logging
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.ext.asyncio import AsyncSession

from .database import Base, engine, get_db
from .models import Tweet
from . import stocktwits as st

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
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    logger.info("Database tables verified")
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
    Posts are stored without FinBERT scores yet; run /score/{ticker} next.
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
