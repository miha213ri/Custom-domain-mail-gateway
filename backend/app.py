"""Custom Domain Mail Gateway v0.8.0 - Production SMTP Gateway with BCC Loopback & IMAP Sync.

Nadgradnja iz v0.5 v v0.8:
1. Popolna CORS podpora za brskalniške razširitve (Chrome, Brave, Opera GX, Firefox).
2. Odprava pilotskih omejitev: omogočeno pošiljanje za vseh 9 računov vsem prejemnikom.
3. Samodejna Bcc zanka pošiljatelju (BCC_SELF = True): kopija se samodejno vrne v pošiljateljev
   Gmail in poveže v obstoječo nit pogovora brez potrebe po Google Cloud/OAuth poverilnicah!
4. Samodejni vpis v IMAP mapo INBOX.Sent na NeoServu kot trajni arhiv podjetja.
5. Varna avtentikacija z X-AFNARIJA-TOKEN in preverjanje celovitosti MIME (SHA-256).
6. SQLite evidenca za preprečevanje podvojenih pošiljanj.
"""
from __future__ import annotations

import base64
import binascii
import configparser
import hashlib
import hmac
import imaplib
import logging
import os
import re
import smtplib
import sqlite3
import ssl
import time
import uuid
from datetime import datetime, timezone
from email import policy
from email.message import Message
from email.parser import BytesParser
from email.utils import getaddresses
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, render_template_string, request, send_file

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = Path(os.environ.get("MAIL_GATEWAY_CONFIG", BASE_DIR / "config.ini"))


def load_settings() -> configparser.ConfigParser:
    cfg = configparser.ConfigParser(interpolation=None)
    if not CONFIG_PATH.is_file():
        raise RuntimeError(
            f"Configuration file not found: {CONFIG_PATH}. "
            "Please ensure config.ini exists in the gateway directory."
        )
    loaded = cfg.read(CONFIG_PATH, encoding="utf-8")
    if not loaded:
        raise RuntimeError(f"Could not read configuration file: {CONFIG_PATH}")
    return cfg


settings = load_settings()
API_TOKEN = settings.get("security", "api_token", fallback="").strip()
MODE = settings.get("app", "mode", fallback="PRODUCTION").strip().upper()
VERSION = "0.8.1"
MAX_PAYLOAD_MB = settings.getint("app", "max_payload_mb", fallback=32)
MAX_RECIPIENTS = settings.getint("app", "max_recipients", fallback=50)

# Poverilnice in nastavitve SMTP strežnika
SMTP_SETTINGS_PATH = Path(os.environ.get("MAIL_GATEWAY_SMTP_SETTINGS", BASE_DIR / "smtp_settings.ini"))
SMTP_CREDENTIALS_PATH = Path(os.environ.get("MAIL_GATEWAY_SMTP_CREDENTIALS", BASE_DIR / "smtp_credentials.ini"))


def _load_optional_ini(path: Path) -> configparser.ConfigParser:
    parser = configparser.ConfigParser(interpolation=None)
    if path.is_file():
        parser.read(path, encoding="utf-8")
    return parser


SMTP_SETTINGS = _load_optional_ini(SMTP_SETTINGS_PATH)
SMTP_CREDENTIALS = _load_optional_ini(SMTP_CREDENTIALS_PATH)

ENABLE_SENDING = settings.getboolean("sending", "enabled", fallback=True)
SEND_TIMEOUT = settings.getint("sending", "timeout_seconds", fallback=25)
BCC_SELF = settings.getboolean("sending", "bcc_self", fallback=True)
SYNC_IMAP_SENT = settings.getboolean("sending", "sync_imap_sent", fallback=True)

SEND_DB_PATH = Path(os.environ.get(
    "MAIL_GATEWAY_SEND_DB",
    settings.get("sending", "database_path", fallback=str(BASE_DIR / "data" / "send_log.sqlite3"))
))
if not SEND_DB_PATH.is_absolute():
    SEND_DB_PATH = BASE_DIR / SEND_DB_PATH

ALLOWED_SENDERS = {
    item.strip().lower()
    for item in settings.get("mail", "allowed_senders", fallback="").split(",")
    if item.strip()
}

SENDER_ACCOUNTS: dict[str, str] = {}
if settings.has_section("sender_accounts"):
    SENDER_ACCOUNTS = {
        sender.strip().lower(): username.strip()
        for sender, username in settings.items("sender_accounts")
        if sender.strip() and username.strip()
    }

# Pošiljanje je omogočeno v PRODUCTION ali PILOT načinu
LIVE_SENDING_ENABLED = bool(ENABLE_SENDING and MODE in {"PILOT", "PRODUCTION"})

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_PAYLOAD_MB * 1024 * 1024

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mail_gateway")

EMAIL_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@"
    r"(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+"
    r"[A-Za-z]{2,63}$"
)


@app.after_request
def _add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-AFNARIJA-TOKEN"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


def _json_error(message: str, status: int, request_id: str | None = None):
    body: dict[str, Any] = {"ok": False, "error": message}
    if request_id:
        body["request_id"] = request_id
    return jsonify(body), status


def _authorized() -> bool:
    supplied = request.headers.get("X-AFNARIJA-TOKEN", "").strip()
    if not supplied:
        auth = request.headers.get("Authorization", "")
        if auth.lower().startswith("bearer "):
            supplied = auth[7:].strip()
    if not supplied and request.is_json:
        data = request.get_json(silent=True) or {}
        supplied = str(data.get("api_token") or "").strip()
    return bool(supplied and API_TOKEN and hmac.compare_digest(supplied, API_TOKEN))


def _valid_email(address: str) -> bool:
    address = (address or "").strip()
    if len(address) > 254 or not EMAIL_RE.fullmatch(address):
        return False
    local, domain = address.rsplit("@", 1)
    return len(local) <= 64 and len(domain) <= 253 and ".." not in address


def _decode_base64url(value: str) -> bytes:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("raw_mime_b64url is missing or empty")
    compact = re.sub(r"\s+", "", value.strip())
    compact = compact.replace("-", "+").replace("_", "/")
    compact = compact.rstrip("=")
    if not compact or not re.fullmatch(r"[A-Za-z0-9+/]+", compact):
        raise ValueError("raw_mime_b64url contains invalid Base64URL characters")
    remainder = len(compact) % 4
    if remainder == 1:
        raise ValueError("raw_mime_b64url has an invalid Base64URL length")
    padded = compact + ("=" * ((4 - remainder) % 4))
    try:
        return base64.b64decode(padded.encode("ascii"), validate=True)
    except (binascii.Error, ValueError, UnicodeEncodeError) as exc:
        raise ValueError("raw_mime_b64url is not valid Base64URL") from exc


def _addresses_from_headers(message: Message, header_name: str) -> tuple[list[str], list[str]]:
    raw_values = message.get_all(header_name, [])
    parsed = getaddresses([str(value) for value in raw_values])
    good: list[str] = []
    bad: list[str] = []
    for _display_name, address in parsed:
        candidate = (address or "").strip()
        if not candidate:
            continue
        if _valid_email(candidate):
            normalized = candidate.lower()
            if normalized not in good:
                good.append(normalized)
        else:
            bad.append(candidate[:200])
    return good, bad


def _analyse_message(raw_bytes: bytes) -> dict[str, Any]:
    message = BytesParser(policy=policy.default).parsebytes(raw_bytes)
    if not message.keys():
        raise ValueError("MIME message has no headers")

    from_values = message.get_all("From", [])
    if len(from_values) != 1:
        raise ValueError("Message must contain exactly one From header")
    from_addresses, bad_from = _addresses_from_headers(message, "From")
    if bad_from or len(from_addresses) != 1:
        raise ValueError("From header must contain exactly one valid email address")

    to, bad_to = _addresses_from_headers(message, "To")
    cc, bad_cc = _addresses_from_headers(message, "Cc")
    bcc, bad_bcc = _addresses_from_headers(message, "Bcc")
    bad_recipients = bad_to + bad_cc + bad_bcc
    recipients = list(dict.fromkeys(to + cc + bcc))
    if bad_recipients:
        raise ValueError("One or more recipient addresses are malformed")
    if not recipients:
        raise ValueError("Message has no To, Cc, or Bcc recipient")
    if len(recipients) > MAX_RECIPIENTS:
        raise ValueError(f"Message exceeds configured recipient limit ({MAX_RECIPIENTS})")

    return {
        "from_address": from_addresses[0],
        "recipient_addresses": recipients,
        "recipient_count": len(recipients),
    }


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _init_send_db() -> None:
    SEND_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(SEND_DB_PATH, timeout=10) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS send_attempts (
                dedupe_key TEXT PRIMARY KEY,
                request_id TEXT NOT NULL,
                sender TEXT NOT NULL,
                mime_sha256 TEXT NOT NULL,
                status TEXT NOT NULL,
                smtp_code INTEGER,
                detail_code TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        conn.commit()


def _reserve_send(dedupe_key: str, request_id: str, sender: str, mime_sha256: str) -> tuple[bool, str]:
    _init_send_db()
    now = _utc_now()
    with sqlite3.connect(SEND_DB_PATH, timeout=10, isolation_level=None) as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT status FROM send_attempts WHERE dedupe_key = ?", (dedupe_key,)
        ).fetchone()
        if row:
            prior_status = str(row[0])
            if prior_status == "FAILED":
                conn.execute(
                    "UPDATE send_attempts SET request_id=?, status='SENDING', smtp_code=NULL, detail_code=NULL, updated_at=? WHERE dedupe_key=?",
                    (request_id, now, dedupe_key),
                )
                conn.execute("COMMIT")
                return True, "RETRY_AFTER_DEFINITE_FAILURE"
            conn.execute("ROLLBACK")
            return False, prior_status
        conn.execute(
            "INSERT INTO send_attempts (dedupe_key, request_id, sender, mime_sha256, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'SENDING', ?, ?)",
            (dedupe_key, request_id, sender, mime_sha256, now, now),
        )
        conn.execute("COMMIT")
        return True, "RESERVED"


def _update_send_record(dedupe_key: str, status: str, smtp_code: int | None = None, detail_code: str | None = None) -> None:
    _init_send_db()
    with sqlite3.connect(SEND_DB_PATH, timeout=10) as conn:
        conn.execute(
            "UPDATE send_attempts SET status=?, smtp_code=?, detail_code=?, updated_at=? WHERE dedupe_key=?",
            (status, smtp_code, (detail_code or "")[:80], _utc_now(), dedupe_key),
        )
        conn.commit()


def _smtp_credentials_for_sender(sender: str) -> tuple[str, str]:
    normalized = sender.lower().strip()
    mapped_username = SENDER_ACCOUNTS.get(normalized, normalized)
    section = "account:" + mapped_username
    if not SMTP_CREDENTIALS.has_section(section):
        raise RuntimeError(f"V smtp_credentials.ini manjka profil [{section}]")
    username = SMTP_CREDENTIALS.get(section, "username", fallback=mapped_username).strip()
    password = SMTP_CREDENTIALS.get(section, "password", fallback="")
    if not password.strip():
        raise RuntimeError(f"V profilu [{section}] manjka geslo")
    return username, password


def _open_smtp_connection():
    host = SMTP_SETTINGS.get("smtp", "host", fallback="mail.tvoja-domena.si").strip()
    security = SMTP_SETTINGS.get("smtp", "security", fallback="SSL").strip().upper()
    port = SMTP_SETTINGS.getint("smtp", "port", fallback=465)
    context = ssl.create_default_context()

    if security == "SSL" or port == 465:
        return smtplib.SMTP_SSL(host, port, timeout=SEND_TIMEOUT, context=context)

    client = smtplib.SMTP(host, port, timeout=SEND_TIMEOUT)
    if security == "STARTTLS" or port == 587:
        client.ehlo()
        client.starttls(context=context)
        client.ehlo()
    return client


def _append_to_imap_sent(username: str, password: str, raw_bytes: bytes) -> bool:
    """Shrani poslano sporočilo v mapo Poslano (Sent) na NeoServ IMAP strežniku."""
    if not SYNC_IMAP_SENT:
        return True
    try:
        host = SMTP_SETTINGS.get("smtp", "host", fallback="mail.tvoja-domena.si").strip()
        context = ssl.create_default_context()
        with imaplib.IMAP4_SSL(host, 993, ssl_context=context, timeout=10) as imap:
            imap.login(username, password)
            status, folder_list = imap.list()
            target_folder = "INBOX.Sent"
            if folder_list:
                for f in folder_list:
                    dec = f.decode("utf-8", errors="ignore")
                    if "INBOX.Sent" in dec:
                        target_folder = "INBOX.Sent"
                        break
                    elif '"Sent"' in dec or " Sent" in dec:
                        target_folder = "Sent"
                        break
            now = imaplib.Time2Internaldate(time.time())
            imap.append(target_folder, "\\Seen", now, raw_bytes)
            logger.info("MIME shranjen v IMAP mapo %s za uporabnika %s", target_folder, username)
            return True
    except Exception:
        logger.exception("Napaka pri IMAP shranjevanju v mapo Sent za %s", username)
        return False


# =====================================================================
# HTTP ENDPOINTS
# =====================================================================

@app.route("/", methods=["GET", "OPTIONS"])
def index():
    if request.method == "OPTIONS":
        return "", 204
    return jsonify({
        "service": "Custom Domain Mail Gateway",
        "status": "running",
        "mode": MODE,
        "version": VERSION,
        "sending_enabled": LIVE_SENDING_ENABLED,
    })


@app.route("/health", methods=["GET", "OPTIONS"])
def health():
    if request.method == "OPTIONS":
        return "", 204
    return jsonify({
        "ok": True,
        "service": "custom-domain-mail-gateway",
        "mode": MODE,
        "version": VERSION,
        "sending_enabled": LIVE_SENDING_ENABLED,
        "bcc_self": BCC_SELF,
        "sync_imap_sent": SYNC_IMAP_SENT,
    })


def _find_exe_file() -> Path | None:
    """Poišče namestitveni program .exe v mapi aplikacije ali podmapah."""
    for name in ["Namesti_Mail_Gateway.exe", "installer.exe", "Setup_AFNARIJA_Mail.exe"]:
        p = BASE_DIR / name
        if p.is_file() and p.stat().st_size > 1000:
            return p
    for p in sorted(BASE_DIR.glob("*.exe")):
        if p.is_file() and p.stat().st_size > 1000:
            return p
    for sub in ["static", "public"]:
        sdir = BASE_DIR / sub
        if sdir.is_dir():
            for p in sorted(sdir.glob("*.exe")):
                if p.is_file() and p.stat().st_size > 1000:
                    return p
    return None


def _find_zip_file() -> Path | None:
    """Poišče poljubno ZIP datoteko z razširitvijo v mapi aplikacije ali podmapah."""
    for name in ["mail-gateway-extension.zip", "mail-gateway-extension.zip", "extension.zip"]:
        p = BASE_DIR / name
        if p.is_file() and p.stat().st_size > 1000:
            return p
    for p in sorted(BASE_DIR.glob("*.zip")):
        if p.is_file() and p.stat().st_size > 1000:
            return p
    for sub in ["static", "public"]:
        sdir = BASE_DIR / sub
        if sdir.is_dir():
            for p in sorted(sdir.glob("*.zip")):
                if p.is_file() and p.stat().st_size > 1000:
                    return p
    return None


def _find_gs_file() -> Path | None:
    """Poišče datoteko Koda.gs z rezervnim dodatkom Google Apps Script."""
    for name in ["Koda.gs", "coda.gs", "AFNARIJA_Mail_Code_v22_Production.gs"]:
        p = BASE_DIR / name
        if p.is_file() and p.stat().st_size > 1000:
            return p
    for p in sorted(BASE_DIR.glob("*.gs")):
        if p.is_file() and p.stat().st_size > 1000:
            return p
    return None


def _format_size(size_bytes: int) -> str:
    if size_bytes >= 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
    if size_bytes >= 1024:
        return f"{size_bytes / 1024:.0f} KB"
    return f"{size_bytes} B"


def _load_download_page_template() -> str:
    """Naloži HTML predlogo strani za prenos iz ločene datoteke download_page.html."""
    html_file = BASE_DIR / "download_page.html"
    if html_file.is_file():
        try:
            return html_file.read_text(encoding="utf-8")
        except Exception as exc:
            logger.error("Napaka pri branju download_page.html: %s", exc)
    return """<!DOCTYPE html><html lang="sl"><head><meta charset="utf-8"><title>Center za prenos</title></head><body><h1>Center za prenos</h1><p><a href="/prenos/Namesti_Mail_Gateway.exe">Prenesi namestitveni program (.exe)</a></p><p><a href="/prenos/mail-gateway-extension.zip">Prenesi ZIP paket (.zip)</a></p><p><a href="/prenos/Koda.gs">Prenesi Koda.gs</a></p></body></html>"""


@app.route("/prenos", methods=["GET"], strict_slashes=False)
@app.route("/prenos/<path:subpath>", methods=["GET"], strict_slashes=False)
def download_center(subpath: str = ""):
    """Center za prenos namestitvenega programa, razširitve in predstavitvena stran."""
    subpath_l = (subpath or "").lower().strip()
    query_dl = request.args.get("download", request.args.get("dl", "")).lower().strip()
    user_agent = request.headers.get("User-Agent", "")

    # Če klicatelj želi neposredno prenesti ZIP (program AfnarijaInstaller ali curl/skripta)
    if "mailgatewayinstaller" in user_agent.lower() and not ("exe" in subpath_l or query_dl == "exe"):
        zip_p = _find_zip_file()
        if zip_p and zip_p.is_file():
            return send_file(
                str(zip_p.resolve()),
                mimetype="application/zip",
                as_attachment=True,
                download_name="mail-gateway-extension.zip"
            )

    # 1. Zahteva za EXE
    if "exe" in subpath_l or subpath_l == "installer" or query_dl == "exe":
        exe_p = _find_exe_file()
        if exe_p and exe_p.is_file():
            return send_file(
                str(exe_p.resolve()),
                mimetype="application/vnd.microsoft.portable-executable",
                as_attachment=True,
                download_name="Namesti_Mail_Gateway.exe"
            )
        files_in_dir = [f.name for f in BASE_DIR.iterdir() if f.is_file() and not f.name.startswith(".")]
        return jsonify({
            "ok": False,
            "error": "Namestitveni program .exe še ni naložen na strežnik.",
            "mapa_kjer_isce": str(BASE_DIR),
            "datoteke_v_mapi": sorted(files_in_dir)
        }), 404

    # 2. Zahteva za ZIP
    if "zip" in subpath_l or subpath_l == "extension" or query_dl == "zip":
        zip_p = _find_zip_file()
        if zip_p and zip_p.is_file():
            return send_file(
                str(zip_p.resolve()),
                mimetype="application/zip",
                as_attachment=True,
                download_name="mail-gateway-extension.zip"
            )
        files_in_dir = [f.name for f in BASE_DIR.iterdir() if f.is_file() and not f.name.startswith(".")]
        return jsonify({
            "ok": False,
            "error": "ZIP paket razširitve še ni naložen na strežnik.",
            "mapa_kjer_isce": str(BASE_DIR),
            "datoteke_v_mapi": sorted(files_in_dir)
        }), 404

    # 3. Zahteva za logotip ali favicon
    if subpath_l in ["logo.png", "logo", "icon.png"]:
        logo_p = BASE_DIR / "logo.png"
        if logo_p.is_file():
            return send_file(str(logo_p.resolve()), mimetype="image/png")
    if subpath_l in ["favicon.ico", "favicon.png"]:
        fav_p = BASE_DIR / "favicon.ico"
        if fav_p.is_file():
            return send_file(str(fav_p.resolve()), mimetype="image/x-icon")

    # 4. Prikaz spletne strani za prenos (/prenos)
    exe_p = _find_exe_file()
    zip_p = _find_zip_file()

    exe_ready = bool(exe_p and exe_p.is_file())
    zip_ready = bool(zip_p and zip_p.is_file())

    exe_size_str = _format_size(exe_p.stat().st_size) if exe_ready else ""
    zip_size_str = _format_size(zip_p.stat().st_size) if zip_ready else ""

    return render_template_string(
        _load_download_page_template(),
        ext_version="1.4.2",
        gateway_version=VERSION,
        exe_ready=exe_ready,
        zip_ready=zip_ready,
        exe_size=exe_size_str,
        zip_size=zip_size_str,
    )


@app.route("/api/v5/version", methods=["GET", "OPTIONS"], strict_slashes=False)
def extension_version():
    """Vrne informacijo o najnovejši različici za samodejne posodobitve."""
    if request.method == "OPTIONS":
        return "", 204
    exe_p = _find_exe_file()
    zip_p = _find_zip_file()
    return jsonify({
        "ok": True,
        "extension_version": "1.4.2",
        "gateway_version": VERSION,
        "download_url": "https://gateway.tvoja-domena.si/prenos/zip",
        "exe_url": "https://gateway.tvoja-domena.si/prenos/exe",
        "zip_url": "https://gateway.tvoja-domena.si/prenos/zip",
        "landing_page": "https://gateway.tvoja-domena.si/prenos",
        "exe_file_ready": bool(exe_p and exe_p.is_file()),
        "zip_file_ready": bool(zip_p and zip_p.is_file()),
        "notes": "Produkcijska različica s samodejno Bcc sinhronizacijo v Gmail."
    }), 200


@app.route("/api/v5/status/<request_id>", methods=["GET", "OPTIONS"])
def get_send_status(request_id: str):
    """Vrne status obdelave sporočila po enoličnem request_id."""
    if request.method == "OPTIONS":
        return "", 204

    if not _authorized():
        return _json_error("Neveljaven ali manjkajoč API žeton (X-AFNARIJA-TOKEN)", 401)

    _init_send_db()
    with sqlite3.connect(SEND_DB_PATH, timeout=5) as conn:
        row = conn.execute(
            "SELECT request_id, sender, mime_sha256, status, smtp_code, detail_code, created_at, updated_at "
            "FROM send_attempts WHERE request_id = ? ORDER BY created_at DESC LIMIT 1",
            (request_id,),
        ).fetchone()

    if not row:
        return _json_error("Zahtevek s tem request_id ne obstaja", 404, request_id)

    return jsonify({
        "ok": True,
        "request_id": row[0],
        "sender": row[1],
        "mime_sha256": row[2],
        "status": row[3],
        "smtp_code": row[4],
        "detail_code": row[5],
        "created_at": row[6],
        "updated_at": row[7],
    }), 200


@app.route("/api/v5/admin/recent", methods=["GET", "OPTIONS"])
def list_recent_sends():
    """Vrne zadnjih 50 pošiljanj za administrativni nadzor in analizo napak."""
    if request.method == "OPTIONS":
        return "", 204

    if not _authorized():
        return _json_error("Neveljaven ali manjkajoč API žeton (X-AFNARIJA-TOKEN)", 401)

    _init_send_db()
    with sqlite3.connect(SEND_DB_PATH, timeout=5) as conn:
        cursor = conn.execute(
            "SELECT request_id, sender, status, smtp_code, detail_code, created_at, updated_at "
            "FROM send_attempts ORDER BY created_at DESC LIMIT 50"
        )
        rows = cursor.fetchall()

    history = [
        {
            "request_id": r[0],
            "sender": r[1],
            "status": r[2],
            "smtp_code": r[3],
            "detail_code": r[4],
            "created_at": r[5],
            "updated_at": r[6],
        }
        for r in rows
    ]
    return jsonify({
        "ok": True,
        "count": len(history),
        "history": history,
    }), 200


@app.route("/api/v5/send", methods=["POST", "OPTIONS"])
@app.route("/api/v6/send", methods=["POST", "OPTIONS"])
def send_message():
    """Pošlje e-pošto prek SMTP z avtomatsko Bcc zanko in IMAP shranjevanjem."""
    if request.method == "OPTIONS":
        return "", 204

    if not _authorized():
        return _json_error("Neveljaven ali manjkajoč API žeton (X-AFNARIJA-TOKEN)", 401)

    if not LIVE_SENDING_ENABLED:
        return _json_error("Pošiljanje je onemogočeno v konfiguraciji", 503)

    if not request.is_json:
        return _json_error("Content-Type must be application/json", 415)

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return _json_error("Zahteva mora biti veljaven JSON", 400)

    request_id = str(data.get("request_id") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", request_id):
        return _json_error("request_id is missing or invalid", 400)

    draft_id = str(data.get("draft_id") or "").strip()
    if not draft_id or len(draft_id) > 512:
        return _json_error("draft_id is missing or invalid", 400, request_id)

    selected_sender = str(data.get("sender_address") or "").strip().lower()
    if not _valid_email(selected_sender):
        return _json_error("sender_address must be a valid email address", 400, request_id)

    if ALLOWED_SENDERS and selected_sender not in ALLOWED_SENDERS:
        return _json_error(f"Pošiljatelj {selected_sender} ni na seznamu dovoljenih pošiljateljev", 403, request_id)

    # Pridobi SMTP poverilnice za pošiljatelja iz smtp_credentials.ini
    try:
        username, password = _smtp_credentials_for_sender(selected_sender)
    except Exception as exc:
        logger.error("Napaka pri pridobivanju poverilnic za %s: %s", selected_sender, exc)
        return _json_error(str(exc), 503, request_id)

    # Analiza MIME vsebine in SHA-256 preverjanje
    try:
        raw_bytes = _decode_base64url(data.get("raw_mime_b64url", ""))
        supplied_sha256 = str(data.get("raw_mime_sha256") or "").strip().lower()
        if not re.fullmatch(r"[0-9a-f]{64}", supplied_sha256):
            raise ValueError("raw_mime_sha256 must be a 64-character SHA-256 hex digest")
        calculated_sha256 = hashlib.sha256(raw_bytes).hexdigest()
        if not hmac.compare_digest(supplied_sha256, calculated_sha256):
            return _json_error("MIME SHA-256 mismatch; send refused", 409, request_id)

        summary = _analyse_message(raw_bytes)
        if summary["from_address"].lower() != selected_sender:
            return _json_error("From header does not match selected SMTP sender", 409, request_id)

        recipients = summary["recipient_addresses"]
    except ValueError as exc:
        return _json_error(str(exc), 400, request_id)
    except Exception as exc:
        logger.error("Napaka pri analizi sporočila request_id=%s: %s", request_id, exc)
        return _json_error("Neveljavna MIME vsebina", 400, request_id)

    # Idempotenca (SQLite)
    dedupe_key = hashlib.sha256(
        (draft_id + "|" + selected_sender + "|" + calculated_sha256).encode("utf-8")
    ).hexdigest()
    try:
        reserved, prior_status = _reserve_send(dedupe_key, request_id, selected_sender, calculated_sha256)
    except Exception:
        logger.exception("Napaka pri rezervaciji pošiljanja request_id=%s", request_id)
        return _json_error("Napaka baze podatkov pri rezervaciji pošiljanja", 503, request_id)

    if not reserved:
        return jsonify({
            "ok": False,
            "error": "To sporočilo je že bilo poslano ali je v obdelavi",
            "prior_status": prior_status,
            "request_id": request_id,
        }), 409

    # Priprava ovojnice prejemnikov:
    # Vključuje prejemnike in samodejni Bcc pošiljatelju (za sinhronizacijo v Gmail)
    envelope_recipients = list(recipients)
    if BCC_SELF and selected_sender not in envelope_recipients:
        envelope_recipients.append(selected_sender)

    message = BytesParser(policy=policy.default).parsebytes(raw_bytes)
    send_started = False
    smtp_accepted = False

    try:
        with _open_smtp_connection() as smtp:
            smtp.login(username, password)
            send_started = True
            refused = smtp.send_message(
                message,
                from_addr=selected_sender,
                to_addrs=envelope_recipients,
            )
            if not refused:
                smtp_accepted = True
                _update_send_record(dedupe_key, "SMTP_ACCEPTED", detail_code="ACCEPTED")

        if refused:
            _update_send_record(dedupe_key, "FAILED", detail_code="RECIPIENT_REFUSED")
            return jsonify({
                "ok": False,
                "error": "SMTP strežnik je zavrnil prejemnike",
                "request_id": request_id,
                "smtp_status": "RECIPIENT_REFUSED",
            }), 502

        # IMAP shranjevanje v Sent mapo na NeoServu
        _append_to_imap_sent(username, password, raw_bytes)

        logger.info(
            "Uspešno poslano prek SMTP request_id=%s sender=%s recipients=%d (envelope=%d) bytes=%d",
            request_id, selected_sender, len(recipients), len(envelope_recipients), len(raw_bytes)
        )
        return jsonify({
            "ok": True,
            "request_id": request_id,
            "smtp_status": "SMTP_ACCEPTED",
            "smtp_accepted": True,
            "sender": selected_sender,
            "recipient_count": len(recipients),
            "mime_size_bytes": len(raw_bytes),
            "raw_mime_sha256": calculated_sha256,
            "bcc_self": BCC_SELF,
            "notice": "SMTP strežnik je sprejel sporočilo. Kopija je bila poslana na vaš predal in shranjena v mapi Poslano.",
        }), 200

    except smtplib.SMTPAuthenticationError:
        _update_send_record(dedupe_key, "FAILED", detail_code="AUTH_FAILED")
        return _json_error("Napačno geslo ali uporabniško ime v smtp_credentials.ini za tega pošiljatelja", 401, request_id)
    except smtplib.SMTPRecipientsRefused:
        _update_send_record(dedupe_key, "FAILED", detail_code="RECIPIENTS_REFUSED")
        return _json_error("SMTP strežnik je zavrnil prejemnike", 502, request_id)
    except smtplib.SMTPDataError as exc:
        _update_send_record(dedupe_key, "FAILED", getattr(exc, "smtp_code", None), "DATA_REJECTED")
        return _json_error("SMTP strežnik je zavrnil podatke sporočila", 502, request_id)
    except Exception as exc:
        if smtp_accepted:
            _append_to_imap_sent(username, password, raw_bytes)
            return jsonify({
                "ok": True,
                "request_id": request_id,
                "smtp_status": "SMTP_ACCEPTED",
                "smtp_accepted": True,
                "sender": selected_sender,
                "recipient_count": len(recipients),
            }), 200
        status = "UNKNOWN" if send_started else "FAILED"
        _update_send_record(dedupe_key, status, getattr(exc, "smtp_code", None), type(exc).__name__)
        return _json_error(f"Napaka pri pošiljanju: {exc}", 502, request_id)


@app.errorhandler(413)
def too_large(_error):
    return _json_error("Zahteva presega dovoljeno velikost (max 32 MB)", 413)


@app.errorhandler(500)
def internal_error(_error):
    logger.exception("Interna napaka Gatewaya")
    return _json_error("Interna napaka strežnika", 500)
