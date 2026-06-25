/* Page identity detection utilities. */
(function (root) {
  'use strict';

  if (root.AMZ_IDENTITY) return;

  const { IDENTITY, SELECTORS, STORAGE_KEYS } = root.AMZ_CONSTANTS;
  const storage = root.AMZ_STORAGE;

  function extractEmailsFromPage() {
    const candidates = new Set();
    const emailPattern = new RegExp(
      IDENTITY.EMAIL_DISCOVERY_REGEX.source,
      IDENTITY.EMAIL_DISCOVERY_REGEX.flags
    );

    document.querySelectorAll(SELECTORS.EMAIL_INPUTS).forEach(input => {
      if (input.value) candidates.add(input.value.trim());
    });

    document.querySelectorAll(SELECTORS.MAILTO_LINKS).forEach(link => {
      const email = String(link.getAttribute('href') || '').replace(/^mailto:/i, '').trim();
      if (email) candidates.add(email);
    });

    const pageText = document.body?.innerText || '';
    (pageText.match(emailPattern) || []).forEach(email => candidates.add(email.trim()));
    return Array.from(candidates);
  }

  async function syncEmailFromPage() {
    const emails = extractEmailsFromPage();
    if (emails.length === 0) return [];

    await storage.setLocal({ [STORAGE_KEYS.DETECTED_EMAILS]: emails });
    return emails;
  }

  root.AMZ_IDENTITY = Object.freeze({
    extractEmailsFromPage,
    syncEmailFromPage,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
