# Keep Your Ship's Identity with a Recovery Sheet

Your Ship's identity on the open network is how the people you're connected
with know it's you. A recovery sheet is a piece of paper that keeps that
identity yours, even if your Ship's host can't help.

- If your Ship ever moves to another host, the sheet takes its identity with
  it, so the people you're connected with keep reaching you.
- If someone changes your Ship's identity without asking you, the sheet can
  undo the change within 3 days.
- Anyone who has the sheet can take your Ship's identity. Keep it somewhere
  safe, as you would a passport.

## Make a sheet

**Settings → Recovery sheet** appears once your Ship has its identity on the
open network. Your Ship creates it the first time it reaches out: when you
publish, invite someone or send a message request. Making a sheet never creates
an identity. It takes about five minutes, and you need a printer, or a pen and
paper.

1. Choose **make a recovery sheet**, read the warnings and choose **show my
   sheet**. Your browser makes the sheet: 12 words, a QR code and a sheet code.
2. Choose **print**, or write the 12 words down by hand. Then choose **it’s on
   paper**.
3. Type words 3, 7 and 11 from your sheet and choose **check**.
4. Type your password and choose **continue**. Type the code we email you and
   choose **finish**.

The words appear only this once. Your browser sends your Ship only the sheet's
public half; the words and the key never leave it. Don't photograph the sheet,
and don't keep it in email, notes or a chat, including your chat with your
Ship. Your Ship and your host will never ask you for the words. If they ever
appear in a chat, make a new sheet.

## After you make it

Settings shows your sheet's code and the day you made it. The sheet code is
printed on the sheet too, so you can tell which sheet is current. It's safe to
share.

We email you whenever your sheet changes, with the sheet code. If you didn't
make the change, reply to that email straight away. For 3 days, a host that
keeps a recovery key can undo the change, and so can your previous sheet, if you
had one. Operators set up that key, `GSV_PLC_RECOVERY_KEY`, when they
[run Ship](operate-gsv.md); only identities created while it's set list it.

## Make a new sheet, or remove it

Make a new sheet if you lost yours or someone else may have seen it. For 3 days
your old sheet can still undo the change; after that it stops working.

Removing the sheet leaves your Ship's identity in your host's hands again. For
3 days your current sheet can still undo the removal.

Both take your password and a new emailed code.

## If something stops you

- **The password isn't right.** Wrong passwords here count with the ones you
  type to sign in. After five in a row, wait until the time Settings shows: 30
  seconds at first, then longer after each wrong one. Until then no password is
  checked, even the right one.
- **The code isn't right or has expired.** A code works once, for 10 minutes,
  and five wrong tries use it up. Continue to get a new one; we send at most one
  a minute and five an hour.
- **There's no email address to send a code to.** Add and verify an email
  address for your account first.

If your host runs Ship without email at all, your password alone confirms a
change. Anywhere else, a change without its emailed code is refused.

## Resets and deletion

A reset gives your Ship a new identity on the open network. Your sheet stays
with the old one, so make a new sheet afterwards. Deleting your Ship ends its
identity on the open network; for 3 days the sheet can still undo that.

## For experts: using the sheet

The QR code holds the sheet's private key as a multikey: `z` and the
base58btc encoding of the P-256 private key multicodec, `0x1306`, followed by
the key's 32 bytes. Tools that sign PLC operations, such as Bluesky's `goat`,
read keys in this form. The 12 words hold the same key, by the derivation in
[The open network](../architecture/open-network.md#recovery-sheets).

The identity is a `did:plc` and the sheet's key is first among its rotation
keys. Within 72 hours of a change, the sheet can undo it by signing an
operation on the one before that change. It can also move the identity by
signing an operation that names another host and its signing key.
