// Pure state used by the conversation page. An uncertain acknowledgement keeps
// its original ID and text; a second click cannot become a second submission.
export function createComposer(makeId = () => crypto.randomUUID()) {
  let pending = null;
  return {
    begin(text) {
      if (pending) return { ...pending };
      if (typeof text !== 'string' || !text.trim() || new TextEncoder().encode(text).length > 65536) return null;
      pending = { submissionId: makeId(), text };
      return { ...pending };
    },
    settle(result) {
      if (!pending) return null;
      if (result?.ok === false && ['invalid-request', 'input-not-ready', 'runtime-not-open', 'submission-not-found'].includes(result.reason)) {
        const outcome = { state: 'not-sent', draft: pending.text };
        pending = null;
        return outcome;
      }
      if (!result?.ok || result.receipt?.submissionId !== pending.submissionId) return null;
      if (['accepted', 'steering-accepted', 'cancelled', 'failed'].includes(result.receipt.state)) {
        const state = result.receipt.state;
        const outcome = { state, draft: ['failed', 'cancelled'].includes(state) ? pending.text : '' };
        pending = null;
        return outcome;
      }
      return null;
    },
    pending: () => pending && { ...pending },
    restore(record) {
      if (pending || !record || typeof record.receiptId !== 'string' || !/^wb:[a-f0-9]{64}$/.test(record.receiptId) ||
          typeof record.text !== 'string' || new TextEncoder().encode(record.text).length > 65536) return false;
      pending = { submissionId: record.receiptId, text: record.text, recovered: true };
      return true;
    },
    clear: () => { pending = null; },
  };
}

export function canCompose(state) {
  return state?.ok === true && state.status === 'open' &&
    state.snapshot?.experimentalDeliveryReady === true && state.view?.canSend === true &&
    !state.view.requests?.length;
}

export function heldMessage(reason) {
  const words = {
    disabled: 'Codex is not enabled on this computer.',
    'configuration-unavailable': 'Codex setup is unavailable on this computer.',
    'windows-storage-unverified': 'Codex on Windows is waiting for its native storage check.',
    'scope-changed': 'The account or window changed. Choose a conversation again.',
    'context-changed': 'The account or window changed. Choose a conversation again.',
    'transport-unavailable': 'Could not connect to Codex on this computer.',
    'pending-request-recovery': 'An earlier request needs recovery before this conversation can continue.',
    'approval-required': 'Codex needs your answer below.',
    'unresolved-delivery': 'Check the saved message’s delivery before sending another.',
    'cleanup-failed': 'Codex has not confirmed it stopped. The saved conversation remains held.',
    'creation-uncertain': 'A previous creation did not finish. Resume the saved conversation before trying again.',
    'missing-binding': 'There is no saved conversation for this profile yet.',
    'policy-mismatch': 'Codex opened with different settings. Check this profile before continuing.',
    'unsupported-protocol': 'This Codex version has not been validated for Workbench.',
    'storage-failed': 'Could not verify the saved conversation. Its saved state has been kept.',
    'runtime-open': 'This conversation is already open.',
    'request-not-current': 'This request is no longer waiting for an answer.',
    'not-connected': 'Codex disconnected. Resume the saved conversation to reconnect.',
    'invalid-request': 'Check the message and try again.',
  };
  return words[reason] || 'Codex is paused. Check the conversation before continuing.';
}
