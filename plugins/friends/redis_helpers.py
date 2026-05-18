"""Redis helpers for the friends plugin. Load via context["load_sibling"]("redis_helpers")."""

import json
import os
import time

import redis.asyncio as aioredis

_redis_client = None
STATUS_TTL = 300  # 5 minutes; heartbeat every 90s keeps it alive


def get_redis() -> aioredis.Redis:
    global _redis_client
    if _redis_client is None:
        host = os.environ.get("REDIS_HOST", "redis")
        _redis_client = aioredis.Redis(host=host, port=6379, decode_responses=True)
    return _redis_client


async def set_status(
    r: aioredis.Redis, user_id: int, status: str,
    song_filename: str = "", song_title: str = "", song_artist: str = "",
    song_arrangement: str = "", song_play_at: int = 0, song_offset: float = 0.0,
    song_duration: float = 0.0, song_difficulty: int = -1,
) -> None:
    key = f"user:status:{user_id}"
    await r.hset(key, mapping={
        "status": status,
        "song_filename": song_filename,
        "song_title": song_title,
        "song_artist": song_artist,
        "song_arrangement": song_arrangement,
        "song_play_at": str(song_play_at),
        "song_offset": str(song_offset),
        "song_duration": str(song_duration),
        "song_difficulty": str(song_difficulty),
        "updated_at": str(int(time.time())),
    })
    await r.expire(key, STATUS_TTL)


async def get_status(r: aioredis.Redis, user_id: int) -> dict:
    data = await r.hgetall(f"user:status:{user_id}")
    if not data:
        return {"status": "offline", "song_filename": "", "song_title": "", "updated_at": "0"}
    return data


async def push_notification(r: aioredis.Redis, user_id: int, payload: dict) -> None:
    key = f"notifications:{user_id}"
    await r.lpush(key, json.dumps(payload))
    await r.ltrim(key, 0, 49)


async def get_notifications(r: aioredis.Redis, user_id: int) -> list:
    items = await r.lrange(f"notifications:{user_id}", 0, -1)
    result = []
    for item in items:
        try:
            result.append(json.loads(item))
        except Exception:
            pass
    return result
