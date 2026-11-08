/** Plain-language recovery for every constant error code the Teams bridge can produce. */
export function teamsRecovery(code: string | null): { title: string; action: 'retry' | 'setup' | 'none' } {
  switch (code) {
    case 'extension_unavailable': return { title: 'The Latent Chrome extension is not reachable. Install it from browser-extension/ (Chrome desktop only), then check again.', action: 'setup' }
    case 'unsupported_browser': return { title: 'This browser cannot run the Latent extension. Use Chrome on desktop.', action: 'none' }
    case 'no_source_selected': return { title: 'No Teams chat is shared yet. Open Teams on the web, open the one chat or channel you want, click the Latent extension icon, then “Allow this Teams chat”.', action: 'setup' }
    case 'nothing_selected': return { title: 'No chat or channel is open in the shared Teams tab. Open the one you want, share it again from the extension icon, then check again.', action: 'setup' }
    case 'conversation_changed': return { title: 'The shared Teams tab now shows a different chat or channel. Nothing was read. Go back to the one you shared, or share the new one from the extension icon.', action: 'setup' }
    case 'source_selection_required': return { title: 'Confirm which chat or channel Latent may read before reading.', action: 'retry' }
    case 'permission_denied': return { title: 'Permission for Teams was denied or revoked. Teams needs its own permission, separate from Outlook. Share the chat again from the extension icon.', action: 'setup' }
    case 'tab_closed': return { title: 'The shared Teams tab was closed. Open it again and share the chat from the extension icon.', action: 'setup' }
    case 'wrong_origin': return { title: 'The shared tab is no longer on a supported Teams site. Nothing was read.', action: 'setup' }
    case 'account_changed': return { title: 'A different account or organization is signed in to the shared Teams tab. Share the chat again to confirm it.', action: 'setup' }
    case 'login_required': return { title: 'Teams needs you to sign in again (or finish MFA). Sign in in that tab, then retry.', action: 'retry' }
    case 'org_blocked': return { title: 'Your organization’s policy blocks this in Teams. Latent will not work around it; ask your admin if you need access.', action: 'none' }
    case 'unsupported_layout': return { title: 'Latent could not find the message timeline in this Teams layout. Open the chat or channel in the main view (not a pop-out) and retry.', action: 'retry' }
    case 'empty_conversation': return { title: 'The shared conversation has no messages to read.', action: 'retry' }
    case 'airgap_on': return { title: 'Air-gap is on, so Latent will not read browser tabs. Turn it off to continue.', action: 'retry' }
    case 'local_model_unavailable': return { title: 'The local model is not running. Start Ollama, then retry. Nothing was sent anywhere else.', action: 'retry' }
    case 'scope_exceeded':
    case 'scope_mismatch': return { title: 'The extension returned more than you approved, so Latent discarded it.', action: 'retry' }
    default: return { title: 'Something went wrong reading Teams. Nothing was saved. Try again.', action: 'retry' }
  }
}
