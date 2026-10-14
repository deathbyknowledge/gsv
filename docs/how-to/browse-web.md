# Browse the web

GSV can navigate websites, read pages, take screenshots and fill forms through
a cloud browser or your personal browser connected with the **Your GSV**
extension. Both use the same browsing capability.

## Use a cloud browser

When your operator enables cloud browsers, Ship can
[start a browser in GSV](/how-to/cloud-browsers) for website tasks even when no
personal browser is connected. Ask for the task; Ship checks for a suitable
browser and starts one when needed. Ship reuses your account's current cloud
browser, and website logins are remembered automatically. Click the browser in
Fleet to watch Ship's cursor and clicks or enter input yourself. Watching and
closing the view leave Ship running.

## Connect your browser

Connecting your personal browser is optional. Use it when you want Ship to work
in its existing tabs and signed-in sessions, or when a site needs a feature
available only on your device.

1. In GSV, open **Fleet**, click **connect** beside Places, and choose **Browser.** Give it a name or leave the default.
2. Download the extension, **Your GSV**, and load it at `chrome://extensions` with developer mode on.
3. Click its toolbar icon, paste the invitation from GSV, and choose **Pair this browser**.
4. The panel says **Ready** once it's connected. Chrome shows a banner in a tab while your GSV works there; that's normal.

You can close the sidebar after pairing. The extension keeps working while Chrome is open. The browser control stays near the bottom of the sidebar: **Pause** disconnects this browser from GSV until you choose **Resume**. When the panel shows active browser work, **Stop** ends network captures, tab recordings, and debugger sessions, then disconnects. Your pairing is saved, so you do not need a new invitation.

## Try it

Ask your agent: *What can you do with my browser extension?*

### Cross-device: fire from your phone, act on your laptop

Text GSV from Telegram while you're away from your desk: *Go to my billing portal and grab this month's invoice.* The browser action runs in your logged-in session on your laptop. This is the one that makes it clear this isn't just a browser agent — the browser is one tool a mind on the edge reaches across the machines it spans.

### Sites with no API, behind your login

Most of the web you actually use has no API and no export button. The extension reaches it because it's your authenticated session — something an external integration can never touch.

- *Pull my latest statement from [billing portal] and save it.*
- *What does the usage number say on my [SaaS] admin dashboard right now?*
- *Submit this expense entry form with these values.*
- *Grab that thread from [private forum] and summarize it.*

### Always-on watching

GSV keeps watching on the edge whether or not you're at the machine. Point it at a page and tell it what to wait for.

- *Check [URL] every hour and tell me when the price drops below $X.*
- *Watch [support ticket] and message me when the status changes.*
- *Keep an eye on [product page] and let me know when it's back in stock.*
- *Monitor [scheduling page] and grab the first appointment slot that opens up.*

## See also

- [Connect Devices](/how-to/connect-devices) — connect your machines for broader OS-level access
- [Examples](/examples/)
- [Get Started](/get-started/)
