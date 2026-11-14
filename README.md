# Custom Domain Mail Gateway

Odprtokodna produkcijska rešitev, ki omogoča pošiljanje e-pošte z lastne domene neposredno iz brezplačnega spletnega vmesnika Gmail brez plačljive naročnine Google Workspace.

---

## 🌟 Ključne prednosti

1. **Brez naročnine Google Workspace:** Pošiljanje prek lastnega strežnika (SMTP SSL) neposredno iz Gmaila.
2. **Samodejni Bcc Loopback:** Ob vsakem pošiljanju se kopija vrne v Gmail in samodejno poveže v obstoječo nit pogovora.
3. **IMAP Arhiv:** Sporočilo se samodejno shrani v mapo `Sent` na vašem poštnem strežniku.
4. **Varnost podatkov:** Gesla poštnih predalov ostanejo varno na vašem strežniku, brskalnik komunicira le prek žetona.
5. **Enostaven namestilnik:** Samostojni pomočnik za Windows z enim klikom pripravi brskalniško razširitev.

---

## 🏗️ Struktura projekta

- `backend/`: Flask prehod (Python 3.12 / WSGI) za SMTP pošiljanje, IMAP sinhronizacijo in prenosno stran.
- `extension/`: Brskalniška razširitev (Manifest V3 za Chrome, Brave, Edge, Opera) z gumbom za pošiljanje.
- `installer/`: C# WinForms namestilnik za samodejno posodabljanje in odpiranje nastavitev brskalnika.
- `google-apps-script/`: Izbirna predloga Google Apps Script za napredne uporabnike.

---

## 🚀 Hitri zagon

### 1. Strežnik (Backend)
1. Naložite vsebino mape `backend/` na svoj strežnik (npr. cPanel z urejenim Python okoljem).
2. Preimenujte `config.ini.example` v `config.ini` in vnesite svoj varen API žeton ter SMTP/IMAP nastavitve.
3. Preimenujte `smtp_credentials.ini.example` v `smtp_credentials.ini` in vnesite gesla svojih predalov.
4. Zaženite aplikacijo prek WSGI ali `python app.py`.

### 2. Brskalniška razširitev (Extension)
1. V brskalniku odprite stran z razširitvami (`chrome://extensions/` ali `brave://extensions/`).
2. Vklopite **Razvijalski način (Developer mode)**.
3. Kliknite **Naloži razpakirano (Load unpacked)** in izberite mapo `extension/`.
4. Kliknite na ikono razširitve, vnesite URL svojega Gatewaya in svoj API žeton.

---

## 📄 Licenca

Projekt je na voljo pod licenco MIT.
