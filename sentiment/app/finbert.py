"""
FinBERT inference module.

The model is loaded once (lazy singleton) and reused across requests.
Inference is CPU-bound so callers should run score_batch() via
asyncio.get_event_loop().run_in_executor(None, ...) to avoid blocking
the FastAPI event loop.
"""

import logging
from transformers import pipeline
import torch

logger = logging.getLogger(__name__)

_MODEL_NAME = "ProsusAI/finbert"
_PIPELINE = None


def warmup() -> None:
    """Load the model into memory. Call once at service startup."""
    _get_pipeline()


def _get_pipeline():
    global _PIPELINE
    if _PIPELINE is None:
        device = 0 if torch.cuda.is_available() else -1
        device_label = "GPU" if device == 0 else "CPU"
        logger.info("Loading FinBERT on %s — this takes ~10s on first run", device_label)
        _PIPELINE = pipeline(
            "text-classification",
            model=_MODEL_NAME,
            device=device,
            truncation=True,
            max_length=512,
        )
        logger.info("FinBERT ready")
    return _PIPELINE


def score_batch(texts: list[str], batch_size: int = 32) -> list[dict]:
    """
    Run FinBERT inference on a list of raw text strings.

    Args:
        texts:      List of post bodies to classify.
        batch_size: How many texts to process per forward pass.

    Returns:
        List of {"sentiment": str, "score": float} dicts in the same order
        as the input. `sentiment` is one of "positive", "negative", "neutral".
        `score` is the model's confidence (0.0 – 1.0).
    """
    pipe = _get_pipeline()
    results = pipe(texts, batch_size=batch_size, truncation=True, max_length=512)
    return [
        {
            "sentiment": r["label"].lower(),  # finbert labels are already lowercase
            "score": round(float(r["score"]), 4),
        }
        for r in results
    ]
