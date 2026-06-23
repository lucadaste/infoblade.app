"""
StockTwits API client.

Currently uses the public unauthenticated endpoint (200 req/hr rate limit).
When StockTwits re-opens API registrations, set STOCKTWITS_ACCESS_TOKEN in .env
and the client will automatically switch to authenticated requests (400 req/hr,
plus access to additional endpoints).
"""

import os
import httpx
import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

_BASE = "https://api.stocktwits.com/api/2"
_LIMIT = 30  # max per request on public API


def _auth_params() -> dict:
    """Return access_token param if configured, empty dict otherwise."""
    token = os.getenv("STOCKTWITS_ACCESS_TOKEN")
    return {"access_token": token} if token else {}


async def fetch_ticker_posts(ticker: str, max_id: int | None = None) -> list[dict]:
    """
    Fetch up to 30 recent posts for `ticker` from the StockTwits symbol stream.

    Args:
        ticker:  Stock symbol, e.g. "AAPL".
        max_id:  Paginate backwards — returns posts older than this message ID.

    Returns:
        List of normalised post dicts ready to be stored as Tweet rows.
    """
    url = f"{_BASE}/streams/symbol/{ticker.upper()}.json"
    params: dict = {"limit": _LIMIT, **_auth_params()}
    if max_id is not None:
        params["max"] = max_id

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, params=params)
    except httpx.RequestError as exc:
        logger.error("StockTwits request failed for %s: %s", ticker, exc)
        return []

    if resp.status_code == 200:
        data = resp.json()
        return _parse(data.get("messages", []), ticker.upper())

    if resp.status_code == 429:
        logger.warning("StockTwits rate limit hit for %s — back off before retrying", ticker)
    elif resp.status_code == 401:
        logger.error("StockTwits auth failed — check STOCKTWITS_ACCESS_TOKEN")
    else:
        logger.error("StockTwits API returned %d for %s", resp.status_code, ticker)
    return []


async def fetch_ticker_posts_paginated(ticker: str, pages: int = 3) -> list[dict]:
    """
    Fetch multiple pages of posts for a ticker (up to `pages` * 30 posts).
    Paginates backwards using the `max` cursor.
    """
    all_posts: list[dict] = []
    max_id: int | None = None

    for _ in range(pages):
        batch = await fetch_ticker_posts(ticker, max_id=max_id)
        if not batch:
            break
        all_posts.extend(batch)
        max_id = int(batch[-1]["id"]) - 1  # cursor for next page

    return all_posts


async def fetch_trending_symbols(limit: int = 30) -> list[str]:
    """
    Fetch currently trending symbols from StockTwits.
    Returns up to `limit` ticker strings, e.g. ["AAPL", "GME", "NVDA", ...].
    Covers whatever is being actively discussed — including small caps and
    obscure tickers — without needing a manually maintained list.
    """
    url = f"{_BASE}/trending/symbols.json"
    params = {**_auth_params()}

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, params=params)
    except httpx.RequestError as exc:
        logger.error("StockTwits trending request failed: %s", exc)
        return []

    if resp.status_code == 200:
        data = resp.json()
        symbols = data.get("symbols", [])
        return [s["symbol"] for s in symbols[:limit] if s.get("symbol")]

    logger.error("StockTwits trending API returned %d", resp.status_code)
    return []


def _parse(messages: list, ticker: str) -> list[dict]:
    posts = []
    for msg in messages:
        sentiment = None
        raw = (msg.get("entities") or {}).get("sentiment") or {}
        basic = raw.get("basic")
        if basic:
            sentiment = basic.lower()  # "bullish" | "bearish"

        created = msg.get("created_at", "")
        try:
            ts = datetime.fromisoformat(created.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            ts = datetime.now(timezone.utc)

        posts.append(
            {
                "id": str(msg["id"]),
                "username": msg["user"]["username"],
                "text": msg["body"],
                "ticker": ticker,
                "timestamp": ts,
                "native_sentiment": sentiment,
            }
        )
    return posts
