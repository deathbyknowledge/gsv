---
name: calendar
description: Add events to the owner's calendar, invite people, and read their calendar from a private link. Use for "add this to my calendar", "what's on Thursday", "am I free", or an event file someone sent.
---

# Calendar

Run `cal` and `mail` through `Shell` on target `gsv`; `man cal` has the syntax.
Ship can't edit the owner's calendar directly. It writes an event file and
emails it as an invitation, which the owner's calendar adds; and it reads the
owner's calendar through a private link they share.

## Add Something to the Owner's Calendar

An invitation goes only to the event's guests, so the owner must be a guest.
Use their address from `context.d/10-personal.md`, never Ship's own, and ask
which one if they have several.

```bash
cal add --title "Flight to Palma" --start "2026-11-24 07:45" --end "2026-11-24 10:10" --location "Schiphol" --attendee owner@example.com --out ~/calendar/palma-flight.ics
mail send --invite ~/calendar/palma-flight.ics --subject "Flight to Palma" --message "Your flight, for your calendar."
```

Times read in the owner's time zone unless `--timezone` names another. Keep
the file: to move or call off the event, `cal update` or `cal cancel` it and
send it again, and the calendar replaces the event.

## Invite Other People

Add one `--attendee` per guest, including the owner when they attend. Their
answers come back to Ship's inbox as mail; report who accepted or declined.
Sending asks the owner for approval, which names everyone invited.

## Check It Went

Never pipe `mail send` through `tail`, `head` or another command: that hides
its exit status and error. Read its output, then confirm with
`mail status <delivery-id>`. Say an invite was sent only when the status is
`queued` or `accepted`; on an error, fix it and say what happened.

## Read the Owner's Calendar

Ask the owner for their calendar's private link, which shows Ship every event:

- **Google Calendar**: Settings → the calendar under "Settings for my
  calendars" → **Integrate calendar** → **Secret address in iCal format**.
- **Outlook**: Settings → Calendar → **Shared calendars** → **Publish a
  calendar**, with "can view all details", then copy the ICS link. Work
  accounts may have publishing turned off.
- **iCloud**: share the calendar as a **Public Calendar** and copy the link.
  Anyone with that link can see it, so say so.

The link is a secret: anyone holding it can read the calendar. Keep it in a
private file under your home, such as `~/calendar/links`, never in the wiki,
standing context, a message or a reply. Write a `webcal://` link as `https://`.

Fetch it fresh before answering, since the calendar changes, then show the days
asked about:

```bash
net fetch "https://calendar.example.com/private-link.ics" -o ~/calendar/owner.ics
cal show ~/calendar/owner.ics --from 2026-11-19
cal show ~/calendar/owner.ics --from 2026-11-16 --until 2026-11-22
```

A date stands for its whole day, and `--from` alone shows one day. Repeating
events appear on each of their dates. Google can take a few hours to show a
new event in the link; mention it when something seems missing.

## Event Files Someone Sends

`cal show PATH` reads any calendar file, such as one sent in chat or attached
to mail: its times, guests and a repeating event's next dates. Only the
event's organizer can change it.
