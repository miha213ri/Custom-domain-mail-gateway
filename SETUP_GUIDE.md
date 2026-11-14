# Setup & Configuration Guide (Navodila za namestitev)

<p align="center">
  <a href="#english-guide">English Guide</a> •
  <a href="#navodila-v-slovenščini-slovenian-guide">Navodila v slovenščini</a>
</p>

---

# English Guide

This guide covers deploying the **Custom Domain Mail Gateway** on your web hosting server (cPanel, Linux VPS, NeoServ) and connecting the browser extension.

## 1. Domain & DNS Configuration

To ensure maximum email deliverability and avoid landing in recipient Spam/Junk folders, configure these three DNS records on your domain:

1. **SPF (TXT record on your root domain):**
   ```text
   v=spf1 include:_spf.your-host.com ~all
   ```
2. **DKIM:**
   Enable DKIM in your hosting control panel (e.g. cPanel $\rightarrow$ *Email Deliverability*). Ensure the generated public key is published in your DNS.
3. **DMARC (TXT record on `_dmarc.yourdomain.com`):**
   ```text
   v=DMARC1; p=quarantine; rua=mailto:postmaster@yourdomain.com
   ```

---

## 2. Server Deployment (cPanel / WSGI)

1. Open cPanel and navigate to **Setup Python App**.
2. Click **Create Application**:
   - **Python version:** `3.11` or `3.12`
   - **Application root:** `mail_gateway`
   - **Application URL:** `gateway.yourdomain.com`
   - **Application startup file:** `passenger_wsgi.py`
   - **Application Entry point:** `application`
3. Upload the contents of `backend/` into `mail_gateway`:
   - `app.py`
   - `download_page.html`
   - `passenger_wsgi.py`
   - `requirements.txt`
   - `logo.png` & `favicon.ico`
4. Create your secret configuration files:
   - Copy `config.ini.example` $\rightarrow$ `config.ini` and set a secure 64-character random API token and your SMTP/IMAP host settings.
   - Copy `smtp_credentials.ini.example` $\rightarrow$ `smtp_credentials.ini` and enter your authorized mailbox passwords.
5. In your server terminal or cPanel interface, install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
6. Click **Restart Application**.

---

## 3. Browser Extension Installation

1. Open your browser (Brave, Chrome, Edge, Opera GX).
2. Navigate to `chrome://extensions/` (or `brave://extensions/`).
3. Enable **Developer mode** in the top right corner.
4. Click **Load unpacked** and select the `extension/` folder (or simply **drag and drop** the `extension/` folder into the Chrome extensions window).
5. Click the extension icon in your browser toolbar:
   - **Gateway URL:** `https://gateway.yourdomain.com`
   - **API Token:** your secret token from `config.ini`
   - **My Email Addresses:** comma-separated addresses belonging to this computer (e.g. `user@yourdomain.com`).
   - Click **Save Settings** (the status dot will turn green).

---

## 4. Sending from Gmail

1. Open [Gmail](https://mail.google.com) and reload (`F5`).
2. Click **Compose**.
3. In the **From** field, pick your custom domain address.
4. A distinct `[ ✉️ Send from Custom Domain ]` button will appear next to Gmail's send button.
5. Click it — the message is delivered via your SMTP server, archived to your host's Sent folder, and linked into your Gmail thread automatically!

---

# Navodila v slovenščini (Slovenian Guide)

## 1. Nastavitev domene in DNS zapisov

Za visoko dostavljivost e-pošte morajo biti na domeni urejeni trije zapisi:

1. **SPF (TXT zapis na domeni):**
   ```text
   v=spf1 include:_spf.neoserv.si ~all
   ```
2. **DKIM:**
   V cPanelu pod **Email Deliverability** preverite, da je DKIM ključ veljaven in nameščen.
3. **DMARC (TXT zapis `_dmarc.vasa-domena.si`):**
   ```text
   v=DMARC1; p=quarantine; rua=mailto:postmaster@vasa-domena.si
   ```

---

## 2. Namestitev na cPanel (Setup Python App)

1. V cPanelu poiščite **Setup Python App**.
2. Kliknite **Create Application** (Python 3.11 ali 3.12, startup file: `passenger_wsgi.py`, entry point: `application`).
3. Naložite datoteke iz mape `backend/` v mapo aplikacije.
4. Ustvarite `config.ini` in `smtp_credentials.ini` po zgledu `.example`.
5. Namestite knjižnice: `pip install -r requirements.txt`.
6. Kliknite **Restart Application**.

---

## 3. Namestitev razširitve in pošiljanje

1. V brskalniku odprite `chrome://extensions/` in vklopite **Razvijalski način**.
2. Kliknite **Naloži razpakirano** in izberite mapo `extension/`.
3. Vnesite URL Gatewaya in API žeton.
4. V Gmailu osvežite stran (`F5`) in kliknite nov gumb za pošiljanje z lastne domene.
