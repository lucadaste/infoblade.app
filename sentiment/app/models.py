from sqlalchemy import Boolean, Column, String, Integer, Float, DateTime, Text, Index
from sqlalchemy.sql import func
from .database import Base


class Tweet(Base):
    __tablename__ = "sentiment_tweets"

    id = Column(String, primary_key=True)
    username = Column(String, nullable=False, index=True)
    text = Column(Text, nullable=False)
    ticker = Column(String, nullable=False, index=True)
    timestamp = Column(DateTime(timezone=True), nullable=False, index=True)
    native_sentiment = Column(String, nullable=True)   # "bullish" | "bearish" | null
    finbert_sentiment = Column(String, nullable=True)  # "positive" | "negative" | "neutral"
    finbert_score = Column(Float, nullable=True)       # 0.0 – 1.0
    call_correct = Column(Boolean, nullable=True)      # null=not yet evaluated; True/False=outcome

    __table_args__ = (
        Index("ix_sentiment_tweets_ticker_ts", "ticker", "timestamp"),
    )


class AccountScore(Base):
    __tablename__ = "account_scores"

    username = Column(String, primary_key=True)
    total_calls = Column(Integer, default=0, nullable=False)
    correct_calls = Column(Integer, default=0, nullable=False)
    accuracy_score = Column(Float, default=0.0, nullable=False)
    last_updated = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class WhitelistedAccount(Base):
    __tablename__ = "whitelisted_accounts"

    username = Column(String, primary_key=True)
    accuracy_score = Column(Float, nullable=False)
    total_calls = Column(Integer, nullable=False)
    added_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
