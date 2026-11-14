/**
 * Custom Domain Mail – Nastavitve razširitve
 * API žeton uporabnik vnese ob prvi namestitvi v pojavnem oknu,
 * kjer se nato varno zaklene in skrije pred vpogledi.
 */

const Mail Gateway_CONFIG = {
  // Naslov zalednega strežnika na NeoServu
  gatewayUrl: 'https://gateway.tvoja-domena.si',

  // Prazen API žeton (uporabnik ga vnese ob prvi nastavitvi)
  apiToken: '',

  // Privzeti naslovi (uporabnik vpiše svojega ob prvi nastavitvi)
  allowedSenders: ''
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Mail Gateway_CONFIG;
}
