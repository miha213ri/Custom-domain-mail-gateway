/**
 * Custom Domain Mail – Background Service Worker (v1.4)
 * Zanesljivo pošiljanje prek X-Mail Gateway-TOKEN in /api/v5/send
 */

importScripts('config.js');

const DEFAULT_GATEWAY_URL = 'https://gateway.tvoja-domena.si';

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['gatewayUrl', 'apiToken', 'userEmails'], (res) => {
    const updates = {};
    if (!res.gatewayUrl) {
      updates.gatewayUrl = (typeof Mail Gateway_CONFIG !== 'undefined' && Mail Gateway_CONFIG.gatewayUrl) || DEFAULT_GATEWAY_URL;
    }
    if (!res.apiToken && typeof Mail Gateway_CONFIG !== 'undefined' && Mail Gateway_CONFIG.apiToken) {
      updates.apiToken = Mail Gateway_CONFIG.apiToken;
    }
    if (!res.userEmails && typeof Mail Gateway_CONFIG !== 'undefined' && Mail Gateway_CONFIG.allowedSenders) {
      updates.userEmails = Mail Gateway_CONFIG.allowedSenders;
    }
    if (Object.keys(updates).length > 0) {
      chrome.storage.local.set(updates);
    }
  });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'CHECK_HEALTH') {
    handleCheckHealth(request, sendResponse);
    return true;
  }

  if (request.action === 'SEND_MAIL') {
    handleSendMail(request, sendResponse);
    return true;
  }
});

async function handleCheckHealth(request, sendResponse) {
  try {
    const { gatewayUrl } = await chrome.storage.local.get(['gatewayUrl']);
    const baseUrl = (gatewayUrl || DEFAULT_GATEWAY_URL).replace(/\/+$/, '');
    const res = await fetch(`${baseUrl}/health`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    const data = await res.json();
    sendResponse({ ok: res.ok, status: res.status, data });
  } catch (err) {
    sendResponse({ ok: false, error: err.message || 'Povezava z Gatewayem ni uspela' });
  }
}

async function handleSendMail(request, sendResponse) {
  try {
    const storage = await chrome.storage.local.get(['gatewayUrl', 'apiToken']);
    const apiToken = (storage.apiToken || '').trim();

    if (!apiToken) {
      sendResponse({
        ok: false,
        error: 'API žeton ni nastavljen. Kliknite na ikono razširitve in vnesite žeton iz datoteke config.ini.'
      });
      return;
    }

    const sender = (request.senderAddress || '').trim().toLowerCase();
    if (!sender) {
      sendResponse({
        ok: false,
        error: 'Pošiljateljski naslov ni določen.'
      });
      return;
    }

    const baseUrl = (storage.gatewayUrl || DEFAULT_GATEWAY_URL).replace(/\/+$/, '');
    const sendEndpoint = `${baseUrl}/api/v5/send`;

    const payload = {
      request_id: request.requestId || ('ext-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9)),
      draft_id: request.draftId || ('draft-' + Date.now()),
      confirm_send: true,
      sender_address: sender,
      raw_mime_b64url: request.rawMimeB64Url,
      raw_mime_sha256: request.rawMimeSha256
    };

    const response = await fetch(sendEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mail Gateway-TOKEN': apiToken
      },
      body: JSON.stringify(payload)
    });

    const status = response.status;
    let data;
    try {
      data = await response.json();
    } catch (parseError) {
      sendResponse({
        ok: false,
        status: status,
        error: `Gateway je vrnil neveljaven odziv (HTTP ${status}).`
      });
      return;
    }

    if (response.ok && data.ok === true && data.smtp_accepted === true) {
      // Opcija A: Avtomatski vpis v Gmail Poslano prek Apps Script Web App
      let archiveResult = null;
      try {
        const { archiveWebhookUrl } = await chrome.storage.local.get(['archiveWebhookUrl']);
        const hookUrl = (archiveWebhookUrl || '').trim();
        if (hookUrl && hookUrl.startsWith('https://script.google.com/')) {
          const arcRes = await fetch(hookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              raw: request.rawMimeB64Url,
              draft_id: request.draftId || '',
              sender: sender,
              sha256: request.rawMimeSha256
            })
          });
          archiveResult = await arcRes.json();
        }
      } catch (arcErr) {
        console.warn('Opozorilo pri shranjevanju v Poslano:', arcErr);
      }

      sendResponse({
        ok: true,
        status: status,
        data: data,
        archiveResult: archiveResult
      });
    } else {
      sendResponse({
        ok: false,
        status: status,
        error: data.error || `Napaka strežnika (HTTP ${status})`,
        data: data
      });
    }
  } catch (err) {
    sendResponse({
      ok: false,
      error: 'Napaka omrežja pri klicu Gatewaya: ' + (err.message || String(err))
    });
  }
}
