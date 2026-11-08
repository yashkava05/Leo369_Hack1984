/* Popup: the explicit, per-tab grant. Clicking the toolbar icon is the user gesture Chrome needs
 * for chrome.permissions.request; Latent never asks for all sites and never scans other tabs. */
/* global LatentBridge */
;(async function () {
  var core = LatentBridge
  var status = document.getElementById('status')
  var detail = document.getElementById('detail')
  var share = document.getElementById('share')
  var stop = document.getElementById('stop')
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  var tab = tabs[0]
  var match = tab && tab.url ? core.providerForUrl(tab.url) : null
  var data = await chrome.storage.session.get('source')
  var source = data.source || null

  function show(text, extra) { status.textContent = text; detail.textContent = extra || '' }
  function hosts(name) { return core.PROVIDERS[name].origins.map(function (o) { return o.replace('https://', '') }).join(', ') }
  function sharedDetail(src) {
    var parts = []
    if (src.conversation) parts.push((src.conversation.kind === 'channel' ? 'Channel: ' : 'Chat: ') + src.conversation.label)
    if (src.accountLabel) parts.push('Account: ' + src.accountLabel)
    return parts.join(' · ') || src.origin
  }
  var isTeams = !!match && match.provider === 'teams'
  share.textContent = isTeams ? 'Allow this Teams chat' : 'Allow this Outlook tab'
  document.getElementById('teams-note').hidden = !isTeams

  if (source && tab && source.tabId === tab.id) {
    show('This tab is shared with Latent.', sharedDetail(source))
    stop.hidden = false
  } else if (match) {
    show(core.PROVIDERS[match.provider].label + ' detected.', isTeams
      ? 'Open the one chat or channel you want Latent to read, then share it. Latent reads only that conversation, when you confirm a request.'
      : 'Share this tab so Latent can read it when you confirm a request.')
    share.hidden = false
    if (source) stop.hidden = false
  } else {
    show('Open Outlook on the web or Teams on the web in this tab, then click the Latent icon again.', 'Supported: ' + hosts('outlook') + ', ' + hosts('teams'))
    if (source) stop.hidden = false
  }

  share.addEventListener('click', async function () {
    share.disabled = true
    var granted = false
    // Chrome may close the popup while its permission prompt is open; the worker then finishes
    // the selection from permissions.onAdded using this pending tab.
    await chrome.runtime.sendMessage({ type: 'latent.pending', tabId: tab.id })
    try { granted = await chrome.permissions.request({ origins: [match.origin + '/*'] }) } catch (e) { granted = false }
    if (!granted) { show('Permission denied.', 'Latent cannot read this tab without your permission.'); share.disabled = false; return }
    var result = await chrome.runtime.sendMessage({ type: 'latent.select', tabId: tab.id })
    if (result && result.ok) {
      show('Shared. Go back to Latent.', sharedDetail(result))
      share.hidden = true; stop.hidden = false
      source = { origin: result.origin }
    } else {
      var code = result && result.error
      var app = isTeams ? 'Teams' : 'Outlook'
      var why = {
        login_required: 'Sign in to ' + app + ' first, then try again.',
        nothing_selected: 'Open one chat or channel in Teams first, then try again.',
        org_blocked: 'Your organization blocks this. Latent will not work around it.',
      }
      show(why[code] || 'Could not share this tab.', code || '')
      share.disabled = false
    }
  })

  stop.addEventListener('click', async function () {
    await chrome.runtime.sendMessage({ type: 'latent.unselect' })
    // Revoke the grant for the shared tab's site (and this tab's, if it is another supported site).
    var origins = [source && source.origin, match && match.origin].filter(Boolean)
    for (var i = 0; i < origins.length; i++) {
      try { await chrome.permissions.remove({ origins: [origins[i] + '/*'] }) } catch (e) { /* already removed */ }
    }
    source = null
    show('Stopped sharing.', 'Latent can no longer read this tab.')
    stop.hidden = true
    share.hidden = !match
    share.disabled = false
  })
})()
