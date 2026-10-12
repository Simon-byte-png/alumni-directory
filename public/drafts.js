'use strict';

// Only profile fields; never credentials, quiz answers, or login tokens.
(function (root) {
  const fields = ['name', 'edu', 'cohort', 'status', 'industry', 'org', 'doing', 'city', 'willingContact', 'contact', 'offer', 'want', 'hiring', 'message'];
  function createDrafts(storage) {
    const key = owner => `alumni_draft_v1:${owner}`;
    return {
      save(owner, values) {
        const data = {};
        for (const field of fields) if (typeof values[field] === 'string') data[field] = values[field].slice(0, 500);
        try { storage.setItem(key(owner), JSON.stringify({ data, savedAt: new Date().toISOString() })); return true; }
        catch (_) { return false; }
      },
      load(owner) {
        try {
          const draft = JSON.parse(storage.getItem(key(owner)));
          if (!draft?.data || typeof draft.data !== 'object' || Array.isArray(draft.data)) return null;
          const data = {};
          for (const field of fields) if (typeof draft.data[field] === 'string') data[field] = draft.data[field].slice(0, 500);
          return { data, savedAt: draft.savedAt };
        } catch (_) { return null; }
      },
      clear(owner) { try { storage.removeItem(key(owner)); } catch (_) {} },
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { createDrafts };
  else root.createAsesDrafts = createDrafts;
})(typeof window !== 'undefined' ? window : globalThis);
