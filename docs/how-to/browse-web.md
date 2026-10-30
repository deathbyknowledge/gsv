# Browse the web

Ship can navigate websites, read pages, take screenshots and fill forms through
a cloud browser or your personal browser connected with the **Your Ship**
extension. Both use the same browsing capability.

## Use a cloud browser

When your operator enables cloud browsers, Ship can
[start a browser in Ship](/how-to/cloud-browsers) for website tasks even when no
personal browser is connected. Ask for the task; Ship checks for a suitable
browser and starts one when needed. Ship reuses your account's current cloud
browser, and website logins are remembered automatically. Click the browser in
Work to watch Ship's cursor and clicks or enter input yourself. Watching and
closing the view leave Ship running.

## Connect your browser

Connecting your personal browser is optional. Use it when you want Ship to work
in its existing tabs and signed-in sessions, or when a site needs a feature
available only in your own browser.

1. In Ship, open **Work** (called Fleet in older versions), click **connect** beside Connections (Places in older versions), and choose **Browser.** Give it a name or leave the default.
2. Download the extension, **Your Ship**, and unzip it. It isn't in the Chrome Web Store yet, so you add it to Chrome in developer mode: open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and pick the unzipped folder.
3. Click its toolbar icon, a pale block on a dark square, paste the invitation from Ship, and choose **connect this browser**.
4. The panel says **Ready** once it's connected. Chrome shows a banner in a tab while your Ship works there; that's normal.

You can close the sidebar after connecting. The extension keeps working while Chrome is open. The browser control stays near the bottom of the sidebar: **Pause** disconnects this browser from Ship until you choose **Resume**. When the panel shows active browser work, **Stop** ends network captures, tab recordings, and debugger sessions, then disconnects. Your connection is saved, so you do not need a new invitation.

## Try it

Ask Ship: *What can you do with my browser extension?*

### Cross-device: fire from your phone, act on your laptop

Text Ship from Telegram while you're away from your desk: *Go to my billing portal and grab this month's invoice.* The browser action runs in your logged-in session on your laptop. This is the one that makes it clear this isn't just a browser agent — the browser is one tool a mind on the edge reaches across the computers it spans.

### Sites with no API, behind your login

Most of the web you actually use has no API and no export button. The extension reaches it because it's your authenticated session — something an external integration can never touch.

- *Pull my latest statement from [billing portal] and save it.*
- *What does the usage number say on my [SaaS] admin dashboard right now?*
- *Submit this expense entry form with these values.*
- *Grab that thread from [private forum] and summarize it.*

### Always-on watching

Ship keeps watching on the edge whether or not you're at your computer. Point it at a page and tell it what to wait for.

- *Check [URL] every hour and tell me when the price drops below $X.*
- *Watch [support ticket] and message me when the status changes.*
- *Keep an eye on [product page] and let me know when it's back in stock.*
- *Monitor [scheduling page] and grab the first appointment slot that opens up.*

## See also

- [Connect Devices](/how-to/connect-devices) — connect your computers for broader OS-level access
- [Examples](/examples/)
- [Get Started](/get-started/)
