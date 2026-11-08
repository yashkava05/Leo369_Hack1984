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

  if (source && tab && source.tabId === tab.id) {
    show('This tab is shared with Latent.', source.accountLabel ? 'Account: ' + source.accountLabel : source.origin)
    stop.hidden = false
  } else if (match) {
    show(core.PROVIDERS[match.provider].label + ' detected.', 'Share this tab so Latent can read it when you confirm a request.')
    share.hidden = false
    if (source) stop.hidden = false
  } else {
    show('Open Outlook on the web in this tab, then click the Latent icon again.', 'Supported: ' + core.PROVIDERS.outlook.origins.map(function (o) { return o.replace('https://', '') }).join(', '))
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
      show('Shared. Go back to Latent.', result.accountLabel ? 'Account: ' + result.accountLabel : result.origin)
      share.hidden = true; stop.hidden = false
    } else {
      var code = result && result.error
      show(code === 'login_required' ? 'Sign in to Outlook first, then try again.' : 'Could not share this tab.', code || '')
      share.disabled = false
    }
  })

  stop.addEventListener('click', async function () {
    await chrome.runtime.sendMessage({ type: 'latent.unselect' })
    if (match) { try { await chrome.permissions.remove({ origins: [match.origin + '/*'] }) } catch (e) { /* already removed */ } }
    show('Stopped sharing.', 'Latent can no longer read this tab.')
    stop.hidden = true
    share.hidden = !match
    share.disabled = false
  })
})()
