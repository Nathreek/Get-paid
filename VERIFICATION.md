# Verification

This is a chronological record of earlier UI revisions. CAPACITY-REPORT.md and README.md describe the current shared-server implementation and supersede the older device-local and multi-pill descriptions below.

Checked on 17 September 2026.

- Local website returned HTTP 200 and loaded with no captured browser errors or warnings.
- Visually reviewed desktop at 1280 × 900 and phone at 390 × 844; also checked 320px viewport for horizontal overflow (none).
- Empty form produced field-specific errors and focused the first invalid field.
- Submitted @sam_builds with an X post URL: the row first showed a hidden name, countdown and progress. Reload retained the pending deadline. It later revealed the local alias Sam Parker.
- Repeating the same post and handle produced a duplicate error.
- Keyboard removal cleared the test entry and remained cleared after reload. Test submissions were removed before handoff.
- Buy opened the configured placeholder dialog; dismiss worked.
- 30D analytics selected a different demo total; restored the default 7D period.
- Inspected the four-step How it works section and its explicit integration status.
- Five automated tests passed for URL validation, handle validation, random delay bounds/variation, saved-record validation/deadline preservation, and the local name adapter.

Limitations: no X API lookup, bot verification, wallet transaction, or payment provider was executed. Copying a real coin address and following a real purchase URL require the owner to supply those values. The referenced screenshot file was unavailable. The UI was checked against the live reference site and written requirements.

## Monochrome / GET PAID revision

- Replaced the old wordmark with the user-supplied GP logo and GET PAID label, with monochrome display styling. The original uploaded PNG is preserved in assets/gp-logo.png.
- Removed Analytics and its navigation, data, and event handlers. No Top Tokens section is present.
- Removed the Demo badge beside Maya Chen. Added two randomly selected name pills from a pool of ten local names; names change at random 6–12 second intervals, with pause/resume and reduced-motion support.
- Confirmed the logo loads, the removed content is absent, names change, pause works, and the 390px phone layout has no horizontal overflow.
- Existing five model tests passed after the changes. Submission still enters the delayed queue without browser errors.
`n- Replaced the ambiguous source mark with a generated GP monogram and visually verified its G crossbar and P at the final header size. The asset loaded successfully; the test queue was cleared.

## Copy and Buy window update

- Heading: Route fees through X money.
- Tagline: A post, a handle, and your next payout.
- Removed the requested timing note, local-storage note, reveal footer, preview explanation, footer slogan, and bottom-right Local preview label.
- All three featured names now rotate, including the name previously fixed to Maya Chen. Names are selected without repeating the immediately previous set.
- Buy always opens a Coin CA dialog. The owner will provide the actual CA later, so the dialog currently displays Your coin address here. Setting coinAddress in dist/config.js updates both address locations and enables Copy CA.
- Runtime syntax checked; browser confirmed the new heading, removed text, random primary name, and Buy dialog. No payment integration was added.

- Single-pill revision: removed both extra name boxes. One transaction pill remains; its name and initials change together at the existing random interval. Verified a single pill in the browser and checked JavaScript syntax.

## Guaranteed submitted-name spotlight

- Newly revealed submissions are prioritized in the single top pill. Saved, already revealed submissions are prioritized on reload.
- After each submitted name is shown, sample names alternate with submitted names. Multiple submitted names receive turns in order instead of relying on a random lottery.
- Pending submissions remain hidden until their reveal deadlines. Removed records are excluded from future turns.
- Removed the Live locally badge from the reveal room.
- Eight regression tests passed, including first appearance, repeat turns, delayed eligibility, and fair rotation across multiple submissions.

- Browser verification: a temporary submission remained hidden while queued, appeared in the top pill after its delay, and appeared first after reload. No browser errors were captured. Removed only the temporary test entry afterward. Confirmed Live locally is absent.

## One-minute Pending / Sent revision

- Removed the revealed and in-the-queue summary counters.
- After the queue timer completes, names appear in the list as Pending.
- Top eligibility starts exactly 60 seconds after the stored queue deadline; Pending is retained until the record actually appears in the top box.
- Top display writes a persisted sentAt timestamp and changes the list badge to Sent.
- Samples matching a waiting submission name are excluded during the delay.
- All ten automated regression tests passed, including the exact 60-second boundary, refresh preservation, actual-display-only status changes, and matching sample exclusion.

- Full live-browser check passed: queued entry became Pending in the list; refreshing partway through the additional minute did not show it early; after the minute the top pill showed the submitted name and the badge read Sent. Sent survived a second refresh. Checked mobile Pending layout and no captured console errors. Removed the temporary minutecheck entry afterward.
