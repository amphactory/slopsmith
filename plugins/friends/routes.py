"""Backend routes for the friends plugin.

Registered by the plugin loader via plugin.json's "routes" field.
All routes under /api/plugins/friends/. Auth is enforced by the
server's _auth_guard middleware; session is on request.state.session.
Redis is accessed via container DNS name (REDIS_HOST env, default "redis").
SQLite is queried read-only for username lookups only.
"""

import sqlite3
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

PLUGIN_ID = "friends"
_VALID_STATUSES = {"online", "busy", "away", "offline"}


class StatusBody(BaseModel):
    status: str
    song_filename: str = ""
    song_title: str = ""
    song_artist: str = ""
    song_arrangement: str = ""
    song_play_at: int = 0       # ms unix timestamp when playback started; 0 = paused
    song_offset: float = 0.0    # audio position in seconds at song_play_at
    song_duration: float = 0.0
    song_difficulty: int = -1   # 0-100; -1 = unknown


class FriendRequestBody(BaseModel):
    username: str


def setup(app: FastAPI, context: dict) -> None:
    rh = context["load_sibling"]("redis_helpers")
    db_path = Path(context["config_dir"]) / "web_library.db"

    def _require_session(request: Request) -> dict:
        session = getattr(request.state, "session", None)
        if not session:
            raise HTTPException(401, "unauthorized")
        return session

    def _user_by_username(username: str) -> dict | None:
        with sqlite3.connect(db_path) as conn:
            row = conn.execute(
                "SELECT id, username, display_name FROM users WHERE username = ? COLLATE NOCASE",
                [username],
            ).fetchone()
        if not row:
            return None
        return {"id": row[0], "username": row[1], "display_name": row[2] or row[1]}

    def _user_by_id(user_id: int) -> dict | None:
        with sqlite3.connect(db_path) as conn:
            row = conn.execute(
                "SELECT id, username, display_name FROM users WHERE id = ?",
                [user_id],
            ).fetchone()
        if not row:
            return None
        return {"id": row[0], "username": row[1], "display_name": row[2] or row[1]}

    def _search_users(query: str, exclude_id: int) -> list:
        with sqlite3.connect(db_path) as conn:
            rows = conn.execute(
                "SELECT id, username, display_name FROM users WHERE username LIKE ? AND id != ? LIMIT 10",
                [f"%{query}%", exclude_id],
            ).fetchall()
        return [{"id": r[0], "username": r[1], "display_name": r[2] or r[1]} for r in rows]

    # ── Status ────────────────────────────────────────────────────────────

    @app.post(f"/api/plugins/{PLUGIN_ID}/status")
    async def update_status(body: StatusBody, request: Request):
        session = _require_session(request)
        if body.status not in _VALID_STATUSES:
            raise HTTPException(400, f"status must be one of {sorted(_VALID_STATUSES)}")
        try:
            r = rh.get_redis()
            await rh.set_status(
            r, session["user_id"], body.status,
            body.song_filename, body.song_title, body.song_artist,
            body.song_arrangement, body.song_play_at, body.song_offset,
            body.song_duration, body.song_difficulty,
        )
        except Exception as exc:
            raise HTTPException(503, "Redis unavailable") from exc
        return JSONResponse({"ok": True})

    # ── Friends list ──────────────────────────────────────────────────────

    @app.get(f"/api/plugins/{PLUGIN_ID}/friends")
    async def list_friends(request: Request):
        session = _require_session(request)
        user_id = session["user_id"]
        try:
            r = rh.get_redis()
            friend_ids = await r.smembers(f"user:friends:{user_id}")
        except Exception as exc:
            raise HTTPException(503, "Redis unavailable") from exc

        friends = []
        for fid in friend_ids:
            user = _user_by_id(int(fid))
            if not user:
                continue
            status_info = await rh.get_status(r, int(fid))
            friends.append({**user, "status_info": status_info})

        friends.sort(key=lambda f: (
            {"busy": 0, "online": 1, "away": 2, "offline": 3}.get(f["status_info"]["status"], 3),
            f["display_name"].lower(),
        ))
        return JSONResponse({"friends": friends})

    # ── Requests ──────────────────────────────────────────────────────────

    @app.get(f"/api/plugins/{PLUGIN_ID}/requests")
    async def list_requests(request: Request):
        session = _require_session(request)
        user_id = session["user_id"]
        try:
            r = rh.get_redis()
            incoming_ids = await r.smembers(f"friend:req:in:{user_id}")
            outgoing_ids = await r.smembers(f"friend:req:out:{user_id}")
        except Exception as exc:
            raise HTTPException(503, "Redis unavailable") from exc

        incoming = [u for uid in incoming_ids if (u := _user_by_id(int(uid)))]
        outgoing = [u for uid in outgoing_ids if (u := _user_by_id(int(uid)))]
        return JSONResponse({"incoming": incoming, "outgoing": outgoing})

    @app.post(f"/api/plugins/{PLUGIN_ID}/friends/request")
    async def send_request(body: FriendRequestBody, request: Request):
        session = _require_session(request)
        user_id = session["user_id"]
        username = session["username"]

        target = _user_by_username(body.username)
        if not target:
            raise HTTPException(404, "User not found")
        if target["id"] == user_id:
            raise HTTPException(400, "Cannot add yourself")

        target_id = target["id"]
        try:
            r = rh.get_redis()

            if await r.sismember(f"user:friends:{user_id}", str(target_id)):
                raise HTTPException(409, "Already friends")
            if await r.sismember(f"friend:req:out:{user_id}", str(target_id)):
                raise HTTPException(409, "Request already sent")

            # Mutual: they already sent a request → auto-accept
            if await r.sismember(f"friend:req:in:{user_id}", str(target_id)):
                await r.sadd(f"user:friends:{user_id}", str(target_id))
                await r.sadd(f"user:friends:{target_id}", str(user_id))
                await r.srem(f"friend:req:in:{user_id}", str(target_id))
                await r.srem(f"friend:req:out:{target_id}", str(user_id))
                await rh.push_notification(r, target_id, {
                    "type": "friend_accepted",
                    "from_id": user_id,
                    "from_username": username,
                    "at": int(time.time()),
                })
                return JSONResponse({"ok": True, "auto_accepted": True})

            await r.sadd(f"friend:req:out:{user_id}", str(target_id))
            await r.sadd(f"friend:req:in:{target_id}", str(user_id))
            await rh.push_notification(r, target_id, {
                "type": "friend_request",
                "from_id": user_id,
                "from_username": username,
                "at": int(time.time()),
            })
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(503, "Redis unavailable") from exc

        return JSONResponse({"ok": True, "auto_accepted": False})

    @app.post(f"/api/plugins/{PLUGIN_ID}/friends/accept/{{target_id}}")
    async def accept_request(target_id: int, request: Request):
        session = _require_session(request)
        user_id = session["user_id"]
        username = session["username"]
        try:
            r = rh.get_redis()
            if not await r.sismember(f"friend:req:in:{user_id}", str(target_id)):
                raise HTTPException(404, "No incoming request from this user")
            await r.sadd(f"user:friends:{user_id}", str(target_id))
            await r.sadd(f"user:friends:{target_id}", str(user_id))
            await r.srem(f"friend:req:in:{user_id}", str(target_id))
            await r.srem(f"friend:req:out:{target_id}", str(user_id))
            await rh.push_notification(r, target_id, {
                "type": "friend_accepted",
                "from_id": user_id,
                "from_username": username,
                "at": int(time.time()),
            })
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(503, "Redis unavailable") from exc
        return JSONResponse({"ok": True})

    @app.post(f"/api/plugins/{PLUGIN_ID}/friends/decline/{{target_id}}")
    async def decline_or_cancel_request(target_id: int, request: Request):
        session = _require_session(request)
        user_id = session["user_id"]
        try:
            r = rh.get_redis()
            # Handles both declining an incoming request and cancelling an outgoing one
            await r.srem(f"friend:req:in:{user_id}", str(target_id))
            await r.srem(f"friend:req:out:{user_id}", str(target_id))
            await r.srem(f"friend:req:in:{target_id}", str(user_id))
            await r.srem(f"friend:req:out:{target_id}", str(user_id))
        except Exception as exc:
            raise HTTPException(503, "Redis unavailable") from exc
        return JSONResponse({"ok": True})

    @app.delete(f"/api/plugins/{PLUGIN_ID}/friends/{{target_id}}")
    async def remove_friend(target_id: int, request: Request):
        session = _require_session(request)
        user_id = session["user_id"]
        try:
            r = rh.get_redis()
            await r.srem(f"user:friends:{user_id}", str(target_id))
            await r.srem(f"user:friends:{target_id}", str(user_id))
        except Exception as exc:
            raise HTTPException(503, "Redis unavailable") from exc
        return JSONResponse({"ok": True})

    # ── Notifications ─────────────────────────────────────────────────────

    @app.get(f"/api/plugins/{PLUGIN_ID}/notifications")
    async def get_notifications(request: Request):
        session = _require_session(request)
        try:
            r = rh.get_redis()
            notifs = await rh.get_notifications(r, session["user_id"])
        except Exception as exc:
            raise HTTPException(503, "Redis unavailable") from exc
        return JSONResponse({"notifications": notifs})

    @app.post(f"/api/plugins/{PLUGIN_ID}/notifications/clear")
    async def clear_notifications(request: Request):
        session = _require_session(request)
        try:
            r = rh.get_redis()
            await r.delete(f"notifications:{session['user_id']}")
        except Exception as exc:
            raise HTTPException(503, "Redis unavailable") from exc
        return JSONResponse({"ok": True})

    # ── User search ───────────────────────────────────────────────────────

    @app.get(f"/api/plugins/{PLUGIN_ID}/search")
    async def search_users(q: str, request: Request):
        session = _require_session(request)
        if not q or len(q) < 2:
            return JSONResponse({"users": []})
        users = _search_users(q, session["user_id"])
        return JSONResponse({"users": users})
