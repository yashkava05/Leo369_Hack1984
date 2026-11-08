/** Plain-language recovery for every constant error code the bridge can produce. */
export function outlookRecovery(code: string | null): { title: string; action: 'retry' | 'setup' | 'none' } {
  switch (code) {
    case 'extension_unavailable': return { title: 'The PrismLocal Chrome extension is not reachable. Install it from browser-extension/ (Chrome desktop only), then check again.', action: 'setup' }
    case 'unsupported_browser': return { title: 'This browser cannot run the PrismLocal extension. Use Chrome on desktop.', action: 'none' }
    case 'no_source_selected': return { title: 'No Outlook tab is shared yet. Open Outlook on the web, click the PrismLocal extension icon, then “Allow this Outlook tab”.', action: 'setup' }
    case 'permission_denied': return { title: 'Permission for the Outlook tab was denied or revoked. Share the tab again from the extension icon.', action: 'setup' }
    case 'tab_closed': return { title: 'The shared Outlook tab was closed. Open it again and share it from the extension icon.', action: 'setup' }
    case 'wrong_origin': return { title: 'The shared tab is no longer on a supported Outlook site. Nothing was read.', action: 'setup' }
    case 'account_changed': return { title: 'A different account is signed in to the shared tab. Share the tab again to confirm the account.', action: 'setup' }
    case 'login_required': return { title: 'Outlook needs you to sign in again (or finish MFA). Sign in in that tab, then retry.', action: 'retry' }
    case 'unsupported_layout': return { title: 'PrismLocal could not find the message list in this Outlook layout. Switch to the Inbox view and retry.', action: 'retry' }
    case 'empty_mailbox': return { title: 'The message list is empty, so there was nothing to read.', action: 'retry' }
    case 'nothing_selected': return { title: 'No message is open in the reading pane. Open one in Outlook, then retry.', action: 'retry' }
    case 'airgap_on': return { title: 'Air-gap is on, so PrismLocal will not read browser tabs. Turn it off to continue.', action: 'retry' }
    case 'local_model_unavailable': return { title: 'The local model is not running. Start Ollama, then retry. Nothing was sent anywhere else.', action: 'retry' }
    case 'scope_exceeded':
    case 'scope_mismatch': return { title: 'The extension returned more than you approved, so PrismLocal discarded it.', action: 'retry' }
    default: return { title: 'Something went wrong reading Outlook. Nothing was saved. Try again.', action: 'retry' }
  }
}
