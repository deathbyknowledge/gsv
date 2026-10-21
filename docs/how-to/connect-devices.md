# Connect your devices

This is the distributed part. Each connection becomes part of one computer your Ship can act across — read a file on your home server and push from your laptop in the same breath, even when those computers are asleep.

## Connect a computer

In Chat, choose **+ → connect a computer**, or ask Ship directly. The shortcut fills the composer with editable text; add a name and say whether it runs
macOS, Linux or Windows. Ship can create the invitation and share the install and
`gsv pair CODE` commands for you to run on that computer. If Ship is already installed,
you only need the `gsv pair CODE` command. Tell Ship when it finishes so it can check the connection.

To create the invitation yourself:

1. Open **Work** and click **connect** beside Connections. While Ship's home is the only connection, Chat offers the same panel: open **Ship's home** below the composer and click **+ add a connection**.
2. Enter a name, such as **My macbook**. The connection ID starts as **my-macbook** and follows the name until you edit it yourself.
3. Choose the platform and click **create invitation**.
4. Run the install command on that computer, then the `gsv pair CODE` command. It supplies your Ship, account and connection ID and starts the background daemon.

The invitation lasts ten minutes. You can close the panel and return to it in the
same browser tab. If the connection drops while connecting, run `gsv pair` without
a code to resume. The saved credential lets the CLI recover a lost response.
Once the daemon connects, the connection appears as connected.
While scrolling Work's lists or inspectors, a lavender line marks text clipped
at the top edge. The line and its glow fade gently between lines and rows;
Reduce Motion makes the change immediate.
On phones, Work's page and file reader scroll to the bottom of the visible
screen. Their end padding leaves the last row or line clear of the home indicator.
Work shows compact connection and helper rows on phones. A connection's status square
shows whether it is online; tap the row for details and **browse files**.
Responsibilities and routines open from the activity line above Chat's prompt.
In a connection’s file list, **../** moves up from the
current starting folder and stops at that connection’s filesystem root.
**Chat → + → reference a file** selects a file into your draft in one tap.
A file preview’s **talk about it** control adds its connection and path to your Chat
draft as editable text, keeping existing text and attachments. It sends nothing
until you choose **send**.

## Connect a browser

Ship can also create a browser invitation and give you a download link matched to
your Ship’s release. To get the current public release yourself,
[click here to download the extension](https://gsv.space/browser).

Choose **Browser** in the same flow. Download and unzip the extension, called
**Your Ship**, enable developer mode at `chrome://extensions`, and load its folder.
Click the **Your Ship** icon in the browser toolbar to open its panel. If it is
not visible, click the **Extensions** (puzzle-piece) button and select
**Your Ship**. Paste the invitation and choose **Pair this browser**.

While your Ship works in a tab, Chrome shows a banner at the top of that tab.
That is Chrome's notice that an extension is driving the page; it goes when the
work is done.

For websites you need while your own devices are offline, an enabled operator
can also provide [cloud browsers](/how-to/cloud-browsers). Start one from Work
and sign in directly in its browser view. Ship can show a browser request in Chat
when it needs your help; finishing that request returns control to Ship.

## Try it

With the computer connected, ask Ship things like:

- *What's running on my `<computer>` right now?*
- *Open Spotify.*
- *Set my volume to 20%.*
- *What's on my clipboard?*
- *Take a look at my screen — what am I working on?* (needs screen permissions — see below)

## Permissions

When Ship asks to run a command, Chat and Work show the same approval card. Expand
**show the command** to inspect it, then **full request** for all execution
arguments. Choose **Allow once** to approve it once or **Block** to decline.
Typing **yes** or **no** in the prompt answers too; anything else you write
goes to your Ship as a message and replaces the request.
**Always allow** approves this command and remembers shell access to that
computer for this conversation. Its tooltip explains the scope; other
conversations and helpers still use their own permission rules.

Some actions — reading your screen, controlling apps — need extra permissions from your operating system, not just Ship. Your OS will prompt you the first time Ship tries one; grant what you're comfortable with. You can connect a computer and use the basics without granting these.

## Cancel or reconnect

Cancelling an unused invitation prevents connecting. Closing its panel or
cancelling after the computer connects leaves it connected. A new connection's
credential remains valid until explicitly revoked; pre-existing keys keep
their original expiry. Use **connect again** on an offline connection to reconnect under
its existing ID. **Forget connection** removes the connection and revokes its keys.

From Shell on `gsv`, Ship and its helpers with the corresponding `sys.pair.*` capabilities can use:

```bash
targets pair --name "My laptop" --platform mac
targets pair --name "My browser" --platform browser
targets pair list
targets pair cancel INVITATION_ID
```

Creation returns JSON with the invitation, expiry and setup instructions for this
Ship and release. Invitations belong to the account Ship or the helper acts for. An existing
target requires explicit `--id TARGET_ID --replace`; a pending invitation can be
cancelled before creating another if its code was lost.

## See also

- [Get Started](/get-started/)
- [Connect a Messenger](/how-to/messengers) — reach Ship from your phone via Telegram, Discord, or Slack
- [Architecture: The Adapter Model](/architecture/adapter-model)
