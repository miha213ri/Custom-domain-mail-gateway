/**
 * Custom Domain Mail – Content Script za Gmail (v1.4.2)
 * Zanesljivo zaznavanje stanja razširitve, zaščita pred Extension Context Invalidation
 * in natančno vodenje uporabnika.
 */

(function () {
  'use strict';

  let userEmails = [];

  function isExtensionValid() {
    try {
      return Boolean(
        typeof chrome !== 'undefined' &&
        chrome.runtime &&
        typeof chrome.runtime.sendMessage === 'function' &&
        chrome.runtime.id
      );
    } catch (e) {
      return false;
    }
  }

  function loadUserEmails() {
    if (!isExtensionValid() || !chrome.storage || !chrome.storage.local) return;
    try {
      chrome.storage.local.get(['userEmails'], (res) => {
        if (chrome.runtime.lastError) return;
        const raw = res.userEmails || '';
        userEmails = raw.split(',')
          .map(s => s.trim().toLowerCase())
          .filter(s => s.length > 0 && s.includes('@'));
        updateAllButtons();
      });
    } catch (e) {
      // Ignoriraj ob osvežitvi razširitve
    }
  }

  loadUserEmails();

  try {
    if (isExtensionValid() && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes) => {
        if (changes.userEmails) {
          loadUserEmails();
        }
      });
    }
  } catch (e) {}

  /**
   * Zazna izbrani pošiljateljski naslov v Gmailovem polju "Od / From"
   */
  function detectGmailFromAddress(composeBox) {
    const fromContainers = composeBox.querySelectorAll('div[aria-label*="From"], div[aria-label*="Od"], .J-M, span[email], .az9');
    for (const el of fromContainers) {
      const text = el.innerText || el.textContent || el.getAttribute('email') || '';
      const matches = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
      if (matches) {
        for (const m of matches) {
          const lower = m.toLowerCase();
          if (userEmails.includes(lower)) {
            return lower;
          }
        }
      }
    }
    return userEmails.length > 0 ? userEmails[0] : null;
  }

  function updateAllButtons() {
    document.querySelectorAll('.afnarija-send-btn').forEach(btn => {
      const composeBox = btn.closest('div[role="dialog"], .M9, .ip.adB, .aYF') || document.body;
      const activeSender = detectGmailFromAddress(composeBox);
      if (activeSender) {
        btn.title = `Pošlji e-pošto neposredno prek Neoserv SMTP kot ${activeSender}`;
      } else {
        btn.title = 'V nastavitvah razširitve (ikona zgoraj) vpišite vaš e-poštni naslov in API žeton';
      }
    });
  }

  function scanAndInjectComposeWindows() {
    const composeBoxes = document.querySelectorAll('div[role="dialog"], .M9, .ip.adB, .aYF');
    composeBoxes.forEach((composeBox) => {
      if (composeBox.querySelector('.afnarija-send-btn')) return;

      const sendBtn = composeBox.querySelector(
        'div[role="button"][data-tooltip*="Send"], ' +
        'div[role="button"][data-tooltip*="Pošlji"], ' +
        'div.T-I.J-J5-Ji.aoO.v7.T-I-atl.L3, ' +
        'div[role="button"].aoO'
      );

      if (!sendBtn) return;

      // Poišči celotno skupino Googlovega gumba (tako da modri trikotnik ostane zraven gumba Pošlji)
      const sendSplitGroup = sendBtn.closest('.dC') || sendBtn.parentElement;
      if (!sendSplitGroup) return;

      injectAfnarijaSendButton(composeBox, sendSplitGroup);
    });
  }

  function injectAfnarijaSendButton(composeBox, sendSplitGroup) {
    const activeSender = detectGmailFromAddress(composeBox);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'afnarija-send-btn';
    btn.title = activeSender
      ? `Pošlji e-pošto neposredno prek Neoserv SMTP kot ${activeSender}`
      : 'V nastavitvah razširitve vpišite vaš e-poštni naslov in API žeton';

    // Kristalno čist vektorski SVG v barvah Afnarije (nikoli zlomljena slika)
    btn.innerHTML = `
      <svg class="afnarija-btn-icon-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M3 5H21C21.55 5 22 5.45 22 6V18C22 18.55 21.55 19 21 19H3C2.45 19 2 18.55 2 18V6C2 5.45 2.45 5 3 5Z" fill="#ffffff" fill-opacity="0.18" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M3 6.5L12 13L21 6.5" stroke="#facc15" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span class="afnarija-btn-text">Pošlji z AFNARIJE</span>
    `;

    const droppedFiles = [];

    composeBox.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    composeBox.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          droppedFiles.push(e.dataTransfer.files[i]);
        }
        showToast(`Dodana priponka za AFNARIJO: ${e.dataTransfer.files[0].name}`, 'success');
      }
    });

    composeBox.addEventListener('click', () => {
      setTimeout(() => {
        const currentSender = detectGmailFromAddress(composeBox);
        if (currentSender) {
          btn.title = `Pošlji e-pošto neposredno prek Neoserv SMTP kot ${currentSender}`;
        }
      }, 300);
    });

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await handleSend(composeBox, btn, droppedFiles);
    });

    // Vstavi ZA celotno Googlovo skupino
    if (sendSplitGroup.nextSibling) {
      sendSplitGroup.parentNode.insertBefore(btn, sendSplitGroup.nextSibling);
    } else {
      sendSplitGroup.parentNode.appendChild(btn);
    }
  }

  async function handleSend(composeBox, sendBtn, droppedFiles) {
    const originalHtml = sendBtn.innerHTML;

    // Preveri veljavnost povezave z razširitvijo
    if (!isExtensionValid()) {
      showToast('Razširitev je bila ponovno naložena v ozadju. Prosimo, osvežite zavihek z Gmailom (F5) in poskusite znova.', 'error');
      return;
    }

    const senderAddress = detectGmailFromAddress(composeBox);
    if (!senderAddress) {
      showToast('Najprej v nastavitvah razširitve (ikona zgoraj) vpišite vaš e-poštni naslov in API žeton.', 'error');
      return;
    }

    const recipients = extractRecipients(composeBox);
    if (!recipients.to.length && !recipients.cc.length && !recipients.bcc.length) {
      showToast('Vpišite vsaj enega prejemnika (Za / To).', 'error');
      return;
    }

    const subject = extractSubject(composeBox);
    const { htmlBody, plainBody } = extractBody(composeBox);

    try {
      sendBtn.disabled = true;
      sendBtn.innerHTML = `
        <div class="afnarija-spinner"></div>
        <span class="afnarija-btn-text">Pošiljam (${senderAddress.split('@')[0]})...</span>
      `;

      const attachments = [];
      for (const file of droppedFiles) {
        const buffer = await readFileAsArrayBuffer(file);
        attachments.push({
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          data: arrayBufferToBase64(buffer)
        });
      }

      const mimeString = buildRfcMimeMessage({
        senderAddress: senderAddress,
        to: recipients.to,
        cc: recipients.cc,
        bcc: recipients.bcc,
        subject: subject,
        htmlBody: htmlBody,
        plainBody: plainBody,
        attachments: attachments
      });

      const rawBytes = new TextEncoder().encode(mimeString);
      const rawMimeSha256 = await computeSha256Hex(rawBytes);
      const rawMimeB64Url = bytesToBase64Url(rawBytes);

      const requestId = 'ext-' + Date.now() + '-' + Math.random().toString(36).substr(2, 8);
      const draftId = getDraftId(composeBox) || ('draft-' + Date.now());

      chrome.runtime.sendMessage({
        action: 'SEND_MAIL',
        requestId: requestId,
        draftId: draftId,
        senderAddress: senderAddress,
        rawMimeB64Url: rawMimeB64Url,
        rawMimeSha256: rawMimeSha256
      }, (response) => {
        sendBtn.disabled = false;
        sendBtn.innerHTML = originalHtml;

        if (chrome.runtime.lastError || !response || !response.ok) {
          const errMsg = (response && response.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Neznana napaka pri komunikaciji z Gatewayem';
          showToast(`Napaka pri pošiljanju: ${errMsg}`, 'error');
          return;
        }

        // Uspešno poslano!
        if (response.archiveResult && response.archiveResult.ok) {
          showToast(`✓ E-pošta uspešno poslana in shranjena v Poslano (${senderAddress})!`, 'success');
        } else {
          showToast(`✓ E-pošta uspešno poslana kot ${senderAddress}!`, 'success');
        }

        // Samodejno zapri in počisti Gmailov osnutek
        discardGmailDraft(composeBox);
      });

    } catch (err) {
      sendBtn.disabled = false;
      sendBtn.innerHTML = originalHtml;
      if (String(err).includes('Extension context invalidated') || String(err).includes('undefined')) {
        showToast('Razširitev je bila osvežena. Pritisnite tipko F5 (osvežite zavihek z Gmailom) in poskusite znova.', 'error');
      } else {
        showToast(`Napaka: ${err.message || String(err)}`, 'error');
      }
    }
  }

  function extractRecipients(composeBox) {
    return {
      to: extractAddresses(composeBox, 'to'),
      cc: extractAddresses(composeBox, 'cc'),
      bcc: extractAddresses(composeBox, 'bcc')
    };
  }

  function extractAddresses(container, fieldName) {
    const emails = new Set();
    const fieldElem = container.querySelector(`div[name="${fieldName}"], tr[name="${fieldName}"], td[name="${fieldName}"]`) || container;

    fieldElem.querySelectorAll('[email]').forEach(el => {
      const email = el.getAttribute('email');
      if (isValidEmail(email)) emails.add(email.trim().toLowerCase());
    });

    fieldElem.querySelectorAll('[data-hovercard-id]').forEach(el => {
      const email = el.getAttribute('data-hovercard-id');
      if (isValidEmail(email)) emails.add(email.trim().toLowerCase());
    });

    fieldElem.querySelectorAll(`input[name="${fieldName}"]`).forEach(input => {
      const matches = (input.value || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
      if (matches) matches.forEach(m => emails.add(m.trim().toLowerCase()));
    });

    fieldElem.querySelectorAll('.vR, .vN').forEach(chip => {
      const matches = (chip.innerText || chip.textContent || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
      if (matches) matches.forEach(m => emails.add(m.trim().toLowerCase()));
    });

    return Array.from(emails);
  }

  function extractSubject(composeBox) {
    const input = composeBox.querySelector('input[name="subjectbox"], input[name="subject"]');
    return input ? input.value : '';
  }

  function extractBody(composeBox) {
    const textbox = composeBox.querySelector('div[role="textbox"]');
    if (!textbox) return { htmlBody: '', plainBody: '' };
    return {
      htmlBody: textbox.innerHTML || '',
      plainBody: textbox.innerText || textbox.textContent || ''
    };
  }

  function getDraftId(composeBox) {
    const input = composeBox.querySelector('input[name="draft"]');
    if (input && input.value) return input.value;
    return composeBox.getAttribute('data-draft-id') || null;
  }

  function buildRfcMimeMessage(data) {
    const boundaryMixed = '----=_Part_Mixed_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
    const boundaryAlt = '----=_Part_Alt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);

    const senderName = getSenderDisplayName(data.senderAddress);
    const fromHeader = `"${senderName}" <${data.senderAddress}>`;
    const toHeader = data.to.join(', ');
    const ccHeader = data.cc.join(', ');
    const bccHeader = data.bcc.join(', ');
    const subjectHeader = encodeRfc2047(data.subject || '(brez zadeve)');
    const dateHeader = new Date().toUTCString();
    const messageId = `<${Date.now()}.${Math.random().toString(36).substr(2, 9)}@tvoja-domena.si>`;

    let mime = '';
    mime += `From: ${fromHeader}\r\n`;
    if (toHeader) mime += `To: ${toHeader}\r\n`;
    if (ccHeader) mime += `Cc: ${ccHeader}\r\n`;
    if (bccHeader) mime += `Bcc: ${bccHeader}\r\n`;
    mime += `Subject: ${subjectHeader}\r\n`;
    mime += `Date: ${dateHeader}\r\n`;
    mime += `Message-ID: ${messageId}\r\n`;
    mime += `MIME-Version: 1.0\r\n`;

    const hasAttachments = data.attachments && data.attachments.length > 0;

    if (hasAttachments) {
      mime += `Content-Type: multipart/mixed; boundary="${boundaryMixed}"\r\n\r\n`;
      mime += `--${boundaryMixed}\r\n`;
    }

    mime += `Content-Type: multipart/alternative; boundary="${boundaryAlt}"\r\n\r\n`;

    mime += `--${boundaryAlt}\r\n`;
    mime += `Content-Type: text/plain; charset=UTF-8; format=flowed\r\n`;
    mime += `Content-Transfer-Encoding: base64\r\n\r\n`;
    mime += wrapBase64(utf8ToBase64(data.plainBody || '')) + '\r\n\r\n';

    mime += `--${boundaryAlt}\r\n`;
    mime += `Content-Type: text/html; charset=UTF-8\r\n`;
    mime += `Content-Transfer-Encoding: base64\r\n\r\n`;
    mime += wrapBase64(utf8ToBase64(data.htmlBody || '')) + '\r\n\r\n';

    mime += `--${boundaryAlt}--\r\n`;

    if (hasAttachments) {
      for (const att of data.attachments) {
        mime += `\r\n--${boundaryMixed}\r\n`;
        mime += `Content-Type: ${att.mimeType}; name="${encodeRfc2047(att.filename)}"\r\n`;
        mime += `Content-Disposition: attachment; filename="${encodeRfc2047(att.filename)}"\r\n`;
        mime += `Content-Transfer-Encoding: base64\r\n\r\n`;
        mime += wrapBase64(att.data) + '\r\n';
      }
      mime += `\r\n--${boundaryMixed}--\r\n`;
    }

    return mime;
  }

  function getSenderDisplayName(email) {
    const raw = email.split('@')[0].replace(/\./g, ' ');
    return raw.replace(/\b\w/g, l => l.toUpperCase());
  }

  function encodeRfc2047(text) {
    if (!text) return '';
    if (/^[\x20-\x7E]*$/.test(text)) return text;
    return '=?UTF-8?B?' + utf8ToBase64(text) + '?=';
  }

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function wrapBase64(b64) {
    return b64.replace(/(.{76})/g, '$1\r\n');
  }

  function bytesToBase64Url(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const b64 = btoa(binary);
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function computeSha256Hex(bytes) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  }

  function isValidEmail(email) {
    return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  }

  function escapeHtml(text) {
    return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function discardGmailDraft(composeBox) {
    const discardBtn = composeBox.querySelector(
      'div[role="button"][data-tooltip*="Discard"], ' +
      'div[role="button"][data-tooltip*="Zavrzi"], ' +
      'div[aria-label*="Discard"], ' +
      'div[aria-label*="Zavrzi"], ' +
      '.og.T-I-J3'
    );

    if (discardBtn) {
      setTimeout(() => { discardBtn.click(); }, 600);
    } else {
      const closeBtn = composeBox.querySelector('img[aria-label*="Save & close"], img[aria-label*="Shrani in zapri"], img[aria-label*="Close"]');
      if (closeBtn) closeBtn.click();
    }
  }

  function showToast(message, type = 'success') {
    const existing = document.querySelector('.afnarija-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `afnarija-toast ${type}`;
    toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.4s ease';
      setTimeout(() => toast.remove(), 400);
    }, 4500);
  }

  const observer = new MutationObserver(() => {
    scanAndInjectComposeWindows();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  scanAndInjectComposeWindows();

})();
