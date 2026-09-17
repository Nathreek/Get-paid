import { spotlightReadyAt } from './submission-state.js';
// Guaranteed turns after the one-minute wait; samples fill alternate turns.
export function createSpotlightPicker(sampleNames, random = Math.random) {
  const shownIds = new Set();
  let lastSubmittedId = '', lastSource = 'sample', currentName = '', selectedRecordId = null;
  const ready = (records, now) => records.filter(record => spotlightReadyAt(record) <= now);
  return {
    get selectedRecordId() { return selectedRecordId; },
    hasNew(records, now = Date.now()) {
      return ready(records, now).some(record => !shownIds.has(record.id));
    },
    next(records, now = Date.now()) {
      const eligible = ready(records, now);
      let selected = eligible.find(record => !record.sentAt && !shownIds.has(record.id)) || eligible.find(record => !shownIds.has(record.id));
      if (!selected && eligible.length && lastSource === 'sample') {
        const previous = eligible.findIndex(record => record.id === lastSubmittedId);
        selected = eligible[(previous + 1) % eligible.length];
      }
      if (selected) {
        selectedRecordId = selected.id;
        shownIds.add(selected.id);
        lastSubmittedId = selected.id;
        lastSource = 'submitted';
        currentName = selected.displayName;
      } else {
        selectedRecordId = null;
        // Avoid displaying a queued user's name through a matching sample alias.
        const waitingNames = new Set(records.filter(record => spotlightReadyAt(record) > now).map(record => record.displayName));
        const pool = sampleNames.filter(name => name !== currentName && !waitingNames.has(name));
        if (!pool.length) { currentName = 'Your name could be next'; lastSource = 'sample'; return currentName; }
        currentName = pool[Math.floor(random() * pool.length)];
        lastSource = 'sample';
      }
      return currentName;
    }
  };
}
