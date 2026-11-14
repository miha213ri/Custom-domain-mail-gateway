/**
 * Web App sprejemnik za AFNARIJA Mail brskalniško razširitev TOLE JE ZA EXTENSIONS
 */
function doPost(e) {
  try {
    const rawPost = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    const payload = JSON.parse(rawPost);
    const raw = payload.raw || payload.raw_mime_b64url || '';
    const draftId = payload.draft_id || '';
    const sender = payload.sender || payload.sender_address || '';
    const sha256 = payload.sha256 || payload.raw_mime_sha256 || '';
    if (!raw) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'Manjka raw MIME' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    const archiveResult = archiveSentCopyAndDeleteDraft_(draftId, raw, sender, sha256);
    return ContentService.createTextOutput(JSON.stringify({ ok: true, result: archiveResult }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, service: 'AFNARIJA Poslano Sync' }))
    .setMimeType(ContentService.MimeType.JSON);
}


/**
 * AFNARIJA Mail – Gmail Add-on v21 (per-user sender profiles + Sent archive recovery)
 * Keeps the v16 send/archive workflow, reduces one Gmail API round-trip for
 * the normal single-draft case, and reports safe stage timings to the user.
 */

const AFNARIJA_DEFAULT_SENDER = 'uporabnik1@tvoja-domena.si';
const AFNARIJA_SENDERS = [
  'uporabnik1@tvoja-domena.si',
  'uporabnik2@tvoja-domena.si',
  'info@tvoja-domena.si',
];
const AFNARIJA_MAX_DRAFTS_TO_CHECK = 30;
const AFNARIJA_GATEWAY_URL = 'https://gateway.tvoja-domena.si/api/v4/preview';
const AFNARIJA_GATEWAY_TOKEN_PROPERTY = 'AFNARIJA_GATEWAY_TOKEN';
const AFNARIJA_GATEWAY_SEND_URL = 'https://gateway.tvoja-domena.si/api/v5/send';
const AFNARIJA_PILOT_SENDER = 'uporabnik1@tvoja-domena.si';
const AFNARIJA_PILOT_RECIPIENT = 'prejemnik@primer.si';
const AFNARIJA_USER_SENDERS_KEY = 'AFNARIJA_USER_SENDERS_V1';
const AFNARIJA_LAST_SENDER_KEY = 'AFNARIJA_LAST_SENDER_V1';
const AFNARIJA_NO_SECOND_SENDER = '__none__';
const AFNARIJA_CHOOSE_SENDER = '__choose__';

function onHomepage(e) {
  return buildHomeCard_(e || {});
}

function onGmailMessage(e) {
  return buildHomeCard_(e || {});
}

function onCompose(e) {
  return buildHomeCard_(e || {});
}

function buildHomeCard_(e) {
  const event = e || {};
  const gmail = event.gmail || {};
  const selectedSender = getSelectedSenderFromEvent_(event);
  const to = Array.isArray(gmail.toRecipients) ? gmail.toRecipients : [];
  const cc = Array.isArray(gmail.ccRecipients) ? gmail.ccRecipients : [];
  const bcc = Array.isArray(gmail.bccRecipients) ? gmail.bccRecipients : [];
  const subject = gmail.subject || '';

  const card = CardService.newCardBuilder();
  card.setHeader(CardService.newCardHeader()
    .setTitle('AFNARIJA Mail')
    .setSubtitle('Pošiljanje prek lastne domene'));

  const section = CardService.newCardSection();

  // Spustni seznam za izbiro pošiljateljskega naslova med vsemi 9 računi
  const senderInput = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setTitle('Pošlji kot (izberi naslov)')
    .setFieldName('afnarijaSender');
  AFNARIJA_SENDERS.forEach(function (address) {
    senderInput.addItem(address, address, address === selectedSender);
  });
  section.addWidget(senderInput);

  section
    .addWidget(CardService.newTextParagraph().setText(
      '<b>Zadeva:</b> ' + escapeHtml_(subject || '(še ni vpisana)')))
    .addWidget(CardService.newTextParagraph().setText(
      '<b>Za:</b> ' + escapeHtml_(to.join(', ') || '(ni posredovano)')))
    .addWidget(CardService.newTextParagraph().setText(
      '<b>Kp:</b> ' + escapeHtml_(cc.join(', ') || '(ni posredovano)')))
    .addWidget(CardService.newTextParagraph().setText(
      '<b>Skp:</b> ' + escapeHtml_(bcc.join(', ') || '(ni posredovano)')))
    .addWidget(CardService.newTextButton()
      .setText('POŠLJI PREK AFNARIJE')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setOnClickAction(CardService.newAction()
        .setFunctionName('sendCurrentComposeViaAfnarija')
        .setLoadIndicator(CardService.LoadIndicator.SPINNER)))
    .addWidget(CardService.newTextParagraph().setText(
      'En klik: sistem samodejno poišče osnutek, preveri vsebino in SHA-256, pošlje prek SMTP ter shrani kopijo v Gmail Poslano.'))
    .addWidget(CardService.newTextParagraph().setText(
      '<b>Status:</b> Povezano z zalednim Gateway strežnikom za vašo domeno.'));

  card.addSection(section);
  return card.build();
}

/** Build the one-time profile setup card for the current Gmail user. */
function buildSenderSetupCard_(e) {
  const saved = getUserSenderProfile_();
  const firstValue = saved[0] || AFNARIJA_CHOOSE_SENDER;
  const secondValue = saved[1] || AFNARIJA_NO_SECOND_SENDER;

  const first = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setTitle('Moj pošiljateljski naslov')
    .setFieldName('afnarijaSenderPrimary');
  first.addItem('— Izberi svoj naslov —', AFNARIJA_CHOOSE_SENDER,
    firstValue === AFNARIJA_CHOOSE_SENDER);
  AFNARIJA_SENDERS.forEach(function(address) {
    first.addItem(address, address, address === firstValue);
  });

  const second = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setTitle('Drugi naslov (neobvezno)')
    .setFieldName('afnarijaSenderSecondary');
  second.addItem('Nimam drugega naslova', AFNARIJA_NO_SECOND_SENDER,
    secondValue === AFNARIJA_NO_SECOND_SENDER);
  AFNARIJA_SENDERS.forEach(function(address) {
    second.addItem(address, address, address === secondValue);
  });

  const card = CardService.newCardBuilder();
  card.setHeader(CardService.newCardHeader()
    .setTitle('AFNARIJA Mail – nastavitev uporabnika')
    .setSubtitle('To nastavitev opraviš samo enkrat'));
  card.addSection(CardService.newCardSection()
    .addWidget(CardService.newTextParagraph().setText(
      'Izberi samo naslove AFNARIJE, ki jih uporabljaš. Če imaš en naslov, drugi seznam pusti na »Nimam drugega naslova«.'))
    .addWidget(first)
    .addWidget(second)
    .addWidget(CardService.newTextButton()
      .setText('SHRANI MOJE NASLOVE')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setOnClickAction(CardService.newAction()
        .setFunctionName('saveMySenderProfile')
        .setLoadIndicator(CardService.LoadIndicator.SPINNER))));
  if (saved.length) {
    card.addSection(CardService.newCardSection()
      .addWidget(CardService.newTextButton()
        .setText('NAZAJ')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('returnToAfnarijaHome'))));
  }
  return card.build();
}

/** Show the per-user sender profile editor. */
function showMySenderSettings(e) {
  return buildSenderSetupCard_(e || {});
}

/** Return from sender settings to the current Gmail compose card. */
function returnToAfnarijaHome(e) {
  return buildHomeCard_(e || {});
}

/** Save one or two sender identities only for the current Gmail user. */
function saveMySenderProfile(e) {
  const primary = getEventInputValue_(e, 'afnarijaSenderPrimary');
  const secondary = getEventInputValue_(e, 'afnarijaSenderSecondary') || AFNARIJA_NO_SECOND_SENDER;

  if (!primary || primary === AFNARIJA_CHOOSE_SENDER || AFNARIJA_SENDERS.indexOf(primary) === -1) {
    return messageCard_('Izberi glavni naslov', 'Najprej izberi svoj glavni naslov AFNARIJE.');
  }
  if (secondary !== AFNARIJA_NO_SECOND_SENDER && AFNARIJA_SENDERS.indexOf(secondary) === -1) {
    return messageCard_('Drugi naslov ni veljaven', 'Izberi drugi naslov s seznama ali možnost »Nimam drugega naslova«.');
  }
  if (secondary === primary) {
    return messageCard_('Podvojen naslov', 'Glavni in drugi naslov morata biti različna.');
  }

  const profile = secondary === AFNARIJA_NO_SECOND_SENDER
    ? [primary]
    : [primary, secondary];
  const props = PropertiesService.getUserProperties();
  props.setProperty(AFNARIJA_USER_SENDERS_KEY, JSON.stringify(profile));
  props.setProperty(AFNARIJA_LAST_SENDER_KEY, primary);

  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(buildHomeCard_(e || {})))
    .setNotification(CardService.newNotification()
      .setText(profile.length === 1
        ? 'AFNARIJA: naslov je shranjen. Izbirnika pri pošiljanju ne bo.'
        : 'AFNARIJA: oba pošiljateljska naslova sta shranjena.'))
    .build();
}

/** Return the one/two sender addresses assigned to this Gmail user. */
function getUserSenderProfile_() {
  const raw = PropertiesService.getUserProperties().getProperty(AFNARIJA_USER_SENDERS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const unique = [];
    parsed.forEach(function(value) {
      const address = String(value || '').trim().toLowerCase();
      if (AFNARIJA_SENDERS.indexOf(address) !== -1 && unique.indexOf(address) === -1) {
        unique.push(address);
      }
    });
    return unique.slice(0, 2);
  } catch (err) {
    return [];
  }
}

/** Read a CardService dropdown value from a user interaction event. */
function getEventInputValue_(e, fieldName) {
  const event = e || {};
  const common = event.commonEventObject || {};
  const formInputs = common.formInputs || {};
  const field = formInputs[fieldName];
  if (field && field.stringInputs && Array.isArray(field.stringInputs.value) &&
      field.stringInputs.value.length) {
    return String(field.stringInputs.value[0] || '').trim().toLowerCase();
  }
  if (event.formInput && event.formInput[fieldName] !== undefined) {
    return String(event.formInput[fieldName] || '').trim().toLowerCase();
  }
  return '';
}

/**
 * One-click workflow: locate exactly one current draft, verify it, send it via
 * the Neoserv SMTP Gateway, then archive a SENT copy in this Gmail mailbox and
 * delete the original Gmail draft. The Gateway remains the only SMTP sender.
 */
function sendCurrentComposeViaAfnarija(e) {
  const startedAt = Date.now();
  const timings = {};
  try {
    const event = e || {};
    const gmail = event.gmail || {};
    const senderAddress = getSelectedSenderFromEvent_(event);
    if (!senderAddress || AFNARIJA_SENDERS.indexOf(senderAddress) === -1) {
      return messageCard_('Neveljaven pošiljatelj',
        'Izbrani naslov ni na seznamu dovoljenih naslovov AFNARIJE.');
    }
    PropertiesService.getUserProperties().setProperty(AFNARIJA_LAST_SENDER_KEY, senderAddress);
    const currentTo = normalizeEmails_(gmail.toRecipients || []);
    const currentCc = normalizeEmails_(gmail.ccRecipients || []);
    const currentBcc = normalizeEmails_(gmail.bccRecipients || []);
    const currentSubject = normalizeSubject_(gmail.subject || '');

    if (!currentTo.length && !currentCc.length && !currentBcc.length) {
      return messageCard_('Manjkajo prejemniki',
        'V Gmailovem osnutku najprej vnesi vsaj enega prejemnika.');
    }
    if (AFNARIJA_SENDERS.indexOf(senderAddress) === -1) {
      return messageCard_('Neveljaven pošiljatelj',
        'Izbrani naslov ni na seznamu dovoljenih naslovov AFNARIJE.');
    }
    const allRecipients = currentTo.concat(currentCc, currentBcc);
    if (!allRecipients.length) {
      return messageCard_('Manjkajo prejemniki',
        'V Gmailovem osnutku najprej vnesi vsaj enega prejemnika.');
    }

    let stageAt = Date.now();
    const candidates = findExactDraftCandidates_(currentTo, currentCc, currentBcc, currentSubject);
    timings.draft_lookup_ms = Date.now() - stageAt;
    if (!candidates.length) {
      return messageCard_('Osnutka ni bilo mogoče enolično najti',
        'Gmail ni našel osnutka z enakimi prejemniki in zadevo. Počakaj, da Gmail shrani osnutek, nato poskusi znova.');
    }
    if (candidates.length > 1) {
      const descriptions = candidates.slice(0, 5).map(function(item, index) {
        return (index + 1) + '. ' + escapeHtml_(item.subject || '(brez zadeve)') +
          ' — ' + escapeHtml_(item.date || 'datum ni naveden');
      }).join('<br>');
      return messageCard_('Najdenih je več enakih osnutkov',
        descriptions + '<br><br>Za varnost nisem izbral nobenega. V Gmailu odstrani podvojene osnutke in poskusi znova.');
    }

    const draftId = candidates[0].id;
    stageAt = Date.now();
    const draft = getDraftRawViaRest_(draftId);
    timings.raw_mime_fetch_ms = Date.now() - stageAt;
    const raw = draft && draft.message && typeof draft.message.raw === 'string'
      ? draft.message.raw : '';
    if (!raw) {
      return messageCard_('RAW MIME ni na voljo',
        'Gmail ni vrnil vsebine osnutka. Sporočilo ni bilo poslano.');
    }
    const rawBytes = decodeGmailRaw_(raw);
    if (!rawBytes || !rawBytes.length) {
      return messageCard_('RAW MIME je prazen',
        'Vsebina osnutka po dekodiranju ni na voljo. Sporočilo ni bilo poslano.');
    }
    stageAt = Date.now();
    const rawSha256 = sha256Hex_(rawBytes);
    const headerBlock = Utilities.newBlob(rawBytes).getDataAsString('UTF-8').split(/\r?\n\r?\n/)[0] || '';
    const headers = parseRawHeaders_(headerBlock);
    const fromAddresses = normalizeEmails_(splitAddressHeader_(headers.from || ''));
    const rawTo = normalizeEmails_(splitAddressHeader_(headers.to || ''));
    const rawCc = normalizeEmails_(splitAddressHeader_(headers.cc || ''));
    const rawBcc = normalizeEmails_(splitAddressHeader_(headers.bcc || ''));

    if (fromAddresses.length !== 1 || fromAddresses[0] !== senderAddress) {
      return messageCard_('Naslov pošiljatelja se ne ujema',
        'From v Gmailovem osnutku ni enak izbranemu naslovu. Sporočilo ni bilo poslano.');
    }
    if (!arraysEqual_(currentTo, rawTo) || !arraysEqual_(currentCc, rawCc) ||
        !arraysEqual_(currentBcc, rawBcc)) {
      return messageCard_('Osnutek se je med branjem spremenil',
        'Prejemniki v osnutku se ne ujemajo s podatki odprtega Gmailovega okna. Sporočilo ni bilo poslano.');
    }
    if (currentSubject && normalizeSubject_(decodeMimeHeader_(headers.subject || '')) !== currentSubject) {
      return messageCard_('Zadeva se ne ujema',
        'Zadeva osnutka se ne ujema s trenutno odprtim Gmailovim oknom. Sporočilo ni bilo poslano.');
    }

    timings.mime_decode_and_validation_ms = Date.now() - stageAt;
    const apiToken = PropertiesService.getScriptProperties()
      .getProperty(AFNARIJA_GATEWAY_TOKEN_PROPERTY);
    if (!apiToken || apiToken.length < 32) {
      return messageCard_('Gateway token ni nastavljen',
        'Preveri Script Properties: AFNARIJA_GATEWAY_TOKEN.');
    }

    const requestId = Utilities.getUuid();
    const payload = {
      request_id: requestId,
      draft_id: draftId,
      confirm_send: true,
      sender_address: senderAddress,
      raw_mime_b64url: raw,
      raw_mime_sha256: rawSha256
    };
    stageAt = Date.now();
    const sendResponse = UrlFetchApp.fetch(AFNARIJA_GATEWAY_SEND_URL, {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      headers: { 'X-AFNARIJA-TOKEN': apiToken },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    timings.gateway_smtp_ms = Date.now() - stageAt;
    const sendStatus = sendResponse.getResponseCode();
    let sendResult;
    try {
      sendResult = JSON.parse(sendResponse.getContentText());
    } catch (parseError) {
      return messageCard_('Nepričakovan odgovor Gatewaya',
        'HTTP ' + sendStatus + '. Pred ponovnim poskusom preveri prejemnikov predal; sporočila ne pošiljaj znova na slepo.');
    }

    let wasAlreadyAccepted = false;
    if (sendStatus === 409 && sendResult.prior_status === 'SMTP_ACCEPTED') {
      // This exact draft version was already sent by the earlier v15 pilot.
      // Do not send again; only complete Gmail Sent archiving and draft cleanup.
      wasAlreadyAccepted = true;
    } else if (!(sendStatus >= 200 && sendStatus < 300 && sendResult.ok === true &&
                 sendResult.smtp_accepted === true && sendResult.smtp_status === 'SMTP_ACCEPTED')) {
      if (sendResult.smtp_status === 'UNKNOWN') {
        return messageCard_('Izid SMTP pošiljanja ni znan',
          'Ne pošiljaj ponovno. Preveri prejemnikov predal; Gateway je ponovni poskus blokiral.');
      }
      const apiError = sendResult && sendResult.error ? String(sendResult.error) : 'neznana napaka';
      return messageCard_('SMTP pošiljanje ni uspelo',
        '<b>HTTP:</b> ' + sendStatus + '<br><b>Razlog:</b> ' + escapeHtml_(apiError) +
        '<br><br>Osnutek je ostal v Gmailu.');
    }

    // SMTP has definitely accepted the message (or Gateway confirms the same
    // draft version had already been accepted). Now archive it inside Gmail.
    stageAt = Date.now();
    const archiveResult = archiveSentCopyAndDeleteDraft_(draftId, raw, senderAddress, rawSha256);
    timings.gmail_archive_and_cleanup_ms = Date.now() - stageAt;
    timings.total_ms = Date.now() - startedAt;
    console.log('[AFNARIJA_TIMING] ' + JSON.stringify(timings));
    const card = CardService.newCardBuilder();
    card.setHeader(CardService.newCardHeader()
      .setTitle(archiveResult.complete
        ? 'AFNARIJA – sporočilo poslano in arhivirano'
        : 'AFNARIJA – sporočilo je poslano')
      .setSubtitle(wasAlreadyAccepted
        ? 'Prejšnji SMTP sprejem potrjen; ponovno pošiljanje je bilo preprečeno'
        : 'Neoserv SMTP je sprejel sporočilo'));
    const section = CardService.newCardSection()
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Od:</b> ' + escapeHtml_(senderAddress)))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Za:</b> ' + escapeHtml_(allRecipients.join(', '))))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Zadeva:</b> ' + escapeHtml_(decodeMimeHeader_(headers.subject || '(brez zadeve)'))))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Velikost MIME:</b> ' + rawBytes.length + ' B'))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>SHA-256:</b> ' + escapeHtml_(rawSha256.slice(0, 16)) + '…'))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Čas postopka:</b> ' + (timings.total_ms / 1000).toFixed(1) + ' s'))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Razčlenitev:</b> osnutek ' + (timings.draft_lookup_ms / 1000).toFixed(1) + ' s; MIME ' +
        (timings.raw_mime_fetch_ms / 1000).toFixed(1) + ' s; Gateway/SMTP ' +
        (timings.gateway_smtp_ms / 1000).toFixed(1) + ' s; Gmail Poslano ' +
        (timings.gmail_archive_and_cleanup_ms / 1000).toFixed(1) + ' s.'));
    if (archiveResult.complete) {
      section.addWidget(CardService.newTextParagraph().setText(
        '<font color="#137333"><b>✅ USPEŠNO POSLANO IN ARHIVIRANO V POSLANO!</b></font>'));
      section.addWidget(CardService.newTextParagraph().setText(
        'Kopija sporočila je že shranjena v mapi <b>Poslano</b>, strežniški osnutek pa je bil odstranjen.'));
      section.addWidget(CardService.newTextParagraph().setText(
        '<b>Kako zapreti to okno:</b> Ker Gmailov vmesnik dodatkom (Add-onom) varnostno ne dovoljuje programskega zapiranja oken, to okno enostavno <b>zaprite s klikom na ❌ (zgoraj desno) ali z ikono koša 🗑️ (spodaj desno)</b>.'));
      section.addWidget(CardService.newTextParagraph().setText(
        '<b>Opozorilo:</b> Modrega Googlovega gumba »Pošlji« NE klikajte, saj je e-pošta že bila poslana prek AFNARIJE.'));
      section.addWidget(CardService.newTextParagraph().setText(
        '<b>Request ID:</b> ' + escapeHtml_(sendResult.request_id || requestId)));
    } else {
      section.addWidget(CardService.newTextParagraph().setText(
        '<b>Gmail arhiviranje:</b> ' + escapeHtml_(archiveResult.message)));
      section.addWidget(CardService.newTextParagraph().setText(
        'SMTP je sporočilo že sprejel. Ne pošiljaj nove kopije.'));
      if (archiveResult.retryable) {
        section.addWidget(CardService.newTextButton()
          .setText('PONOVI SAMO SHRANJEVANJE V POSLANO')
          .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
          .setOnClickAction(CardService.newAction()
            .setFunctionName('retryGmailSentArchiveOnly')
            .setParameters({
              draftId: draftId,
              senderAddress: senderAddress,
              rawSha256: rawSha256
            })
            .setLoadIndicator(CardService.LoadIndicator.SPINNER)));
      }
    }
    card.addSection(section);

    // Keep the user in the same Gmail window. Update only the current add-on
    // card and notify Gmail that mailbox state changed so it can invalidate
    // cached state in affected contexts. This does not open another tab.
    return CardService.newActionResponseBuilder()
      .setNavigation(CardService.newNavigation().updateCard(card.build()))
      .setStateChanged(true)
      .setNotification(CardService.newNotification()
        .setText('AFNARIJA: sporočilo je poslano in shranjeno v Poslano.'))
      .build();
  } catch (err) {
    return messageCard_('Napaka pri pošiljanju prek AFNARIJE',
      escapeHtml_(String(err && err.message ? err.message : err)) +
      '<br><br>Pred ponovnim poskusom preveri, ali je SMTP že sprejel sporočilo.');
  }
}

/** Find exactly matching drafts. Search narrows candidates; exact local
 * comparison remains authoritative. Falls back to an unfiltered first page. */
function findExactDraftCandidates_(currentTo, currentCc, currentBcc, currentSubject) {
  const firstRecipient = currentTo[0] || currentCc[0] || currentBcc[0];
  let listed = null;
  if (firstRecipient) {
    const q = '{to:' + firstRecipient + ' cc:' + firstRecipient + ' bcc:' + firstRecipient + '}' +
      (currentSubject ? ' subject:"' + currentSubject.replace(/[\\"]/g, ' ') + '"' : '');
    try {
      listed = Gmail.Users.Drafts.list('me', {
        maxResults: AFNARIJA_MAX_DRAFTS_TO_CHECK,
        q: q
      });
    } catch (searchError) {
      listed = null;
    }
  }

  let drafts = listed && listed.drafts ? listed.drafts : [];

  // Fast path: when Gmail's query returns exactly one candidate, do not make
  // an extra Drafts.get(format=full) call. The subsequent RAW fetch is checked
  // against all active compose headers before SMTP is called.
  if (drafts.length === 1 && drafts[0].id) {
    return [{ id: drafts[0].id, subject: currentSubject || '', date: '' }];
  }

  const scanDrafts = function(items) {
    const found = [];
    for (let i = 0; i < items.length; i++) {
      const draftId = items[i].id;
      if (!draftId) continue;
      const fullDraft = Gmail.Users.Drafts.get('me', draftId, { format: 'full' });
      const message = fullDraft && fullDraft.message ? fullDraft.message : {};
      const headers = getHeaderMap_(message.payload && message.payload.headers ? message.payload.headers : []);
      const draftTo = normalizeEmails_(splitAddressHeader_(headers.to || ''));
      const draftCc = normalizeEmails_(splitAddressHeader_(headers.cc || ''));
      const draftBcc = normalizeEmails_(splitAddressHeader_(headers.bcc || ''));
      const draftSubject = normalizeSubject_(decodeMimeHeader_(headers.subject || ''));
      if (arraysEqual_(currentTo, draftTo) && arraysEqual_(currentCc, draftCc) &&
          arraysEqual_(currentBcc, draftBcc) && (!currentSubject || currentSubject === draftSubject)) {
        found.push({ id: draftId, subject: headers.subject || '', date: headers.date || '' });
      }
    }
    return found;
  };

  let matches = drafts.length ? scanDrafts(drafts) : [];
  // Fallback for Gmail search-index lag. This is used only when the query did
  // not yield a candidate; the common single-match path above avoids the scan.
  if (!matches.length && listed) {
    const fallback = Gmail.Users.Drafts.list('me', { maxResults: AFNARIJA_MAX_DRAFTS_TO_CHECK });
    const fallbackDrafts = fallback && fallback.drafts ? fallback.drafts : [];
    const alreadyChecked = {};
    drafts.forEach(function(item) { if (item.id) alreadyChecked[item.id] = true; });
    const additional = fallbackDrafts.filter(function(item) { return item.id && !alreadyChecked[item.id]; });
    matches = scanDrafts(additional);
    if (!drafts.length) matches = scanDrafts(fallbackDrafts);
  } else if (!listed) {
    const fallback = Gmail.Users.Drafts.list('me', { maxResults: AFNARIJA_MAX_DRAFTS_TO_CHECK });
    const fallbackDrafts = fallback && fallback.drafts ? fallback.drafts : [];
    matches = scanDrafts(fallbackDrafts);
  }
  return matches;
}

/** After SMTP acceptance, insert the exact RAW MIME into Gmail with SENT label,
 * then delete the original draft. The order prevents losing the draft if the
 * Sent-copy insertion fails. Local state prevents creating duplicate Sent copies. */
function archiveSentCopyAndDeleteDraft_(draftId, raw, senderAddress, rawSha256) {
  const userProps = PropertiesService.getUserProperties();
  const stateKeySeed = draftId + '|' + senderAddress + '|' + rawSha256;
  const stateKey = 'AFNARIJA_SENT_' + sha256Hex_(Utilities.newBlob(stateKeySeed).getBytes());
  let state = {};
  const stateText = userProps.getProperty(stateKey);
  if (stateText) {
    try { state = JSON.parse(stateText); } catch (ignore) { state = {}; }
  }

  // Earlier v20 marked every failed HTTP response as UNKNOWN. A recorded
  // 4xx is not ambiguous: Gmail explicitly rejected the request, so it is safe
  // to retry after correcting the cause (for example gmail.insert authorization).
  const priorHttpStatus = Number(state.httpStatus || 0);
  if (state.stage === 'ARCHIVE_INSERT_UNKNOWN' && priorHttpStatus >= 400 && priorHttpStatus < 500) {
    state.stage = 'ARCHIVE_INSERT_FAILED';
    state.updatedAt = new Date().toISOString();
    userProps.setProperty(stateKey, JSON.stringify(state));
  }

  // A pending request or 5xx/transport-unknown result may already have created
  // a Sent copy. Never blindly insert another copy in that situation.
  if (state.stage === 'ARCHIVE_INSERT_PENDING' || state.stage === 'ARCHIVE_INSERT_UNKNOWN') {
    return {
      complete: false,
      retryable: false,
      message: 'Stanje vstavljanja kopije v Poslano je negotovo. Najprej preveri mapo Poslano; nove kopije ne vstavljam samodejno.'
    };
  }

  // A definite 4xx rejection is safe to retry after correcting the cause
  // (typically missing gmail.insert authorization). Gateway SMTP is NOT called
  // by the archive-only retry action below.
  if (!state.stage || state.stage === 'SMTP_ACCEPTED' || state.stage === 'ARCHIVE_INSERT_FAILED') {
    userProps.setProperty(stateKey, JSON.stringify({
      stage: 'ARCHIVE_INSERT_PENDING', draftId: draftId,
      sender: senderAddress, sha256: rawSha256, updatedAt: new Date().toISOString()
    }));

    const oauth = ScriptApp.getOAuthToken();
    if (!oauth) {
      userProps.setProperty(stateKey, JSON.stringify({
        stage: 'ARCHIVE_INSERT_FAILED', draftId: draftId,
        sender: senderAddress, sha256: rawSha256, httpStatus: 0,
        lastError: 'Apps Script ni pridobil OAuth žetona.', updatedAt: new Date().toISOString()
      }));
      return {
        complete: false,
        retryable: true,
        message: 'Ni OAuth žetona za Gmail arhiviranje. SMTP je že sprejel sporočilo; arhiviranje lahko ponoviš brez ponovnega pošiljanja.'
      };
    }

    const insertResponse = UrlFetchApp.fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?internalDateSource=dateHeader',
      {
        method: 'post',
        contentType: 'application/json; charset=utf-8',
        headers: { Authorization: 'Bearer ' + oauth },
        payload: JSON.stringify({ raw: raw, labelIds: ['SENT'] }),
        muteHttpExceptions: true
      }
    );
    const insertStatus = insertResponse.getResponseCode();
    const responseText = insertResponse.getContentText() || '';
    let inserted = {};
    try { inserted = JSON.parse(responseText); } catch (ignore) { inserted = {}; }

    if (insertStatus < 200 || insertStatus >= 300 || !inserted.id) {
      let apiMessage = '';
      if (inserted && inserted.error) {
        apiMessage = String(inserted.error.message || inserted.error.status || '');
      }
      apiMessage = apiMessage.replace(/[\r\n\t]+/g, ' ').slice(0, 240);

      // HTTP 4xx is an explicit rejection: Gmail says it did not accept this
      // insert. Mark it retryable. 5xx or malformed success is ambiguous.
      const definiteRejection = insertStatus >= 400 && insertStatus < 500;
      userProps.setProperty(stateKey, JSON.stringify({
        stage: definiteRejection ? 'ARCHIVE_INSERT_FAILED' : 'ARCHIVE_INSERT_UNKNOWN',
        draftId: draftId, sender: senderAddress, sha256: rawSha256,
        httpStatus: insertStatus, lastError: apiMessage,
        updatedAt: new Date().toISOString()
      }));
      return {
        complete: false,
        retryable: definiteRejection,
        message: 'SMTP je sporočilo že sprejel, vendar Gmail ni shranil kopije v Poslano (HTTP ' +
          insertStatus + (apiMessage ? ': ' + apiMessage : '') + '). ' +
          (definiteRejection
            ? 'Zahteva je bila zavrnjena; po odpravi dovoljenja lahko ponoviš samo arhiviranje.'
            : 'Izid arhiviranja ni gotov; najprej preveri mapo Poslano. Osnutek je ohranjen.')
      };
    }

    state = {
      stage: 'SENT_COPY_CREATED', draftId: draftId, sha256: rawSha256,
      sentMessageId: inserted.id, updatedAt: new Date().toISOString()
    };
    userProps.setProperty(stateKey, JSON.stringify(state));
  }

  if (state.stage === 'SENT_COPY_CREATED') {
    const oauth = ScriptApp.getOAuthToken();
    if (!oauth) {
      return { complete: false, retryable: true,
        message: 'Kopija je shranjena v Poslano, vendar ni OAuth žetona za odstranitev osnutka.' };
    }
    const deleteResponse = UrlFetchApp.fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/drafts/' + encodeURIComponent(draftId),
      {
        method: 'delete',
        headers: { Authorization: 'Bearer ' + oauth },
        muteHttpExceptions: true
      }
    );
    const deleteStatus = deleteResponse.getResponseCode();
    if (!((deleteStatus >= 200 && deleteStatus < 300) || deleteStatus === 404)) {
      let deleteText = '';
      try {
        const body = JSON.parse(deleteResponse.getContentText() || '{}');
        deleteText = body && body.error && body.error.message ? String(body.error.message) : '';
      } catch (ignore) {}
      deleteText = deleteText.replace(/[\r\n\t]+/g, ' ').slice(0, 180);
      return {
        complete: false,
        retryable: true,
        message: 'Kopija je shranjena v Poslano, vendar izvirnega osnutka ni bilo mogoče odstraniti (HTTP ' +
          deleteStatus + (deleteText ? ': ' + deleteText : '') + ').'
      };
    }
    state.stage = 'COMPLETE';
    state.updatedAt = new Date().toISOString();
    userProps.setProperty(stateKey, JSON.stringify(state));
  }
  return { complete: state.stage === 'COMPLETE', retryable: false,
    message: 'Kopija je shranjena v Poslano, izvirni osnutek je odstranjen.' };
}

/**
 * Retry ONLY the Gmail Sent-copy/archive step for a draft whose SMTP acceptance
 * is already recorded. This function never calls AFNARIJA Gateway or SMTP.
 */
function retryGmailSentArchiveOnly(e) {
  try {
    const params = (e && e.parameters) ? e.parameters : {};
    const draftId = String(params.draftId || '').trim();
    const senderAddress = normalizeSelectedSender_(params.senderAddress || '');
    const expectedSha256 = String(params.rawSha256 || '').trim().toLowerCase();
    if (!draftId || !/^[a-f0-9]{64}$/.test(expectedSha256) ||
        AFNARIJA_SENDERS.indexOf(senderAddress) === -1) {
      return messageCard_('Manjkajo podatki za arhiviranje',
        'Ponovno odpri prvotni rezultat AFNARIJA. Ne pošiljaj novega sporočila.');
    }

    const draft = getDraftRawViaRest_(draftId);
    const raw = draft && draft.message && typeof draft.message.raw === 'string'
      ? draft.message.raw : '';
    if (!raw) {
      return messageCard_('Prvotni osnutek ni več na voljo',
        'Arhiviranje ni bilo ponovljeno. Preveri mapo Poslano in stanje osnutka.');
    }
    const bytes = decodeGmailRaw_(raw);
    const actualSha256 = sha256Hex_(bytes);
    if (actualSha256 !== expectedSha256) {
      return messageCard_('Osnutek se je spremenil',
        'Vsebina ni enaka že sprejeti SMTP različici. Arhiviranje je ustavljeno, da ne ustvarimo napačne kopije.');
    }

    const stateKeySeed = draftId + '|' + senderAddress + '|' + actualSha256;
    const stateKey = 'AFNARIJA_SENT_' + sha256Hex_(Utilities.newBlob(stateKeySeed).getBytes());
    const userProps = PropertiesService.getUserProperties();
    let state = {};
    try { state = JSON.parse(userProps.getProperty(stateKey) || '{}'); } catch (ignore) {}
    const priorHttpStatus = Number(state.httpStatus || 0);
    if (state.stage === 'ARCHIVE_INSERT_UNKNOWN' && priorHttpStatus >= 400 && priorHttpStatus < 500) {
      state.stage = 'ARCHIVE_INSERT_FAILED';
      state.updatedAt = new Date().toISOString();
      userProps.setProperty(stateKey, JSON.stringify(state));
    }
    if (state.stage !== 'ARCHIVE_INSERT_FAILED' && state.stage !== 'SENT_COPY_CREATED') {
      return messageCard_('Arhiviranje ni mogoče varno ponoviti',
        'Stanje arhiviranja ni označeno kot varno ponovljivo. Preveri mapo Poslano; SMTP ne ponavljaj.');
    }

    const result = archiveSentCopyAndDeleteDraft_(draftId, raw, senderAddress, actualSha256);
    const card = CardService.newCardBuilder();
    card.setHeader(CardService.newCardHeader()
      .setTitle(result.complete ? 'AFNARIJA – arhiviranje zaključeno' : 'AFNARIJA – arhiviranje še ni zaključeno')
      .setSubtitle('Brez ponovnega SMTP pošiljanja'));
    card.addSection(CardService.newCardSection()
      .addWidget(CardService.newTextParagraph().setText(escapeHtml_(result.message)))
      .addWidget(CardService.newTextParagraph().setText(
        'SMTP sprejem ostaja potrjen. Ta akcija ni poslala nobenega novega e-sporočila.')));
    return CardService.newActionResponseBuilder()
      .setNavigation(CardService.newNavigation().updateCard(card.build()))
      .setStateChanged(true)
      .setNotification(CardService.newNotification().setText(
        result.complete ? 'AFNARIJA: kopija je shranjena v Poslano.' : 'AFNARIJA: arhiviranje ni zaključeno.'))
      .build();
  } catch (err) {
    return messageCard_('Napaka pri arhiviranju v Gmailu',
      escapeHtml_(String(err && err.message ? err.message : err)) +
      '<br><br>SMTP ne ponavljaj. Najprej preveri mapo Poslano.');
  }
}

/**
 * Lists Gmail drafts through the Gmail API and compares their headers with
 * the recipient/subject metadata supplied by the compose trigger.
 */
function findMatchingDrafts(e) {
  try {
    const gmail = (e && e.gmail) ? e.gmail : {};
    const selectedSender = getSelectedSenderFromEvent_(e || {});
    const currentTo = normalizeEmails_(gmail.toRecipients || []);
    const currentCc = normalizeEmails_(gmail.ccRecipients || []);
    const currentBcc = normalizeEmails_(gmail.bccRecipients || []);
    const currentSubject = normalizeSubject_(gmail.subject || '');

    if (!currentTo.length && !currentCc.length && !currentBcc.length && !currentSubject) {
      return messageCard_('Ni dovolj podatkov',
        'Gmail dodatku ni posredoval prejemnikov ali zadeve. Vpiši vsaj prejemnika in zadevo, počakaj, da Gmail shrani osnutek, nato poskusi znova.');
    }

    // List recent drafts without Gmail search query. This avoids depending on
    // Gmail search indexing; exact recipient/subject comparison is done locally.
    const listArgs = { maxResults: AFNARIJA_MAX_DRAFTS_TO_CHECK };
    const listed = Gmail.Users.Drafts.list('me', listArgs);
    const drafts = (listed && listed.drafts) ? listed.drafts : [];
    if (!drafts.length) {
      return messageCard_('Osnutkov ni bilo mogoče najti',
        'Gmail API ni vrnil osnutkov, ki bi ustrezali osnovnemu iskanju. Preveri, ali je Gmail osnutek že shranjen, in ponovi preizkus.');
    }

    const matches = [];
    for (let i = 0; i < drafts.length; i++) {
      const draftId = drafts[i].id;
      if (!draftId) continue;
      const fullDraft = Gmail.Users.Drafts.get('me', draftId, { format: 'full' });
      const message = fullDraft && fullDraft.message ? fullDraft.message : {};
      const headers = getHeaderMap_(message.payload && message.payload.headers ? message.payload.headers : []);

      const draftTo = normalizeEmails_(splitAddressHeader_(headers.to || ''));
      const draftCc = normalizeEmails_(splitAddressHeader_(headers.cc || ''));
      const draftBcc = normalizeEmails_(splitAddressHeader_(headers.bcc || ''));
      const draftSubject = normalizeSubject_(headers.subject || '');

      const toOk = arraysEqual_(currentTo, draftTo);
      const ccOk = arraysEqual_(currentCc, draftCc);
      const bccOk = arraysEqual_(currentBcc, draftBcc);
      const subjectOk = !currentSubject || currentSubject === draftSubject;

      if (toOk && ccOk && bccOk && subjectOk) {
        matches.push({
          id: draftId,
          messageId: message.id || '',
          subject: headers.subject || '(brez zadeve)',
          to: headers.to || '',
          cc: headers.cc || '',
          bcc: headers.bcc || '',
          date: headers.date || '',
          snippet: message.snippet || ''
        });
      }
    }

    if (!matches.length) {
      return messageCard_('Ujemajočega osnutka še ni',
        'Gmailov seznam osnutkov je dosegljiv, vendar ni osnutka z enakimi prejemniki in zadevo. Možen razlog je zamik samodejnega shranjevanja. Počakaj nekaj sekund in poskusi znova.');
    }

    const card = CardService.newCardBuilder();
    card.setHeader(CardService.newCardHeader()
      .setTitle('Najdeni Gmail osnutki')
      .setSubtitle('Ujemanje po prejemnikih in zadevi – brez pošiljanja'));
    const section = CardService.newCardSection();
    section.addWidget(CardService.newTextParagraph().setText(
      '<b>Število natančnih ujemanj:</b> ' + matches.length));
    section.addWidget(CardService.newTextParagraph().setText(
      'Izberi pravi osnutek. Če jih je več, jih ne bomo samodejno izbrali.'));

    matches.forEach(function (match, index) {
      section.addWidget(CardService.newDivider());
      section.addWidget(CardService.newTextParagraph().setText(
        '<b>Osnutek ' + (index + 1) + '</b><br>' +
        '<b>Zadeva:</b> ' + escapeHtml_(match.subject) + '<br>' +
        '<b>Za:</b> ' + escapeHtml_(match.to || '(prazno)') + '<br>' +
        '<b>Kp:</b> ' + escapeHtml_(match.cc || '(prazno)') + '<br>' +
        '<b>Skp:</b> ' + escapeHtml_(match.bcc || '(prazno)') + '<br>' +
        '<b>Datum:</b> ' + escapeHtml_(match.date || '(ni naveden)')));
      section.addWidget(CardService.newTextButton()
        .setText('Preveri ta osnutek')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('inspectSelectedDraft')
          .setParameters({ draftId: match.id, senderAddress: selectedSender })));
    });
    section.addWidget(CardService.newTextParagraph().setText(
      'V tej različici pregledamo samo vsebino. Pošiljanje in spreminjanje osnutka sta izključena.'));
    card.addSection(section);
    return card.build();
  } catch (err) {
    return messageCard_('Napaka pri branju Gmail osnutkov',
      escapeHtml_(String(err && err.message ? err.message : err)) +
      '<br><br>Preveri, ali je Gmail API v povezanem Google Cloud projektu omogočen in ali si odobril novo dovoljenje gmail.compose.');
  }
}

/**
 * Retrieves the selected DRAFT directly in RAW format through the Gmail REST API.
 * Important: users.drafts.get accepts gmail.compose; users.messages.get does not.
 * This function never sends, edits, or deletes the selected draft.
 */
function inspectSelectedDraft(e) {
  try {
    const params = (e && e.parameters) ? e.parameters : {};
    const draftId = params.draftId;
    const senderAddress = normalizeSelectedSender_(params.senderAddress || AFNARIJA_DEFAULT_SENDER);
    if (!draftId) {
      return messageCard_('Manjka ID osnutka',
        'Vrnite se na seznam osnutkov in izberite osnutek še enkrat.');
    }

    const draft = getDraftRawViaRest_(draftId);
    const raw = draft && draft.message && typeof draft.message.raw === 'string'
      ? draft.message.raw : '';

    if (!raw) {
      const topKeys = draft && typeof draft === 'object'
        ? Object.keys(draft).join(', ') : '(odgovor ni objekt)';
      const messageKeys = draft && draft.message && typeof draft.message === 'object'
        ? Object.keys(draft.message).join(', ') : '(message manjka)';
      return messageCard_('RAW MIME ni vrnjen',
        'Gmail REST API je odgovoril, vendar polje message.raw manjka. ' +
        'Polja Draft: ' + escapeHtml_(topKeys || '(prazno)') + '. ' +
        'Polja message: ' + escapeHtml_(messageKeys || '(prazno)') + '. ' +
        'Osnutek ni bil spremenjen.');
    }

    const bytes = decodeGmailRaw_(raw);
    if (!bytes || !bytes.length) {
      return messageCard_('RAW MIME je prazen',
        'Gmail API je vrnil polje raw, vendar po dekodiranju ni bilo podatkov. Osnutek ni bil spremenjen.');
    }

    // Fingerprint the exact draft version shown in this inspection card.
    // The next action re-fetches the draft and requires the same hash and size.
    const inspectedSha256 = sha256Hex_(bytes);
    const inspectedSize = bytes.length;

    const mime = Utilities.newBlob(bytes).getDataAsString('UTF-8');
    const headerBlock = mime.split(/\r?\n\r?\n/)[0] || '';
    const headers = parseRawHeaders_(headerBlock);

    // Cross-check the RAW MIME with Gmail's structured MIME tree.
    // Drafts.get(format=full) exposes nested MessagePart objects, including
    // filename, mimeType, body.attachmentId, and child parts.
    const fullDraft = Gmail.Users.Drafts.get('me', draftId, { format: 'full' });
    const fullMessage = fullDraft && fullDraft.message ? fullDraft.message : {};
    const payload = fullMessage.payload || {};
    const mimeSummary = inspectMimeTree_(payload);

    const decodedHeaders = {
      subject: decodeMimeHeader_(headers.subject || ''),
      from: decodeMimeHeader_(headers.from || ''),
      to: decodeMimeHeader_(headers.to || ''),
      cc: decodeMimeHeader_(headers.cc || ''),
      bcc: decodeMimeHeader_(headers.bcc || '')
    };

    const attachmentText = mimeSummary.attachments.length
      ? mimeSummary.attachments.map(function (item) {
          return escapeHtml_(item.filename || '(brez imena)') +
            (item.size ? ' (' + item.size + ' B)' : '');
        }).join('<br>')
      : 'niso zaznane';
    const inlineText = mimeSummary.inlineParts.length
      ? mimeSummary.inlineParts.map(function (item) {
          return escapeHtml_(item.filename || item.mimeType || 'vdelana vsebina');
        }).join('<br>')
      : 'niso zaznane';

    const card = CardService.newCardBuilder();
    card.setHeader(CardService.newCardHeader()
      .setTitle('AFNARIJA – pregled osnutka')
      .setSubtitle('Gmail REST API – Drafts.get(format=raw), samo branje'));
    const section = CardService.newCardSection()
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Izbrani pošiljatelj:</b> ' + escapeHtml_(senderAddress)))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Zadeva:</b> ' + escapeHtml_(decodedHeaders.subject || '(brez zadeve)')))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Od:</b> ' + escapeHtml_(decodedHeaders.from || '(ni navedeno)')))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Za:</b> ' + escapeHtml_(decodedHeaders.to || '(ni navedeno)')))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Kp:</b> ' + escapeHtml_(decodedHeaders.cc || '(ni navedeno)')))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Skp:</b> ' + escapeHtml_(decodedHeaders.bcc || '(ni navedeno)')))
      .addWidget(CardService.newDivider())
      .addWidget(CardService.newTextParagraph().setText('<b>RAW MIME:</b> uspešno pridobljen'))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Velikost:</b> ' + bytes.length + ' bajtov MIME; ' + raw.length + ' znakov Base64URL'))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>SHA-256 pregledane različice:</b> ' + escapeHtml_(inspectedSha256.slice(0, 16)) + '…'))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>HTML vsebina:</b> ' + (mimeSummary.hasHtml ? 'zaznana' : 'ni zaznana')))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Priponke (' + mimeSummary.attachments.length + '):</b><br>' + attachmentText))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Vdelane slike/vsebina (' + mimeSummary.inlineParts.length + '):</b><br>' + inlineText))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Prepoznani MIME deli:</b> ' + mimeSummary.totalParts))
      .addWidget(CardService.newTextParagraph().setText(
        'Vsebina sporočila ni izpisana. Osnutek ni bil poslan, spremenjen ali izbrisan.'))
      .addWidget(CardService.newDivider())
      .addWidget(CardService.newTextButton()
        .setText('Preveri prenos na Gateway (DRY RUN)')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('sendDraftToGatewayDryRun')
          .setParameters({
            draftId: draftId,
            senderAddress: senderAddress,
            inspectedSha256: inspectedSha256,
            inspectedSize: String(inspectedSize)
          })))
      .addWidget(CardService.newTextParagraph().setText(
        'Pred prenosom bo dodatek znova prebral isti osnutek in preveril, da se od pregleda ni spremenil. E-pošta ne bo poslana.'))
      .addWidget(CardService.newTextButton()
        .setText('Nazaj na AFNARIJA')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onCompose')
          .setParameters({ senderAddress: senderAddress })));
    card.addSection(section);
    return card.build();
  } catch (err) {
    return messageCard_('Napaka pri pridobivanju RAW MIME',
      escapeHtml_(String(err && err.message ? err.message : err)));
  }
}

/**
 * Calls users.drafts.get directly. This endpoint explicitly supports
 * gmail.compose, unlike users.messages.get which needs gmail.readonly/modify.
 */
function getDraftRawViaRest_(draftId) {
  const token = ScriptApp.getOAuthToken();
  if (!token) throw new Error('Apps Script ni pridobil OAuth žetona.');

  const url = 'https://gmail.googleapis.com/gmail/v1/users/me/drafts/' +
    encodeURIComponent(draftId) + '?format=raw';
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json'
    },
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  const body = response.getContentText();
  let data;
  try {
    data = JSON.parse(body);
  } catch (parseError) {
    throw new Error('Gmail API je vrnil neveljaven JSON. HTTP ' + status + '.');
  }

  if (status < 200 || status >= 300) {
    const apiMessage = data && data.error && data.error.message
      ? data.error.message : 'neznana napaka';
    throw new Error('Gmail drafts.get ni uspel (HTTP ' + status + '): ' + apiMessage);
  }
  return data;
}

/**
 * Sends the selected Gmail draft RAW MIME to AFNARIJA Gateway v4 in DRY_RUN mode.
 * This action only analyses the MIME payload. It does not send or store email.
 * The shared API token is read from Apps Script Script Properties, never from source.
 */
function sendDraftToGatewayDryRun(e) {
  try {
    const params = (e && e.parameters) ? e.parameters : {};
    const draftId = String(params.draftId || '').trim();
    const senderAddress = normalizeSelectedSender_(params.senderAddress || AFNARIJA_DEFAULT_SENDER);
    const inspectedSha256 = String(params.inspectedSha256 || '').trim().toLowerCase();
    const inspectedSize = Number(params.inspectedSize);
    if (!draftId) {
      return messageCard_('Manjka ID osnutka',
        'Vrnite se na pregled osnutka in ponovno izberite preverjanje prenosa.');
    }
    if (!/^[a-f0-9]{64}$/.test(inspectedSha256) ||
        !Number.isSafeInteger(inspectedSize) || inspectedSize < 1) {
      return messageCard_('Manjka kontrolni podpis pregleda',
        'Ta akcija nima veljavnega SHA-256 podpisa pregledane različice. Osnutek ponovno odpri prek »Preveri ta osnutek«.');
    }
    if (AFNARIJA_SENDERS.indexOf(senderAddress) === -1) {
      return messageCard_('Neveljaven pošiljatelj',
        'Izbrani naslov ni na seznamu devetih dovoljenih naslovov AFNARIJE.');
    }

    const apiToken = PropertiesService.getScriptProperties()
      .getProperty(AFNARIJA_GATEWAY_TOKEN_PROPERTY);
    if (!apiToken || apiToken.length < 32) {
      return messageCard_('Gateway token ni nastavljen',
        'V Apps Script odprite Project Settings → Script Properties in dodajte lastnost ' +
        '<b>' + AFNARIJA_GATEWAY_TOKEN_PROPERTY + '</b>. Njena vrednost mora biti enaka ' +
        'api_token v datoteki config.ini na Neoservu. Žetona ne pošiljajte v klepet in ga ne zapisujte v kodo.');
    }

    const draft = getDraftRawViaRest_(draftId);
    const raw = draft && draft.message && typeof draft.message.raw === 'string'
      ? draft.message.raw : '';
    if (!raw) {
      return messageCard_('RAW MIME ni na voljo',
        'Gmail API ni vrnil vsebine izbranega osnutka. Gateway ni bil poklican.');
    }

    // Decode the exact Gmail RAW MIME bytes and fingerprint those same bytes.
    // The Gateway independently calculates SHA-256 and rejects any mismatch.
    const rawBytes = decodeGmailRaw_(raw);
    if (!rawBytes || !rawBytes.length) {
      return messageCard_('RAW MIME je prazen',
        'Po dekodiranju Gmailovega RAW MIME ni podatkov. Gateway ni bil poklican.');
    }
    const rawSha256 = sha256Hex_(rawBytes);

    // Fail closed if the draft was edited after the user inspected it.
    if (rawBytes.length !== inspectedSize || rawSha256 !== inspectedSha256) {
      return messageCard_(
        'Osnutek se je po pregledu spremenil',
        'Vsebina, prejemniki, zadeva ali priponka niso več enaki pregledani različici. ' +
        'Gateway ni bil poklican. Vrnite se na seznam osnutkov in ponovno izberite »Preveri ta osnutek«.');
    }

    const requestId = Utilities.getUuid();
    const payload = {
      request_id: requestId,
      sender_address: senderAddress,
      raw_mime_b64url: raw,
      raw_mime_sha256: rawSha256
    };

    const response = UrlFetchApp.fetch(AFNARIJA_GATEWAY_URL, {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      headers: { 'X-AFNARIJA-TOKEN': apiToken },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const status = response.getResponseCode();
    const responseText = response.getContentText();
    let result;
    try {
      result = JSON.parse(responseText);
    } catch (parseErr) {
      throw new Error('Gateway je vrnil neveljaven JSON (HTTP ' + status + ').');
    }

    if (status < 200 || status >= 300 || !result.ok) {
      const apiError = result && result.error ? String(result.error) : 'neznana napaka';
      return messageCard_('Gateway je zavrnil preizkus',
        '<b>HTTP:</b> ' + status + '<br><b>Razlog:</b> ' + escapeHtml_(apiError) +
        '<br><br>Preverite API token v config.ini in Script Properties ter dovoljeni naslov pošiljatelja.');
    }

    // Fail closed: a successful HTTP response is not enough. Require the
    // Gateway's explicit SHA-256 confirmation and the exact same digest.
    const integrity = result.integrity || {};
    const gatewayHash = String(integrity.raw_mime_sha256 || '').toLowerCase();
    const gatewaySize = Number(result.raw_mime_size_bytes);
    const integrityOk =
      integrity.algorithm === 'SHA-256' &&
      integrity.client_sha256_provided === true &&
      integrity.sha256_verified === true &&
      /^[a-f0-9]{64}$/.test(gatewayHash) &&
      gatewayHash === rawSha256 &&
      gatewaySize === rawBytes.length;

    if (!integrityOk) {
      return messageCard_(
        'Preverjanje integritete ni uspelo',
        'Gateway ni potrdil enakega SHA-256 podpisa ali velikosti MIME. ' +
        'Sporočilo ni potrjeno in ga ne smemo poslati. Ponovi pregled osnutka.'
      );
    }

    const msg = result.message || {};
    const validation = result.sender_validation || {};
    const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
    const inlineItems = Array.isArray(msg.inline_items) ? msg.inline_items : [];
    const fromStatus = validation.from_override_required
      ? 'Izbrani pošiljatelj se razlikuje od izvirnega From. Ob dejanskem pošiljanju bo Gateway uporabil izbrani dovoljeni naslov.'
      : 'Izvirni From se ujema z izbranim pošiljateljem.';
    const mappingStatus = validation.smtp_profile_explicitly_mapped
      ? 'SMTP profil je izrecno preslikan.'
      : 'SMTP preslikava ni nastavljena.';
    const credentialStatus = validation.smtp_credentials_configured
      ? 'SMTP uporabniško ime in geslo sta v konfiguraciji.'
      : 'SMTP geslo še ni vpisano ali profil manjka.';
    const readinessStatus = validation.profile_ready_for_future_sending
      ? 'Profil je konfiguracijsko pripravljen za prihodnje pošiljanje; živa SMTP povezava v tej fazi ni izvedena.'
      : 'Profil še ni pripravljen za prihodnje pošiljanje.';
    const attachmentText = attachments.length
      ? attachments.map(function (item) {
          const shortHash = item.sha256
            ? '; SHA-256 ' + escapeHtml_(String(item.sha256).slice(0, 16)) + '…'
            : '';
          return escapeHtml_(item.filename || '(brez imena)') +
            ' (' + Number(item.size_bytes || 0) + ' B; ' + escapeHtml_(item.mime_type || 'neznan tip') +
            shortHash + ')';
        }).join('<br>')
      : 'niso zaznane';

    const card = CardService.newCardBuilder();
    card.setHeader(CardService.newCardHeader()
      .setTitle('AFNARIJA Gateway – prenos uspešen')
      .setSubtitle('DRY RUN – brez pošiljanja in shranjevanja sporočila'));
    card.addSection(CardService.newCardSection()
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Rezultat:</b> Gateway je sprejel in analiziral sporočilo.'))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Request ID:</b> ' + escapeHtml_(requestId)))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Izbrani pošiljatelj:</b> ' + escapeHtml_(result.requested_sender || senderAddress)))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>From v osnutku:</b> ' + escapeHtml_(msg.from || '(ni navedeno)')))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Preverjanje From:</b> ' + escapeHtml_(fromStatus)))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>SMTP profil:</b> ' + escapeHtml_(mappingStatus)))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>SMTP poverilnice:</b> ' + escapeHtml_(credentialStatus)))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Stanje profila:</b> ' + escapeHtml_(readinessStatus)))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Za:</b> ' + escapeHtml_(msg.to || '(ni navedeno)')))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Kp:</b> ' + escapeHtml_(msg.cc || '(ni navedeno)')))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Skp:</b> ' + escapeHtml_(msg.bcc || (msg.bcc_present ? '(vpisan)' : '(ni navedeno)'))))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Število prejemnikov:</b> ' + Number(validation.recipient_count || msg.recipient_count || 0)))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Zadeva:</b> ' + escapeHtml_(msg.subject || '(brez zadeve)')))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Velikost MIME:</b> ' + Number(result.raw_mime_size_bytes || 0) + ' B'))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Kontrola osnutka:</b> nespremenjen od pregleda'))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Integriteta MIME:</b> SHA-256 potrjen (' + escapeHtml_(rawSha256.slice(0, 16)) + '…)'))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>HTML:</b> ' + (msg.html_present ? 'zaznan' : 'ni zaznan') +
        '; <b>navadno besedilo:</b> ' + (msg.plain_text_present ? 'zaznano' : 'ni zaznano')))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Priponke (' + attachments.length + '):</b><br>' + attachmentText))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Vdelane vsebine:</b> ' + inlineItems.length))
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Način:</b> DRY_RUN. E-pošta ni bila poslana, vsebina ni bila shranjena in osnutek ni bil spremenjen.'))
      .addWidget(CardService.newTextButton()
        .setText('Nazaj na AFNARIJA')
        .setOnClickAction(CardService.newAction().setFunctionName('onCompose').setParameters({ senderAddress: senderAddress }))));

    // Expose the live-send action only for the one preconfigured pilot pair.
    // The Gateway independently enforces the same allowlist and confirmation.
    const pilotRecipients = Array.isArray(msg.recipient_addresses)
      ? msg.recipient_addresses.map(function (value) { return String(value).toLowerCase(); })
      : [];
    const canOfferPilotSend =
      senderAddress === AFNARIJA_PILOT_SENDER &&
      pilotRecipients.length === 1 &&
      pilotRecipients[0] === AFNARIJA_PILOT_RECIPIENT &&
      validation.from_override_required === false &&
      validation.profile_ready_for_future_sending === true &&
      integrityOk;

    if (canOfferPilotSend) {
      card.addSection(CardService.newCardSection()
        .addWidget(CardService.newTextParagraph().setText(
          '<b>Prvi dejanski preizkus:</b> poslano bo samo iz ' +
          escapeHtml_(AFNARIJA_PILOT_SENDER) + ' na ' +
          escapeHtml_(AFNARIJA_PILOT_RECIPIENT) + '.'))
        .addWidget(CardService.newTextButton()
          .setText('POŠLJI DEJANSKO – PILOT')
          .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
          .setOnClickAction(CardService.newAction()
            .setFunctionName('sendDraftViaGatewayPilot')
            .setParameters({
              draftId: draftId,
              senderAddress: senderAddress,
              inspectedSha256: inspectedSha256,
              inspectedSize: String(inspectedSize)
            })
            .setLoadIndicator(CardService.LoadIndicator.SPINNER)))
        .addWidget(CardService.newTextParagraph().setText(
          'Ta gumb izvede dejansko SMTP pošiljanje. Po potrditvi Gatewaya sporočila ne pošiljaj ponovno.')));
    }
    return card.build();
  } catch (err) {
    return messageCard_('Napaka pri prenosu na Gateway',
      escapeHtml_(String(err && err.message ? err.message : err)) +
      '<br><br>Preverite, ali je Gateway dosegljiv in ali sta API tokena enaka.');
  }
}

/**
 * Performs the first real SMTP pilot send.
 * The draft is fetched again and must exactly match the reviewed SHA-256/size.
 * Gateway v0.5 independently enforces pilot sender/recipient allowlists and
 * records an idempotency key. This function sends nothing through Gmail SMTP.
 */
function sendDraftViaGatewayPilot(e) {
  try {
    const params = (e && e.parameters) ? e.parameters : {};
    const draftId = String(params.draftId || '').trim();
    const senderAddress = normalizeSelectedSender_(params.senderAddress || '');
    const inspectedSha256 = String(params.inspectedSha256 || '').trim().toLowerCase();
    const inspectedSize = Number(params.inspectedSize);

    if (!draftId || senderAddress !== AFNARIJA_PILOT_SENDER) {
      return messageCard_('Pilot pošiljanje ni dovoljeno',
        'Ta preizkus je omejen na vnaprej določen pošiljateljski račun.');
    }
    if (!/^[a-f0-9]{64}$/.test(inspectedSha256) ||
        !Number.isSafeInteger(inspectedSize) || inspectedSize < 1) {
      return messageCard_('Manjka kontrola osnutka',
        'Osnutek ponovno preglej in šele nato uporabi pilotno pošiljanje.');
    }

    const apiToken = PropertiesService.getScriptProperties()
      .getProperty(AFNARIJA_GATEWAY_TOKEN_PROPERTY);
    if (!apiToken || apiToken.length < 32) {
      return messageCard_('Gateway token ni nastavljen',
        'Preveri Script Properties: AFNARIJA_GATEWAY_TOKEN.');
    }

    // Re-fetch the exact draft immediately before the external SMTP action.
    const draft = getDraftRawViaRest_(draftId);
    const raw = draft && draft.message && typeof draft.message.raw === 'string'
      ? draft.message.raw : '';
    if (!raw) {
      return messageCard_('RAW MIME ni na voljo',
        'Gmail ni vrnil vsebine osnutka. Sporočilo ni bilo poslano.');
    }
    const rawBytes = decodeGmailRaw_(raw);
    const currentSha256 = sha256Hex_(rawBytes);
    if (rawBytes.length !== inspectedSize || currentSha256 !== inspectedSha256) {
      return messageCard_('Osnutek se je po pregledu spremenil',
        'Dejansko pošiljanje je bilo preklicano. Ponovno preglej osnutek.');
    }

    const requestId = Utilities.getUuid();
    const payload = {
      request_id: requestId,
      draft_id: draftId,
      confirm_send: true,
      sender_address: senderAddress,
      raw_mime_b64url: raw,
      raw_mime_sha256: currentSha256
    };

    const response = UrlFetchApp.fetch(AFNARIJA_GATEWAY_SEND_URL, {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      headers: { 'X-AFNARIJA-TOKEN': apiToken },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const status = response.getResponseCode();
    let result;
    try {
      result = JSON.parse(response.getContentText());
    } catch (parseError) {
      return messageCard_('Nepričakovan odgovor Gatewaya',
        'HTTP ' + status + '. Pred ponovnim poskusom preveri prejemnikov predal.');
    }

    if (status >= 200 && status < 300 && result.ok === true &&
        result.smtp_accepted === true && result.smtp_status === 'SMTP_ACCEPTED') {
      const card = CardService.newCardBuilder();
      card.setHeader(CardService.newCardHeader()
        .setTitle('AFNARIJA – SMTP je sprejel sporočilo')
        .setSubtitle('Dejanski pilotni prenos je bil izveden'));
      card.addSection(CardService.newCardSection()
        .addWidget(CardService.newTextParagraph().setText(
          '<b>Stanje:</b> SMTP strežnik je sprejel sporočilo.'))
        .addWidget(CardService.newTextParagraph().setText(
          '<b>Od:</b> ' + escapeHtml_(result.sender || senderAddress)))
        .addWidget(CardService.newTextParagraph().setText(
          '<b>Število prejemnikov:</b> ' + Number(result.recipient_count || 0)))
        .addWidget(CardService.newTextParagraph().setText(
          '<b>Velikost MIME:</b> ' + Number(result.mime_size_bytes || 0) + ' B'))
        .addWidget(CardService.newTextParagraph().setText(
          '<b>Request ID:</b> ' + escapeHtml_(result.request_id || requestId)))
        .addWidget(CardService.newTextParagraph().setText(
          'SMTP sprejem je potrjen. Končna dostava v prejemnikov predal se preveri s prejemom sporočila.'))
        .addWidget(CardService.newTextParagraph().setText(
          'Gmailov osnutek ostane v Osnutkih; ta preizkus ga ne izbriše in ne premakne v Poslano.')));
      return card.build();
    }

    if (result.smtp_status === 'UNKNOWN') {
      return messageCard_('Izid SMTP pošiljanja ni znan',
        'Ne poskušaj ponovno poslati istega osnutka. Najprej preveri prejemnikov predal. Gateway je zaradi zaščite pred podvajanjem blokiral ponovni poskus.');
    }
    if (status === 409) {
      return messageCard_('Ponovitev pošiljanja je blokirana',
        'Gateway že ima zabeležen poskus za točno to različico osnutka. Preveri prejemnikov predal in evidenco Gatewaya.');
    }
    const apiError = result && result.error ? String(result.error) : 'neznana napaka';
    return messageCard_('SMTP pošiljanje ni uspelo',
      '<b>HTTP:</b> ' + status + '<br><b>Razlog:</b> ' + escapeHtml_(apiError) +
      '<br><br>Preveri rezultat v Gatewayu, preden ponoviš pošiljanje.');
  } catch (err) {
    return messageCard_('Napaka pri pilotnem pošiljanju',
      escapeHtml_(String(err && err.message ? err.message : err)) +
      '<br><br>Pred novim poskusom preveri, ali je SMTP strežnik sporočilo že sprejel.');
  }
}

/**
 * One-time authorization/connection test for the REST call used above.
 * Reads only the first page of draft metadata; does not fetch or alter messages.
 */
function authorizeGmailRawRead() {
  const token = ScriptApp.getOAuthToken();
  const response = UrlFetchApp.fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/drafts?maxResults=1',
    {
      method: 'get',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      muteHttpExceptions: true
    }
  );
  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    throw new Error('Preverjanje Gmail REST API ni uspelo. HTTP ' + status + ': ' +
      response.getContentText().slice(0, 500));
  }
  const result = JSON.parse(response.getContentText());
  const count = result.drafts ? result.drafts.length : 0;
  console.log('Gmail REST API avtorizacija uspešna. Osnutkov na prvi strani: ' + count);
}


/**
 * Recursively inspects Gmail MessagePart metadata. This is more reliable
 * than searching the serialized RAW MIME string for Content-Disposition,
 * because MIME headers can be folded and attachment parts can be nested.
 */
function inspectMimeTree_(rootPart) {
  const result = {
    totalParts: 0,
    hasHtml: false,
    attachments: [],
    inlineParts: []
  };

  function visit(part) {
    if (!part) return;
    result.totalParts++;

    const headers = getHeaderMap_(part.headers || []);
    const disposition = String(headers['content-disposition'] || '').toLowerCase();
    const contentId = String(headers['content-id'] || '').trim();
    const mimeType = String(part.mimeType || headers['content-type'] || '')
      .split(';')[0].trim().toLowerCase();
    const filename = String(part.filename || extractFilename_(disposition) || '').trim();
    const body = part.body || {};
    const hasAttachmentId = !!body.attachmentId;
    const explicitlyAttachment = /(?:^|;)\s*attachment(?:;|$)/i.test(disposition);
    const explicitlyInline = /(?:^|;)\s*inline(?:;|$)/i.test(disposition) || !!contentId;

    if (mimeType === 'text/html') result.hasHtml = true;

    // A filename is authoritative for Gmail attachment parts. Content-ID or
    // inline disposition takes precedence unless the part says attachment.
    const isInline = explicitlyInline && !explicitlyAttachment;
    const isAttachment = explicitlyAttachment ||
      (!!filename && !isInline) ||
      (hasAttachmentId && !isInline && mimeType !== 'text/plain' && mimeType !== 'text/html');

    const item = {
      filename: filename,
      mimeType: mimeType || '(neznan MIME tip)',
      size: Number(body.size || 0),
      attachmentId: body.attachmentId || ''
    };

    if (isAttachment) {
      result.attachments.push(item);
    } else if (isInline) {
      result.inlineParts.push(item);
    }

    const children = Array.isArray(part.parts) ? part.parts : [];
    children.forEach(visit);
  }

  visit(rootPart);
  return result;
}

function extractFilename_(contentDisposition) {
  const value = String(contentDisposition || '');
  const utf8 = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8 && utf8[1]) {
    try { return decodeURIComponent(utf8[1].replace(/"/g, '')); } catch (err) {}
  }
  const quoted = value.match(/filename\s*=\s*"([^"]+)"/i);
  if (quoted) return quoted[1];
  const plain = value.match(/filename\s*=\s*([^;\s]+)/i);
  return plain ? plain[1].replace(/^"|"$/g, '') : '';
}

/**
 * Decodes RFC 2047 encoded words (B and Q forms) in visible message headers.
 * This is display-only; the original RAW MIME remains unchanged.
 */
function decodeMimeHeader_(value) {
  const text = String(value || '');
  return text.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
    function (whole, charset, encoding, encodedText) {
      try {
        let bytes;
        if (String(encoding).toLowerCase() === 'b') {
          bytes = Utilities.base64Decode(encodedText);
        } else {
          const q = String(encodedText).replace(/_/g, ' ');
          const byteValues = [];
          for (let i = 0; i < q.length; i++) {
            if (q.charAt(i) === '=' && /^[0-9a-f]{2}$/i.test(q.substr(i + 1, 2))) {
              byteValues.push(parseInt(q.substr(i + 1, 2), 16));
              i += 2;
            } else {
              byteValues.push(q.charCodeAt(i) & 0xff);
            }
          }
          bytes = byteValues;
        }
        return Utilities.newBlob(bytes).getDataAsString(charset || 'UTF-8');
      } catch (err) {
        return whole;
      }
    }).replace(/\s{2,}/g, ' ').trim();
}

/**
 * Decodes the base64url string returned by Gmail API format=raw.
 * Gmail uses URL-safe Base64 and may omit trailing '=' padding.
 * No message content is logged or included in errors.
 */
/**
 * Returns a lowercase SHA-256 hex digest for the exact byte array supplied.
 * Apps Script returns signed byte values; normalize them to unsigned hex.
 */
function sha256Hex_(bytes) {
  if (!bytes || !bytes.length) {
    throw new Error('SHA-256 ni mogoče izračunati za prazen podatkovni niz.');
  }
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    bytes
  );
  return digest.map(function (value) {
    const unsigned = (value + 256) % 256;
    return ('0' + unsigned.toString(16)).slice(-2);
  }).join('');
}

/** Known-answer test: SHA-256('abc'). Safe to run manually in Apps Script. */
function testAfnarijaSha256() {
  const actual = sha256Hex_(Utilities.newBlob('abc').getBytes());
  const expected =
    'ba7816bf8f01cfea414140de5dae2223' +
    'b00361a396177a9cb410ff61f20015ad';
  if (actual !== expected) {
    throw new Error('SHA-256 samopreizkus ni uspel.');
  }
  console.log('SHA-256 samopreizkus uspešen.');
}

function decodeGmailRaw_(rawValue) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    throw new Error('Gmail API ni vrnil veljavnega besedilnega polja message.raw.');
  }

  const compact = rawValue.replace(/\s+/g, '');
  // Accept both base64url (- and _) and standard base64 (+ and /).
  let normalized = compact.replace(/-/g, '+').replace(/_/g, '/');

  // Padding is only valid at the end. Remove it and reconstruct it safely.
  normalized = normalized.replace(/=+$/g, '');
  if (!/^[A-Za-z0-9+/]*$/.test(normalized)) {
    throw new Error(
      'RAW MIME vsebuje nepričakovane znake. Dolžina podatka: ' + compact.length +
      '; presledek dolžine modulo 4: ' + (compact.length % 4) + '.'
    );
  }

  const remainder = normalized.length % 4;
  if (remainder === 1) {
    throw new Error(
      'RAW MIME ima neveljavno dolžino Base64URL (modulo 4 = 1). ' +
      'Dolžina podatka: ' + normalized.length + '.'
    );
  }
  if (remainder > 0) normalized += '='.repeat(4 - remainder);

  try {
    return Utilities.base64Decode(normalized);
  } catch (err) {
    // Fallback to Apps Script's URL-safe decoder, also with restored padding.
    const webSafe = compact.replace(/=+$/g, '');
    const webSafePadded = webSafe + '='.repeat((4 - (webSafe.length % 4)) % 4);
    try {
      return Utilities.base64DecodeWebSafe(webSafePadded);
    } catch (fallbackErr) {
      throw new Error(
        'Dekodiranje RAW MIME ni uspelo. Dolžina: ' + compact.length +
        '; modulo 4: ' + (compact.length % 4) +
        '; standardni dekoder: ' + String(err && err.message ? err.message : err) +
        '; URL-safe dekoder: ' + String(fallbackErr && fallbackErr.message ? fallbackErr.message : fallbackErr)
      );
    }
  }
}

function getSelectedSenderFromEvent_(e) {
  const event = e || {};
  let value = getEventInputValue_(event, 'afnarijaSender');
  const common = event.commonEventObject || {};
  if (!value && common.parameters && common.parameters.senderAddress) {
    value = String(common.parameters.senderAddress).trim().toLowerCase();
  }
  if (!value && event.parameters && event.parameters.senderAddress) {
    value = String(event.parameters.senderAddress).trim().toLowerCase();
  }
  if (value && AFNARIJA_SENDERS.indexOf(value) !== -1) {
    return value;
  }

  const last = PropertiesService.getUserProperties()
    .getProperty(AFNARIJA_LAST_SENDER_KEY);
  if (last && AFNARIJA_SENDERS.indexOf(last) !== -1) {
    return last;
  }
  return AFNARIJA_DEFAULT_SENDER;
}

function normalizeSelectedSender_(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return AFNARIJA_SENDERS.indexOf(normalized) !== -1
    ? normalized
    : AFNARIJA_DEFAULT_SENDER;
}

function messageCard_(title, message) {
  const card = CardService.newCardBuilder();
  card.setHeader(CardService.newCardHeader().setTitle(title));
  card.addSection(CardService.newCardSection()
    .addWidget(CardService.newTextParagraph().setText(message))
    .addWidget(CardService.newTextButton()
      .setText('Nazaj na AFNARIJA')
      .setOnClickAction(CardService.newAction().setFunctionName('onCompose'))));
  return card.build();
}

function getHeaderMap_(headers) {
  const map = {};
  (headers || []).forEach(function (header) {
    if (header && header.name) map[String(header.name).toLowerCase()] = header.value || '';
  });
  return map;
}

function parseRawHeaders_(headerBlock) {
  const unfolded = String(headerBlock || '').replace(/\r?\n[ \t]+/g, ' ');
  const map = {};
  unfolded.split(/\r?\n/).forEach(function (line) {
    const colon = line.indexOf(':');
    if (colon > 0) map[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  });
  return {
    subject: map.subject || '', from: map.from || '', to: map.to || '',
    cc: map.cc || '', bcc: map.bcc || ''
  };
}

function splitAddressHeader_(value) {
  const matches = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  return matches || [];
}

function normalizeEmails_(values) {
  const source = Array.isArray(values) ? values : [values];
  const out = [];
  source.forEach(function (value) {
    const matches = splitAddressHeader_(String(value || ''));
    matches.forEach(function (address) { out.push(address.toLowerCase()); });
  });
  return Array.from(new Set(out)).sort();
}

function normalizeSubject_(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function arraysEqual_(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function escapeHtml_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


