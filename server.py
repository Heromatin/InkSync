#!/usr/bin/env python3
"""Inksync server: serves the web app, accepts PDF uploads, and relays
camera/annotation state between devices over WebSockets."""

import asyncio
import hashlib
import json
import math
import os
import re
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path

from aiohttp import web, WSCloseCode, WSMsgType

ROOT = Path(__file__).parent
WEB = ROOT / "web"
DOCS = ROOT / "docs"
DOCS.mkdir(exist_ok=True)

PORT = 8765


def doc_id_for(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:12]


DOC_ID_RE = re.compile(r"[0-9a-f]{12}")


def known_doc(doc_id: str) -> bool:
    """True only for a well-formed id (12 hex chars) whose PDF exists.
    Everything that builds a path from a URL segment goes through this, so a
    crafted id (e.g. '..%2Fx') can never reach the filesystem."""
    return bool(DOC_ID_RE.fullmatch(doc_id)) and (DOCS / f"{doc_id}.pdf").is_file()


class DocRoom:
    def __init__(self, doc_id: str):
        self.doc_id = doc_id
        self.strokes: list[dict] = []
        self.camera: dict | None = None
        self.clients: set[web.WebSocketResponse] = set()
        self._save_task: asyncio.Task | None = None
        self._load()

    @property
    def sidecar(self) -> Path:
        return DOCS / f"{self.doc_id}.annotations.json"

    def _load(self):
        if self.sidecar.exists():
            try:
                data = json.loads(self.sidecar.read_text())
                self.strokes = data.get("strokes", [])
                self.camera = data.get("camera")
            except (json.JSONDecodeError, OSError, AttributeError):
                # Never let the next save overwrite an unreadable file: keep it
                # aside so the annotations can still be recovered by hand.
                backup = self.sidecar.with_name(
                    f"{self.sidecar.name}.corrupt-{int(time.time())}")
                try:
                    os.replace(self.sidecar, backup)
                    print(f"[warn] unreadable sidecar for {self.doc_id}; "
                          f"kept as {backup.name}")
                except OSError:
                    print(f"[warn] failed to load sidecar for {self.doc_id}")
                self.strokes = []
                self.camera = None

    def schedule_save(self):
        if self._save_task:
            self._save_task.cancel()
        self._save_task = asyncio.get_event_loop().create_task(self._debounced_save())

    def _write(self):
        payload = json.dumps(
            {"strokes": self.strokes, "camera": self.camera},
            separators=(",", ":"),
        )
        # atomic write: a crash mid-write can no longer leave a truncated
        # sidecar behind (os.replace is atomic on the same filesystem)
        tmp = self.sidecar.with_name(self.sidecar.name + ".tmp")
        tmp.write_text(payload)
        os.replace(tmp, self.sidecar)

    async def _debounced_save(self):
        try:
            await asyncio.sleep(0.5)
            self._write()
        except asyncio.CancelledError:
            pass
        except OSError as exc:
            print(f"[warn] could not save annotations for {self.doc_id}: {exc}")

    def flush(self):
        """Write a still-pending debounced save right now (used on shutdown)."""
        if self._save_task and not self._save_task.done():
            self._save_task.cancel()
            try:
                self._write()
            except OSError as exc:
                print(f"[warn] could not save annotations for {self.doc_id}: {exc}")

    def broadcast(self, message: dict, exclude: web.WebSocketResponse | None = None):
        dead = []
        payload = json.dumps(message)
        for ws in self.clients:
            if ws is exclude:
                continue
            try:
                asyncio.create_task(ws.send_str(payload))
            except ConnectionError:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)


ROOMS: dict[str, DocRoom] = {}


def get_room(doc_id: str) -> DocRoom:
    if doc_id not in ROOMS:
        ROOMS[doc_id] = DocRoom(doc_id)
    return ROOMS[doc_id]


# ---------------------------------------------------------------- HTTP routes

async def index(_request):
    return web.FileResponse(WEB / "index.html")


async def service_worker(_request):
    # must be served from the root so its scope covers /doc/*
    return web.FileResponse(WEB / "sw.js", headers={"Cache-Control": "no-cache"})


async def manifest(_request):
    return web.FileResponse(WEB / "manifest.json")


async def page(request):
    name = request.match_info["name"]
    if name not in ("reader.html", "writer.html"):
        raise web.HTTPNotFound
    return web.FileResponse(WEB / name)


async def reader_page(request):
    if not known_doc(request.match_info["doc_id"]):
        raise web.HTTPNotFound
    return web.FileResponse(WEB / "reader.html")


async def writer_page(request):
    if not known_doc(request.match_info["doc_id"]):
        raise web.HTTPNotFound
    return web.FileResponse(WEB / "writer.html")


async def upload(request):
    reader = await request.multipart()
    field = None
    async for part in reader:
        if part.name == "file":
            field = part
            break
    if field is None:
        raise web.HTTPBadRequest(text="no file field")

    data = bytearray()
    while True:
        chunk = await field.read_chunk(1 << 16)
        if not chunk:
            break
        data.extend(chunk)
    data = bytes(data)

    if data[:5] != b"%PDF-":
        raise web.HTTPBadRequest(text="not a PDF file")

    doc_id = doc_id_for(data)
    pdf_path = DOCS / f"{doc_id}.pdf"
    if not pdf_path.exists():
        pdf_path.write_bytes(data)
    meta_path = DOCS / f"{doc_id}.meta.json"
    meta_path.write_text(json.dumps({"name": field.filename or "document.pdf"}))

    room = get_room(doc_id)
    return web.json_response({
        "id": doc_id,
        "name": field.filename or "document.pdf",
        "url": f"/doc/{doc_id}.pdf",
        "readerUrl": f"/reader/{doc_id}",
        "writerUrl": f"/writer/{doc_id}",
        "existingAnnotations": len(room.strokes),
    })


async def serve_pdf(request):
    doc_id = Path(request.match_info["name"]).stem
    if not known_doc(doc_id):
        raise web.HTTPNotFound
    pdf_path = DOCS / f"{doc_id}.pdf"
    return web.FileResponse(
        pdf_path,
        headers={"Cache-Control": "max-age=31536000, immutable"},
    )


async def doc_meta(request):
    doc_id = request.match_info["doc_id"]
    if not known_doc(doc_id):
        raise web.HTTPNotFound
    meta_path = DOCS / f"{doc_id}.meta.json"
    name = "document.pdf"
    if meta_path.exists():
        try:
            name = json.loads(meta_path.read_text()).get("name", name)
        except (json.JSONDecodeError, OSError):
            pass
    room = get_room(doc_id)
    return web.json_response({"id": doc_id, "name": name, "strokes": len(room.strokes)})


# ---------------------------------------------------------------- WebSocket

def _num(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


async def _handle_message(room: DocRoom, ws: web.WebSocketResponse, session: dict, data: dict):
    t = data.get("t")

    if t == "join":
        cid, role = data.get("clientId"), data.get("role")
        session["client_id"] = cid if isinstance(cid, str) and len(cid) <= 64 else None
        session["role"] = role if isinstance(role, str) and len(role) <= 32 else None
        await ws.send_json({
            "t": "joined",
            "you": session["client_id"],
            "strokes": room.strokes,
            "camera": room.camera,
        })
    elif t == "stroke":
        stroke = data.get("stroke")
        # a malformed stroke would be persisted and then break rendering on
        # every device that opens the document, so reject it here
        if not (isinstance(stroke, dict) and isinstance(stroke.get("points"), list)
                and isinstance(stroke.get("page"), int)):
            return
        author, tmp = session["client_id"], stroke.get("tmpId")
        if author and isinstance(tmp, str):
            for old in reversed(room.strokes):
                if old.get("author") == author and old.get("tmpId") == tmp:
                    # the same stroke arriving twice (re-sent after a reconnect):
                    # do not store it again, just confirm the existing one
                    await ws.send_json({"t": "stroke", "stroke": old})
                    return
        # ids are always assigned here: a client-supplied (or content-derived) id
        # could collide, and one erase would then remove several strokes
        stroke["id"] = uuid.uuid4().hex[:12]
        stroke["author"] = author
        room.strokes.append(stroke)
        room.schedule_save()
        room.broadcast({"t": "stroke", "stroke": stroke})
    elif t == "erase":
        raw = data.get("ids")
        if not isinstance(raw, list):
            return
        ids = {i for i in raw if isinstance(i, str)}
        room.strokes = [s for s in room.strokes if s.get("id") not in ids]
        room.schedule_save()
        room.broadcast({"t": "erase", "ids": list(ids)}, exclude=ws)
    elif t == "undo":
        for i in range(len(room.strokes) - 1, -1, -1):
            if room.strokes[i].get("author") == session["client_id"]:
                removed = room.strokes.pop(i)
                room.schedule_save()
                room.broadcast({"t": "erase", "ids": [removed.get("id")]})
                break
    elif t == "camera" and session["role"] != "observer":
        p, fx, fy = data.get("p"), data.get("fx"), data.get("fy")
        if not (_num(p) and (fx is None or _num(fx)) and (fy is None or _num(fy))):
            return
        room.camera = {"p": p, "fy": fy, "fx": fx}
        room.schedule_save()
        room.broadcast({"t": "camera", **room.camera}, exclude=ws)


async def sync_ws(request):
    doc_id = request.match_info["doc_id"]
    if not known_doc(doc_id):
        raise web.HTTPNotFound
    room = get_room(doc_id)
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)

    session = {"client_id": None, "role": None}
    room.clients.add(ws)
    try:
        await ws.send_json({
            "t": "init",
            "you": None,
            "strokes": room.strokes,
            "camera": room.camera,
        })
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                data = json.loads(msg.data)
            except json.JSONDecodeError:
                continue
            if not isinstance(data, dict):
                continue
            try:
                await _handle_message(room, ws, session, data)
            except Exception as exc:  # one bad message must never kill the connection
                print(f"[warn] ignored bad {data.get('t')!r} message: {exc!r}")
    finally:
        room.clients.discard(ws)
    return ws


async def _on_shutdown(_app):
    """Ctrl+C: save what is pending and close every WebSocket, otherwise aiohttp
    waits (up to its shutdown timeout) for browsers that never hang up."""
    for room in list(ROOMS.values()):
        room.flush()
        for ws in list(room.clients):
            await ws.close(code=WSCloseCode.GOING_AWAY, message=b"server shutting down")


# ---------------------------------------------------------------- startup

# virtual interfaces whose addresses are never useful for a phone on the LAN
_SKIP_IFACE_PREFIXES = (
    "lo", "docker", "br-", "veth", "virbr", "tun", "tap", "singbox", "wg", "zt",
)

def lan_ips():
    """IPs on physical/managed interfaces (wlan, ethernet), best first."""
    named = []  # (iface, ip)
    try:
        out = subprocess.run(
            ["ip", "-brief", "-4", "addr"],
            capture_output=True, text=True, timeout=5,
        ).stdout
        for line in out.splitlines():
            parts = line.split()
            if len(parts) < 3 or parts[0].startswith(_SKIP_IFACE_PREFIXES):
                continue
            for token in parts[2:]:
                ip = token.split("/")[0]
                if not ip.startswith("127."):
                    named.append((parts[0], ip))
    except Exception:
        pass
    if not named:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("8.8.8.8", 80))
                named.append(("wlan", s.getsockname()[0]))
        except OSError:
            pass
    # wireless/ethernet interfaces first, everything else after
    named.sort(key=lambda t: not (t[0].startswith(("wl", "en", "eth", "enp"))))
    ips = [ip for _, ip in named]
    return ips or ["127.0.0.1"]


def main():
    app = web.Application(client_max_size=2 * 1024**3)
    app.on_shutdown.append(_on_shutdown)
    app.router.add_get("/", index)
    app.router.add_get("/sw.js", service_worker)
    app.router.add_get("/manifest.json", manifest)
    app.router.add_static("/img/", WEB / "img")
    app.router.add_get("/reader/{doc_id}", reader_page)
    app.router.add_get("/writer/{doc_id}", writer_page)
    app.router.add_post("/upload", upload)
    app.router.add_get("/doc/{name}", serve_pdf)
    app.router.add_get("/api/meta/{doc_id}", doc_meta)
    app.router.add_get("/sync/{doc_id}", sync_ws)
    app.router.add_static("/static/", WEB)

    ips = lan_ips()
    banner = []
    banner.append("  Inksync is listening on ALL interfaces (0.0.0.0) — the URLs below")
    banner.append("  are the ones to use. If the phone cannot connect, check:")
    banner.append("   1. phone + PC on the same Wi-Fi, and use the CURRENT IP (it is DHCP)")
    banner.append("   2. turn OFF any VPN/proxy app on the phone (v2rayNG etc.) or enable")
    banner.append("      its 'bypass LAN' option — proxies send private IPs to the remote")
    banner.append("      server, which cannot reach this machine")
    banner.append("   3. router 'AP/client isolation' must be disabled")
    banner.append("")
    for ip in ips:
        banner.append(f"  http://{ip}:{PORT}/          <- open this on the PC")
        banner.append(f"  ... then on the phone: http://{ip}:{PORT}/writer/<doc-id>")
    banner.append("")
    print("\n".join(banner), flush=True)

    web.run_app(app, port=PORT, print=None)


if __name__ == "__main__":
    if sys.platform.startswith("win"):
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    main()
