/**
 * FR-043b: asynchronous agent activity — a response beginning or completing, a proposed edit
 * arriving, a conversation becoming stale, or an agent error — must be conveyed to assistive
 * technology as it happens, without moving the user's focus. Implemented as two always-present,
 * visually-hidden ARIA live regions appended directly to `document.body` (outside any single
 * component's subtree, so they survive route/view changes and are reachable from Pinia store
 * actions, not just components): `aria-live="polite"` for start/completion/proposal/staleness,
 * `aria-live="assertive"` reserved for errors.
 *
 * Plain DOM module (not a Vue composable) on purpose — the call sites that most need it
 * (stores/conversations.ts, stores/edits.ts `handleServerFrame`) run outside component `setup()`,
 * so there is no reliable injection context to hang a composable off. `mountLiveRegions()` is
 * called once from App.vue's `onMounted` for a deterministic single instance; every announce
 * function is independently idempotent (`getRegion` self-heals) so call order never matters.
 */

export type LiveRegionPoliteness = 'polite' | 'assertive';

const REGION_IDS: Record<LiveRegionPoliteness, string> = {
  polite: 'a11y-live-region-polite',
  assertive: 'a11y-live-region-assertive',
};

function createRegion(politeness: LiveRegionPoliteness): HTMLElement {
  const el = document.createElement('div');
  el.id = REGION_IDS[politeness];
  el.setAttribute('aria-live', politeness);
  el.setAttribute('aria-atomic', 'true');
  el.setAttribute('role', politeness === 'assertive' ? 'alert' : 'status');
  // `.visually-hidden` is defined globally in style.css (loaded once via main.ts, not a
  // component-scoped stylesheet) so this plain DOM node — appended directly to document.body,
  // outside any component's subtree — can reuse the same class every component uses instead of
  // duplicating the style as an inline string.
  el.className = 'visually-hidden';
  document.body.appendChild(el);
  return el;
}

function getRegion(politeness: LiveRegionPoliteness): HTMLElement {
  return document.getElementById(REGION_IDS[politeness]) ?? createRegion(politeness);
}

/** Ensures both live regions exist. Safe to call more than once (idempotent) and safe never to
 *  call at all (every announce* function below creates them lazily on first use regardless). */
export function mountLiveRegions(): void {
  getRegion('polite');
  getRegion('assertive');
}

/** Clearing the region before re-setting the same text (on a short delay) forces assistive
 *  technology to register a genuine content mutation even when two consecutive announcements
 *  happen to share identical wording — otherwise a no-op DOM write can be silently coalesced. */
function announce(politeness: LiveRegionPoliteness, message: string): void {
  const region = getRegion(politeness);
  region.textContent = '';
  window.setTimeout(() => {
    region.textContent = message;
  }, 30);
}

export function announcePolite(message: string): void {
  announce('polite', message);
}

export function announceAssertive(message: string): void {
  announce('assertive', message);
}

// ---- FR-043b's five required status announcements ----
// Each wraps announcePolite/announceAssertive with the human-readable copy, so call sites
// (stores/conversations.ts, stores/edits.ts) only need to supply the data already at hand from
// the WS event they're already handling — no new state, no change to existing state-update logic.

export function announceAgentStarted(conversationName: string): void {
  announcePolite(`${conversationName}: the agent started responding.`);
}

export function announceMessageCompleted(conversationName: string): void {
  announcePolite(`${conversationName}: response completed.`);
}

export function announceStagedEditCreated(conversationName: string, summary: string): void {
  announcePolite(`${conversationName}: new proposed edit — ${summary}.`);
}

export function announceConversationStale(conversationName: string): void {
  announcePolite(`${conversationName} is now stale: the document changed since its last context refresh.`);
}

export function announceAgentError(conversationName: string, message: string): void {
  announceAssertive(`${conversationName}: agent error — ${message}`);
}
