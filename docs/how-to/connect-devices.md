# Connect your devices

This is the distributed part. Connecting a device turns it into part of one computer your GSV can act across — read a file on your home server and push from your laptop in the same breath, even when those machines are asleep.

## Connect a machine

You can ask Ship to connect your computer. Give it a name and say whether it runs
macOS, Linux or Windows. Ship can create the invitation and share the install and
`gsv pair CODE` commands for you to run on that computer. If GSV is already installed,
you only need the pairing command. Tell Ship when it finishes so it can check the connection.

To create the invitation yourself:

1. Open **Fleet** and click **connect** beside Places. While your cloud is the only place, Chat offers the same panel: hover **your cloud** below the composer and click **+ connect place**.
2. Enter a name, such as **My macbook**. The target ID starts as **my-macbook** and follows the name until you edit it yourself.
3. Choose the platform and click **create invitation**.
4. Run the install command on that computer, then the `gsv pair CODE` command. It supplies the gateway, account and target identity and starts the background daemon.

The invitation lasts ten minutes. You can close the panel and return to it in the
same browser tab. If the connection drops during pairing, run `gsv pair` without
a code to resume. The saved credential lets the CLI recover a lost response.
Once the daemon connects, the place appears as connected.

## Connect a browser

Ship can also create a browser invitation and give you the extension download.

Choose **Browser** in the same flow. Download and unzip the extension, called
**Your GSV**, enable developer mode at `chrome://extensions`, and load its folder.
Click its toolbar icon to open the panel, paste the invitation, and choose
**Pair this browser**.

While your GSV works in a tab, Chrome shows a banner at the top of that tab.
That is Chrome's notice that an extension is driving the page; it goes when the
work is done.

For websites you need while personal devices are offline, an enabled operator
can also provide [cloud browsers](/how-to/cloud-browsers). Start one from Fleet
and sign in directly in its browser view. Ship can show a browser request in Chat
when it needs your help; finishing that request returns control to Ship.

## Try it

With the machine connected, ask your agent things like:

- *What's running on my `<machine>` right now?*
- *Open Spotify.*
- *Set my volume to 20%.*
- *What's on my clipboard?*
- *Take a look at my screen — what am I working on?* (needs screen permissions — see below)

## Permissions

When GSV asks to run a command, Chat and Fleet show the same approval card. Expand
**show the command** to inspect it, then **full request** for all execution
arguments. Choose **run it** to approve once or **don't** to decline.
**Always allow** approves this command and remembers shell access to that
computer for the requesting process. Its tooltip explains the scope; other
processes still use their own approval rules.

Some actions — reading your screen, controlling apps — need extra permissions from your operating system, not just GSV. Your OS will prompt you the first time an agent tries one; grant what you're comfortable with. You can connect a machine and use the basics without granting these.

## Cancel or reconnect

Cancelling an unused invitation prevents enrollment. Closing its panel or
cancelling after enrollment leaves the paired device connected. A new pairing's
device credential remains valid until explicitly revoked; pre-existing keys keep
their original expiry. Use **pair again** on an offline place to reconnect under
its existing ID. **Forget place** removes the place and revokes its device keys.

From Shell on `gsv`, agents with the corresponding `sys.pair.*` capabilities can use:

```bash
targets pair --name "My laptop" --platform mac
targets pair --name "My browser" --platform browser
targets pair list
targets pair cancel INVITATION_ID
```

Creation returns JSON with the invitation, expiry and setup instructions for this
space and release. Invitations belong to the process's human owner. An existing
target requires explicit `--id TARGET_ID --replace`; a pending invitation can be
cancelled before creating another if its code was lost.

## See also

- [Get Started](/get-started/)
- [Connect a Messenger](/how-to/messengers) — reach GSV from your phone via Telegram, Discord, or Slack
- [Architecture: The Adapter Model](/architecture/adapter-model)
