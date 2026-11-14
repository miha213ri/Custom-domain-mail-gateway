# Podrobna navodila za namestitev in konfiguracijo (Setup Guide)

Ta dokument vsebuje celoten postopek namestitve lastnega prehoda **Custom Domain Mail Gateway** na vašem strežniku (npr. NeoServ, cPanel ali poljuben Linux VPS).

---

## 1. Nastavitev domene in DNS zapisov

Za visoko dostavljivost e-pošte in preprečevanje, da bi vaša sporočila končala v vsiljeni pošti (Spam), morajo biti na domeni urejeni trije zapisi:

1. **SPF (TXT zapis na domeni):**
   ```text
   v=spf1 include:_spf.neoserv.si ~all
   ```
   *(Prilagodite glede na vašega ponudnika gostovanja).*

2. **DKIM:**
   V cPanelu pod **Email Deliverability** preverite, da je DKIM ključ veljaven in nameščen.

3. **DMARC (TXT zapis `_dmarc.vasa-domena.si`):**
   ```text
   v=DMARC1; p=quarantine; rua=mailto:postmaster@vasa-domena.si
   ```

---

## 2. Namestitev na cPanel (Setup Python App)

1. V cPanelu poiščite **Setup Python App**.
2. Kliknite **Create Application**:
   - **Python version:** `3.11` ali `3.12`
   - **Application root:** `mail_gateway`
   - **Application URL:** `gateway.vasa-domena.si` (lahko poddomena)
   - **Application startup file:** `passenger_wsgi.py`
   - **Application Entry point:** `application`
3. Prek cPanel File Managerja v mapo `mail_gateway` naložite datoteke iz mape `backend/`:
   - `app.py`
   - `download_page.html`
   - `passenger_wsgi.py`
   - `requirements.txt`
   - `logo.png` in `favicon.ico`
4. Ustvarite konfiguracijski datoteki:
   - Kopirajte `config.ini.example` $\rightarrow$ `config.ini` in vpišite varen 64-znakovni `api_token` ter podatke za SMTP/IMAP.
   - Kopirajte `smtp_credentials.ini.example` $\rightarrow$ `smtp_credentials.ini` in vnesite gesla poštnih predalov.
5. V terminalu ali cPanel vmesniku namestite knjižnice:
   ```bash
   pip install -r requirements.txt
   ```
6. Kliknite **Restart Application**.

---

## 3. Namestitev brskalniške razširitve

1. Odprite brskalnik (Brave, Chrome, Edge, Opera).
2. Odprite naslov `chrome://extensions/` (ali `brave://extensions/`).
3. V zgornjem desnem kotu vklopite **Razvijalski način (Developer mode)**.
4. Kliknite gumb **Naloži razpakirano (Load unpacked)**.
5. Izberite mapo `extension/`.
6. Kliknite na ikono razširitve v orodni vrstici brskalnika:
   - **URL Gatewaya:** `https://gateway.vasa-domena.si`
   - **API žeton:** vaš skrivni žeton iz `config.ini`
   - **Moji e-poštni naslovi:** naslovi, ki pripadajo temu računalniku (npr. `janez@vasa-domena.si`)
   - Kliknite **Shrani nastavitve** (indikator se obarva zeleno).

---

## 4. Pošiljanje iz Gmaila

1. Odprite [Gmail](https://mail.google.com) in pritisnite tipko **F5** (osvežitev).
2. Kliknite **Sestavi (Compose)**.
3. V polju **Od (From)** izberite svoj naslov z lastno domeno.
4. V spodnji orodni vrstici se prikaže gumb `[ ✉️ Pošlji z lastne domene ]`.
5. Kliknite nanj – sporočilo bo poslano prek vašega SMTP strežnika, varno arhivirano v IMAP Sent in samodejno povezano v vašem Gmail predalu!
