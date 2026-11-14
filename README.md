# Custom Domain Mail Gateway for Gmail

<p align="center">
  <strong>Send emails from your own custom domain directly within the free Gmail web interface — without an expensive Google Workspace subscription.</strong>
</p>

<p align="center">
  <a href="#-features">Features</a> •
  <a href="#-architecture">Architecture</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-ai-assisted-development-credits">Credits</a> •
  <a href="#-slovenski-opis--slovenian-summary">Slovenščina</a>
</p>

---

## 💡 The Problem & The Solution

* **The Problem:** Google Workspace charges €6–€18 per mailbox every month. For families, freelancers, clubs, and small teams with multiple domain aliases, costs quickly multiply. Furthermore, free Gmail no longer offers frictionless third-party custom domain SMTP routing.
* **The Solution:** **Custom Domain Mail Gateway** is a self-hosted, open-source bridge. It pairs a lightweight Manifest V3 browser extension with a secure Python/Flask gateway on your web host (cPanel, NeoServ, or Linux VPS). You compose emails inside normal Gmail, hit **[ ✉️ Send from Custom Domain ]**, and your mail is dispatched through your host's authenticated SMTP SSL server.

---

## 🌟 Key Features

1. 🔄 **Automatic Bcc Loopback (Zero-Cost Thread Sync):**
   When dispatching an email, the gateway automatically injects a hidden `Bcc` to the sender's own address. Gmail receives it and seamlessly merges the reply into your active conversation thread in your inbox and Sent view — no Google Cloud API fees or OAuth credentials needed.

2. 📥 **Corporate IMAP Sent Archiving:**
   Immediately after SMTP acceptance, the gateway saves the exact raw MIME message into your host's `INBOX.Sent` folder via IMAP SSL (Port 993) for audit compliance and multi-device access.

3. 🛡️ **Zero Password Exposure:**
   Mailbox passwords never leave your backend server. The client browser only holds an ephemeral API token. All requests are signed and checked with SHA-256 idempotency.

4. 🧩 **Clean Gmail UI Integration:**
   An unobtrusive vector button `[ ✉️ Send from Custom Domain ]` sits right next to Gmail's native Send button. It detects the active `From` address, packages the draft, and auto-discards the draft after delivery.

5. 🖥️ **Windows Companion App:**
   Includes a compact 73 KB .NET C# installer that unpacks the extension into your local profile and opens your browser settings in 5 seconds.

---

## 🏗️ Architecture

```text
[ Gmail Webmail UI (mail.google.com) ]
         │
         ▼ (User clicks "Send from Custom Domain")
[ Manifest V3 Browser Extension ]
         │
         ▼ HTTPS POST /api/v5/send (X-GATEWAY-TOKEN)
[ Flask Mail Gateway (Python 3.12 / WSGI) ]
         │
         ├──► 1. Authenticated SMTP SSL (Port 465) ──► Recipient (+ Bcc Loopback to Sender)
         │
         └──► 2. Authenticated IMAP SSL (Port 993) ──► Server 'INBOX.Sent' Archive
```

---

## 🚀 Quick Start

### 1. Server Setup (cPanel / Linux VPS)
1. Upload the files inside `backend/` to your server directory (e.g. `/home/user/mail_gateway/`).
2. Copy `config.ini.example` to `config.ini` and set your 64-character random API token and SMTP/IMAP hosts.
3. Copy `smtp_credentials.ini.example` to `smtp_credentials.ini` and add your authorized sender accounts.
4. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
5. In cPanel **Setup Python App**, set the entry point to `passenger_wsgi.py` and restart the application.

### 2. Browser Extension Setup (Chrome, Brave, Edge, Opera GX)
1. Open `chrome://extensions/` (or `brave://extensions/`).
2. Toggle on **Developer mode** in the top right corner.
3. Click **Load unpacked** and select the `extension/` folder (or simply **drag and drop** the `extension/` folder directly into the browser window).
4. Click the extension toolbar icon and enter your **Gateway URL** and **API Token**.
5. Reload Gmail (`F5`), compose an email, choose your custom domain in the **From** dropdown, and click **[ ✉️ Send from Custom Domain ]**!

---

## 🤖 AI-Assisted Development Credits

This project was conceptualized, architected, and led by **Miha Ristič**.

The entire ecosystem was developed leveraging state-of-the-art AI-assisted software engineering:
* **ChatGPT (OpenAI):** Initial problem framing, exploratory protocol research, and early proof-of-concept development for Gmail integration.
* **Antigravity (Google DeepMind):** Production v0.8 gateway architecture, Bcc loopback thread synchronization, IMAP SSL compliance archiving, CORS handling, Manifest V3 extension optimizations, Windows companion app, and open-source packaging.

---

## 🇸🇮 Slovenski opis / Slovenian Summary

**Custom Domain Mail Gateway** je odprtokodna produkcijska rešitev, ki omogoča pošiljanje e-pošte z lastne domene neposredno iz brezplačnega Gmaila brez potrebe po plačljivi Google Workspace naročnini.

* **Brez mesečnih stroškov:** Pošiljanje prek lastnega strežnika (SMTP SSL).
* **Samodejna Bcc zanka:** Kopija sporočila se vrne v Gmail in samodejno poveže v obstoječo nit pogovora.
* **IMAP sinhronizacija:** Sporočilo se arhivira v mapo Poslano (Sent) na vašem strežniku.
* **Varnost gesel:** Gesla predalov ostanejo izključno na vašem strežniku.
* Za podrobna navodila v slovenščini preberite [SETUP_GUIDE.md](SETUP_GUIDE.md).

---

## 📄 License

This project is licensed under the MIT License.  
Copyright (c) 2026 **Miha Ristič**
