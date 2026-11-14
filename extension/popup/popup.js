document.addEventListener('DOMContentLoaded', async () => {
  const gatewayUrlInput = document.getElementById('gatewayUrl');
  const apiTokenInput = document.getElementById('apiToken');
  const userEmailsInput = document.getElementById('userEmails');
  const toggleTokenBtn = document.getElementById('toggleTokenBtn');
  const changeTokenBtn = document.getElementById('changeTokenBtn');
  const tokenSavedView = document.getElementById('tokenSavedView');
  const tokenInputWrapper = document.getElementById('tokenInputWrapper');
  const tokenHelpText = document.getElementById('tokenHelpText');
  const settingsForm = document.getElementById('settingsForm');
  const saveFeedback = document.getElementById('saveFeedback');
  const statusIndicator = document.getElementById('statusIndicator');
  const statusTitle = document.getElementById('statusTitle');
  const statusSub = document.getElementById('statusSub');

  let hasSavedToken = false;

  // Naloži shranjene nastavitve
  chrome.storage.local.get(['gatewayUrl', 'apiToken', 'userEmails'], (items) => {
    gatewayUrlInput.value = items.gatewayUrl || (typeof Mail Gateway_CONFIG !== 'undefined' && Mail Gateway_CONFIG.gatewayUrl) || 'https://gateway.tvoja-domena.si';
    userEmailsInput.value = items.userEmails || (typeof Mail Gateway_CONFIG !== 'undefined' && Mail Gateway_CONFIG.allowedSenders) || '';

    const effectiveToken = items.apiToken || (typeof Mail Gateway_CONFIG !== 'undefined' && Mail Gateway_CONFIG.apiToken) || '';

    // Če žeton že obstaja v hrambi ali konfiguraciji, ga NIKOLI ne izpišemo v DOM (skrit pred vpogledi)
    if (effectiveToken && effectiveToken.length > 0) {
      hasSavedToken = true;
      tokenSavedView.style.display = 'flex';
      tokenInputWrapper.style.display = 'none';
      apiTokenInput.value = ''; // Prazno v DOM-u!
      tokenHelpText.textContent = 'API žeton je varno shranjen in aktiven. Zaradi varnosti ga ni več mogoče pogledati.';
      if (!items.apiToken) {
        chrome.storage.local.set({ apiToken: effectiveToken });
      }
    } else {
      hasSavedToken = false;
      tokenSavedView.style.display = 'none';
      tokenInputWrapper.style.display = 'flex';
      tokenHelpText.textContent = 'Vnesite API žeton iz datoteke config.ini na NeoServu.';
    }

    checkGatewayHealth();
  });

  // Gumb "Zamenjaj ključ" omogoči vnos novega ključa, ne razkrije pa starega
  changeTokenBtn.addEventListener('click', () => {
    hasSavedToken = false;
    tokenSavedView.style.display = 'none';
    tokenInputWrapper.style.display = 'flex';
    apiTokenInput.value = '';
    apiTokenInput.focus();
    tokenHelpText.textContent = 'Vnesite nov API žeton. Stari žeton bo ob shranjevanju prepisan.';
  });

  // Preklopi vidnost žetona (deluje samo pri vnosu novega ključa)
  toggleTokenBtn.addEventListener('click', () => {
    if (apiTokenInput.type === 'password') {
      apiTokenInput.type = 'text';
      toggleTokenBtn.textContent = '🔒';
    } else {
      apiTokenInput.type = 'password';
      toggleTokenBtn.textContent = '👁';
    }
  });

  // Shrani nastavitve
  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const gatewayUrl = gatewayUrlInput.value.trim().replace(/\/+$/, '');
    const userEmails = userEmailsInput.value.trim().toLowerCase();

    if (!userEmails) {
      showFeedback('Vnesite vsaj en vaš e-poštni naslov.', 'error');
      return;
    }

    const updates = { gatewayUrl, userEmails };

    // Žeton posodobimo le, če uporabnik vnaša novega (ali prvega)
    if (!hasSavedToken) {
      const newToken = apiTokenInput.value.trim();
      if (!newToken || newToken.length < 16) {
        showFeedback('Vnesite veljaven API žeton (vsaj 16 znakov).', 'error');
        return;
      }
      updates.apiToken = newToken;
    }

    chrome.storage.local.set(updates, () => {
      showFeedback('✓ Nastavitve uspešno shranjene!', 'success');

      // Takoj zakleni prikaz žetona
      hasSavedToken = true;
      tokenSavedView.style.display = 'flex';
      tokenInputWrapper.style.display = 'none';
      apiTokenInput.value = '';
      tokenHelpText.textContent = 'API žeton je varno shranjen in aktiven. Zaradi varnosti ga ni več mogoče pogledati.';

      checkGatewayHealth();
    });
  });

  function checkGatewayHealth() {
    statusIndicator.className = 'status-indicator';
    statusTitle.textContent = 'Preverjanje povezave...';
    statusSub.textContent = gatewayUrlInput.value || 'gateway.tvoja-domena.si';

    chrome.runtime.sendMessage({ action: 'CHECK_HEALTH' }, (response) => {
      if (chrome.runtime.lastError || !response || !response.ok) {
        statusIndicator.className = 'status-indicator offline';
        statusTitle.textContent = 'Gateway ni dosegljiv';
        statusSub.textContent = (response && response.error) || 'Preveri URL ali spletno povezavo';
        return;
      }

      const data = response.data || {};
      statusIndicator.className = 'status-indicator online';
      const mode = data.mode || 'NEZNAN';
      const version = data.version || '0.5.0';
      const sending = data.sending_enabled ? 'pošiljanje vključeno' : 'pošiljanje izključeno';
      statusTitle.textContent = `Povezava v redu (v${version})`;
      statusSub.textContent = `Način: ${mode} (${sending})`;
    });
  }

  function showFeedback(text, type = 'success') {
    saveFeedback.className = `feedback ${type}`;
    saveFeedback.textContent = text;
    setTimeout(() => {
      if (saveFeedback.textContent === text) saveFeedback.textContent = '';
    }, 4000);
  }
});
