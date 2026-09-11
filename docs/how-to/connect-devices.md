# Connect your devices

This is the distributed part. Connecting a device turns it into part of one computer your GSV can act across — read a file on your home server and push from your laptop in the same breath, even when those machines are asleep.

## Connect a machine

1. Open **Fleet** and click **connect** beside Places, or expand the computer row in your first-day empty state.
2. Enter a name, such as **My macbook**. The target ID starts as **my-macbook** and follows the name until you edit it yourself.
3. Choose the platform and click **create invitation**.
4. Run the install command on that computer, then the `gsv pair CODE` command. It supplies the gateway, account and target identity and starts the background daemon.

The invitation lasts ten minutes. You can close the panel and return to it in the
same browser tab. If the connection drops during pairing, run `gsv pair` without
a code to resume. The saved credential lets the CLI recover a lost response.
Once the daemon connects, the place appears as connected.

## Connect a browser

Choose **Browser** in the same flow. Download and unzip the extension, enable
developer mode at `chrome://extensions`, and load its folder. Paste the invitation
into **Pair this browser** in the extension's options and click **Pair browser**.
The first-day browser row opens this flow too.

## Try it

With the machine connected, ask your agent things like:

- *What's running on my `<machine>` right now?*
- *Open Spotify.*
- *Set my volume to 20%.*
- *What's on my clipboard?*
- *Take a look at my screen — what am I working on?* (needs screen permissions — see below)

## Permissions

Some actions — reading your screen, controlling apps — need extra permissions from your operating system, not just GSV. Your OS will prompt you the first time an agent tries one; grant what you're comfortable with. You can connect a machine and use the basics without granting these.

## Cancel or reconnect

Cancelling an unused invitation prevents enrollment. Closing its panel or
cancelling after enrollment leaves the paired device connected. A new pairing's
device credential remains valid until explicitly revoked; pre-existing keys keep
their original expiry. Use **pair again** on an offline place to reconnect under
its existing ID. **Forget place** removes the place and revokes its device keys.
## See also

- [Get Started](/get-started/)
- [Connect a Messenger](/how-to/messengers) — reach GSV from your phone via WhatsApp, Telegram, Discord, or Slack
- [Architecture: The Adapter Model](/architecture/adapter-model)
