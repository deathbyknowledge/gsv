# Connect your devices

This is the distributed part. Connecting a device turns it into part of one computer your GSV can act across — read a file on your home server and push from your laptop in the same breath, even when those machines are asleep.

## Connect a machine

1. Open **Machines** and click **Connect new machine.**
2. Select the **platform**, give the machine a **name**. The device ID generates automatically. Set how many **days until the connection expires.**
3. Copy the first set of commands and run them in your terminal. You'll be asked for the machine's password — **the install needs admin (sudo) rights.**
4. Click **Next**, copy the second set of commands, and run those too.

::: warning Expect a transient error here
The second step often prints an error at first. Give it a few seconds — the terminal will then confirm it worked. Don't re-run the commands. Once it connects, GSV shows the machine as **online.**
:::

## Try it

With the machine connected, ask your agent things like:

- *What's running on my `<machine>` right now?*
- *Open Spotify.*
- *Set my volume to 20%.*
- *What's on my clipboard?*
- *Take a look at my screen — what am I working on?* (needs screen permissions — see below)

## Permissions

Some actions — reading your screen, controlling apps — need extra permissions from your operating system, not just GSV. Your OS will prompt you the first time an agent tries one; grant what you're comfortable with. You can connect a machine and use the basics without granting these.

## When a connection expires

The connection expires after the number of days you set when adding the machine. To bring it back, connect the machine again the same way — your data persists across reconnects.
## See also

- [Get Started](/get-started/)
- [Connect a Messenger](/how-to/messengers) — reach GSV from your phone via Telegram or Discord
- [Architecture: The Adapter Model](/architecture/adapter-model)
