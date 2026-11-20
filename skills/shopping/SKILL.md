---
name: shopping
description: Help the user buy things, from understanding the need through research, three recommendations, purchase, delivery tracking and follow-up. Use whenever the user wants to buy something, find a deal or sale, check or compare prices, compare products, choose a gift, or follow an order.
---

# Shopping

Work through these steps in order. Go back and forth from UNDERSTAND to RESEARCH until ready to move to RECOMMEND. 

UNDERSTAND → RESEARCH → RECOMMEND → BUY → TRACK DELIVERY → CLOSE

- When RECOMMEND gets new input, go back to UNDERSTAND.
- When RECOMMEND gets a decision, move to BUY and open or update a responsibility to follow the order.
- BUY and TRACK DELIVERY are for online purchases only. For an in-store purchase, go from RECOMMEND to CLOSE.

Use the `memory` skill for the personal wiki and the `browser-target` skill for websites. Run `r12y`, `wiki` and `mail` through Shell on `gsv`.

Don't narrate your steps. Only ask and say what is needed to move forward. 

## 1. Understand

Gather what you already know from memory instead of asking again. Start with the general and narrow to the circumstances. Do not ask all of this upfront. Check memory for what you already have, then start RESEARCH. 

When you present the first options, state your assumptions and adjust them to the user's answers. Never assume personal tastes or needs without explicit confirmation. Casual browsing or searching is not evidence of a need or a taste; they may be looking for a friend. Once you understand the need and the timeline, for example a wedding on a known date, create a responsibility so the user remembers to get it.

- **Basics**
  - Are they buying online or in store?
  - Is it for them or for someone else? If someone else, read that person's page in the wiki.
  - Online: does it ship to them, and in time?
  - In store: can the user get there?
  - Are they talking to you through a messenger or in the app? Format your messages for that surface. On a messenger, if the search will take more than a minute, send one short message saying what you are checking and roughly how long it will take. Do not narrate browsers, tools or retries; send results.
- **Tastes**
  - If you can reach their socials: have they saved this product or similar ones?
  - From their buying history: what kind of products do they buy? Price range, quality, whether brand matters.
  - Their style: minimal, romantic, dark? Colors, symbols or affiliations they favor? If you don't know, ask. Do not assume basic or generic before asking. Use each purchase to learn their taste for different objects and contexts.
- **Buying habits**
  - Do they have a budget?
  - Which stores, physical or online, do they favor for this item or this kind of item? Learn and respect their preferences. If they are unhappy with a store, remember it and stop offering it.
- **Purpose**
  - Have they mentioned this product before? Do you know what it is for, and does that change the choice?
- **Specific context**
  - Are they traveling? Is delivery time-sensitive? Is anything else relevant, such as delivery to another address or a gift card included?

```bash
r12y create --title "Find a gift for Ana's wedding" --due 2026-11-21T09:00:00Z --details '{"skill":"shopping"}'
```

## 2. Research

Funnel your search toward three options to present.

- Search as broadly or as narrowly as your information allows. If you know what the user wants, search for details. If you don't know enough yet, search across the range for three options that show the variety available.
- Once the options are presented, read the user's feedback and ask one or two follow-up questions to narrow the search.
- When the price and style range is narrow enough to find three competitive options, research what buyers actually say. Do not trust product descriptions. Read forums, product reviews and comments, and any non-sponsored content about other buyers' real experience.

Present each option in its own message with one image, a brief description and a price range. 
DO NOT OVERCOMPLICATE THE DELIVERY OR NARRATE YOUR WORKAROUNDS TO REACH THIS TEMPLATE. If needed, screenshot the product image or find another solution. Each option should be image-led, short and easy to read.  
Do not give too much detail yet; you are still finding the best candidates. Save the product image to a file and attach it to that message.

Say which stores you checked so the user can judge how complete the search is. Name the stores you could not check, for example ones that block automated visits.

## 3. Recommend

Do not recommend until you are confident you have three options that solve the user's problem. Present each option in its own message with proper embedded images and your notes: 

- What people like about it: one to three bullets.
- What people dislike about it: one to three bullets.
- Alternatives to buy it: send two alternatives described briefly in bullet points with the key information (distance, time it closes when relevant, difference in price etc).

Before recommending, always check that the product is in stock, that the link works, and that the user's preference (size, color, quantity) is available.

Show the full cost. Include delivery costs and free-delivery thresholds, and say when a price is member-only, app-only or depends on a code you could not confirm.

Only recommend and buy what was asked for. Never add items, bundles or upgrades the user did not request.

- If the user likes none of the options, go back to RESEARCH.
- If the user approves one, update the tastes and preferences of the user, or of the person it is for, and move to BUY.

## 4. Buy (online only)

Buy according to the user's preferences.

If none are set, send them the product page and offer to finish the purchase and to create a store account so you can track the delivery for them. As trust builds you may complete purchases and create accounts yourself, but only after the user has explicitly allowed you to do so by default. Record that permission and its scope in their preferences.

A first payment or sign-in on a store is the user's step: follow the `browser-target` skill, which hands it to them in the live browser or through a handoff link.

Once it is bought, update the responsibility to track the delivery, creating one if none exists:

```bash
r12y update ID --json '{"title":"Track delivery: Essie polish from Boozyshop","details":{"skill":"shopping","store":"Boozyshop","order":"<order number>"}}' && \
r12y wait ID --until 2026-11-03T18:00:00Z --blocker "Waiting for delivery"
```

## 5. Track delivery (online only)

- Prefer your own mailbox for order and shipping emails (`mail address` prints it), and notify the user only of updates.
- Be proactive. Check whether delivery is late or something seems off, but always confirm with the user before contacting support or opening a claim.
- Keep the user informed until they receive the item.
- Use their calendar, or what you know about their routine, to tell them ahead of time if they need to be home for the package or should have it delivered somewhere else.

## 6. Close

Close the responsibility after you get feedback on the product and the delivery, and update the user's preferences from it. Do they want to use that store again? Did the person like the gift?

```bash
r12y resolve ID --json '{"outcome":"delivered","feedback":"Liked it; would use the store again"}'
```
