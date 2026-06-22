"""
Sentiment aggregation.

Takes a list of Tweet ORM objects and a {username: WhitelistedAccount} map,
and returns a single aggregated signal weighted by account accuracy and
FinBERT confidence score.

Weighting scheme
----------------
Each post contributes a signed weight:

    direction  = +1.0 (positive) | -1.0 (negative) | 0.0 (neutral)
    weight     = finbert_score * account.accuracy_score
    contribution = direction * weight

Aggregate score = sum(contributions) / sum(weights)  → range [-1.0, +1.0]

Signal thresholds (tunable via SIGNAL_BULLISH_THRESHOLD / SIGNAL_BEARISH_THRESHOLD):
    score >  0.15  → "bullish"
    score < -0.15  → "bearish"
    otherwise      → "neutral"

Confidence = abs(aggregate_score), clipped to [0.0, 1.0].
"""

import os
from collections import defaultdict
from dataclasses import dataclass, field

_BULLISH_THRESHOLD = float(os.getenv("SIGNAL_BULLISH_THRESHOLD", "0.15"))
_BEARISH_THRESHOLD = float(os.getenv("SIGNAL_BEARISH_THRESHOLD", "-0.15"))

_DIRECTION = {"positive": 1.0, "negative": -1.0, "neutral": 0.0}


@dataclass
class AccountSummary:
    username: str
    accuracy_score: float
    post_count: int
    sentiment: str          # "bullish" | "bearish" | "neutral"
    weighted_score: float   # account-level aggregate score for sorting


@dataclass
class SentimentResult:
    ticker: str
    signal: str             # "bullish" | "bearish" | "neutral"
    confidence: float       # 0.0 – 1.0
    post_count: int
    top_accounts: list[AccountSummary]
    window_hours: int = 48
    message: str = ""       # non-empty only when data is insufficient


def aggregate(ticker: str, posts: list, whitelisted: dict) -> SentimentResult:
    """
    Compute the aggregated sentiment signal.

    Args:
        ticker:     Ticker symbol (used only for the result object).
        posts:      List of Tweet ORM objects from whitelisted accounts.
        whitelisted: {username: WhitelistedAccount} for weight lookup.

    Returns:
        SentimentResult with all fields populated.
    """
    if not posts:
        return _empty(ticker, "No recent posts from trusted accounts")

    # Per-account accumulators
    acc: dict[str, dict] = defaultdict(lambda: {
        "weight": 0.0,
        "weighted_dir": 0.0,
        "post_count": 0,
    })

    total_weight = 0.0
    total_weighted_dir = 0.0

    for post in posts:
        account = whitelisted.get(post.username)
        if account is None:
            continue

        direction = _DIRECTION.get(post.finbert_sentiment or "neutral", 0.0)
        # Fall back to 0.5 if finbert_score is missing (shouldn't happen in practice)
        finbert_confidence = post.finbert_score if post.finbert_score is not None else 0.5
        weight = finbert_confidence * account.accuracy_score

        total_weight += weight
        total_weighted_dir += direction * weight

        acc[post.username]["weight"] += weight
        acc[post.username]["weighted_dir"] += direction * weight
        acc[post.username]["post_count"] += 1

    if total_weight == 0.0:
        return _empty(ticker, "All recent posts are neutral with zero weight")

    aggregate_score = total_weighted_dir / total_weight
    confidence = min(abs(aggregate_score), 1.0)

    if aggregate_score > _BULLISH_THRESHOLD:
        signal = "bullish"
    elif aggregate_score < _BEARISH_THRESHOLD:
        signal = "bearish"
    else:
        signal = "neutral"

    # Build top_accounts sorted by absolute contribution (most influential first)
    top: list[AccountSummary] = []
    for username, data in sorted(acc.items(), key=lambda x: -abs(x[1]["weighted_dir"]))[:5]:
        w = data["weight"]
        acct_score = data["weighted_dir"] / w if w > 0 else 0.0
        if acct_score > _BULLISH_THRESHOLD:
            acct_signal = "bullish"
        elif acct_score < _BEARISH_THRESHOLD:
            acct_signal = "bearish"
        else:
            acct_signal = "neutral"

        top.append(
            AccountSummary(
                username=username,
                accuracy_score=round(whitelisted[username].accuracy_score, 4),
                post_count=data["post_count"],
                sentiment=acct_signal,
                weighted_score=round(acct_score, 4),
            )
        )

    return SentimentResult(
        ticker=ticker,
        signal=signal,
        confidence=round(confidence, 4),
        post_count=len(posts),
        top_accounts=top,
    )


def _empty(ticker: str, message: str = "") -> SentimentResult:
    return SentimentResult(
        ticker=ticker,
        signal="neutral",
        confidence=0.0,
        post_count=0,
        top_accounts=[],
        message=message,
    )
