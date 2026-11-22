# Assistant handbook

The exact steps for what a person might ask an assistant how to do, in the words
and pictures the app shows. An assistant reads this before answering a "how do I"
question, and answers from it instead of from memory. `docs/assistant-runbook.md`
says who an assistant is and what it may do; this says how the app works.

Nothing here is read by a shopper, but everything is written the way an assistant
would say it: plain words, short steps, the product's own vocabulary ("lándlet",
always, with the accent).

## How an entry is written

Every entry has the same parts, in this order, so the next chapter can be copied
from this one and a test can check them:

- **A title that is the person's question**, ending in a question mark.
- **Numbered steps.** Each step names the control by the words on it, in quotes
  ("Add item"), or by what it looks like when it has no words (the round logo, the world
  itself). It says what to tap, not where the code keeps it. Where the app's own
  words are not yet spelled the way the product spells them, quote only the part
  that is, so the step stays true when the spelling is fixed.
- **`**You will see:**`** one or two sentences on what changes on screen after the
  last step.
- **`**If something goes wrong:**`** two or three bullets: what commonly goes
  wrong and what to do. Where the app says something, say what it says. Where it
  does not, do not invent: tell the person to read out what they see, and offer to
  pass it to the team (the runbook's "not sure" rule).
- **A controls block** (a fenced block whose first line is `controls` and a mode),
  one control per line as `selector | words`. Every control the steps name is
  listed with the words it must still carry. `scripts/assistant-handbook-lib.mjs`
  checks that the entry's text names each one, and
  `e2e/assistant-handbook-controls.test.mjs` opens the real app at 390x844 and
  fails when a listed control is gone or no longer carries those words. The mode
  is where the control lives: `any`, `shop`, `build` or `sell`, or `sell-row` for a
  button that only exists once one of the seller's own products is opened in "My
  products" (the test uploads one and opens it).

- **Screens built while the app runs** (a button that appears next to each friend,
  say) cannot be listed, because they are not on the page until someone opens them.
  Name them in the steps, keep those steps short, and walk them again when that
  screen changes.
- **A control with nothing written on it** (a pad, a picture): the steps describe what
  it looks like, and its controls line says `(no words)`; the test then checks only
  that it is on the page.

**When you change the interface:** a button you rename, move or remove has to be
fixed here in the same pull request. Find it by its old words or selector in this
file, change the steps and the controls line together, and run
`e2e/assistant-handbook-controls.test.mjs`. If a step is no longer true and you
cannot rewrite it, delete the entry rather than leave it wrong: an assistant with
no entry says it is unsure, which is better than a confident wrong answer.

Money, identity and an account's standing are not explained here. An entry that
touches one ends by sending the assistant to the runbook's hand-off.

## Arriving and your account

### How do I sign up for an account?

1. Tap the round higglehaven logo at the top left (the head of the flower; the word Menu sits beside it until it has been opened once). When nobody is signed in, the first picture along the top says "Log in / Sign up"; tap it.
2. Tap the "Sign up" tab.
3. Fill in "Username" (the name other people see), "Email" and "Password (8+ characters)".
4. Tick "I confirm I am at least 18 years old". Nobody under 18 can have an account.
5. Tap "Sign up".

**You will see:** the window closes, and the first leaf of the menu now shows the person's username instead of "Log in / Sign up". Tapping it opens their account. A verification email is sent to the address they gave.

**If something goes wrong:**
- The app says "Account created, but the verification email failed to send": the account exists; in their account panel, "Resend verification email" sends it again.
- The app says what is wrong with a field (a username or email already taken, a password under 8 characters): read it out and fix that field.
- Signing up is enough for shopping. The first time they go into Build or Sell, a "Verify to continue" screen asks for more; the next entry covers it.
- Nothing happens, or the screen looks different from this: ask what they see, and offer to pass it to the team.

```controls any
#auth-tabs [data-auth-view="signup"] | Sign up
#auth-signup-form label:nth-of-type(1) | Username
#auth-signup-form label:nth-of-type(2) | Email
#auth-signup-form label:nth-of-type(3) | Password (8+ characters)
#auth-signup-form .auth-checkbox-label | I confirm I am at least 18 years old
#auth-signup-form button[type="submit"] | Sign up
```

### How do I log in, or get back in if I forgot my password?

1. Tap the round higglehaven logo at the top left (the head of the flower; the word Menu sits beside it until it has been opened once), then "Log in / Sign up". The "Log in" tab is the first one.
2. Fill in "Email" and "Password", then tap "Log in".
3. If they forgot the password, tap "Forgot password?" instead, type their email and tap "Send reset link".
4. The email carries a link. It opens a screen that says "Choose a new password": type one (8 or more characters) and tap "Reset password".

**You will see:** after "Log in", the menu shows their username. After "Send reset link", the app says "If that email has an account, a reset link was sent." (it says the same whether or not the address has an account). After "Reset password", it says "Password reset! You can log in with your new password now." and they log in with the new one.

**If something goes wrong:**
- The email does not arrive: ask them to look in their spam folder, and to check they typed the address they signed up with.
- A wrong email or password: the app says so; try again or use "Forgot password?".
- They cannot get in after resetting, or the app says something about their account's standing: do not guess, use the runbook's hand-off.

```controls any
#auth-tabs [data-auth-view="login"] | Log in
#auth-login-form label:nth-of-type(1) | Email
#auth-login-form button[type="submit"] | Log in
#auth-forgot-btn | Forgot password?
#auth-forgot-form button[type="submit"] | Send reset link
#auth-reset-form button[type="submit"] | Reset password
```

### Why am I asked to confirm I am 18, and how do I verify?

1. The first time a signed-in person goes into Build or Sell, a "Verify to continue" screen asks for proof they are 18 or older. It is asked once, not every time. Someone who ticked "I confirm I am at least 18 years old" when they signed up is not asked to tick it again and goes straight to the proof: a credit card or a government ID. Only an account that never ticked it sees the tick first.
2. If the tick is shown, they tick "I confirm I am at least 18 years old" and tap "Continue".
3. On the card step, they enter a credit card. A card is never charged; only its type is checked. Credit cards are only issued to adults, which is why they count as proof of age. Debit, prepaid and gift cards (Apple Cash and Cash App included) are not accepted, because people under 18 can hold them.
4. With no credit card, they tap "Verify with a government ID instead" (the button says "No credit card? Verify with a government ID instead") and follow the steps on the screen that opens. That check is done by the identity service on its own screen, never in the chat.
5. "Log out instead" leaves the screen without verifying.

**You will see:** once verified, the screen closes and they carry on into Build or Sell.

**If something goes wrong:**
- The card is refused. The screen says why in plain words (the card has expired, the number or security code does not look right, the bank did not confirm, or it was declined because prepaid, debit and gift cards are not accepted) and always ends with "Nothing was charged". Read the reason back, and offer another credit card or the government ID way in.
- The ID check will not finish, or they are stuck on this screen: do not guess what is wrong with the check or their account, use the runbook's hand-off.
- Never ask for a card number or ID details in the chat.

```controls any
#verify-modal h2 | Verify to continue
#verify-age-step .auth-checkbox-label | I confirm I am at least 18 years old
#verify-continue-btn | Continue
#verify-id-instead-btn | Verify with a government ID instead
#verify-logout-btn | Log out instead
```

### Where is Settings, and what is in each tab?

1. Tap the round higglehaven logo at the top left (the head of the flower; the word Menu sits beside it until it has been opened once), then "Settings".
2. Tabs run across the top: "General", "Shop" and "Build".
3. "General" holds "Units" (Meters or Feet), "Version", "Show tips while the app opens" (a tick box, on unless they turn it off; it applies on this device only), and "Notifications" (an option to be emailed when one of their placed products sells out). If they have started selling, the tax paperwork is here too.
4. "Shop" holds "Controls", which reminds them how to walk, look and fly, and "My avatars" and "My animations" once they own any.
5. "Build" holds the settings for building, including the person's username (with "Rename"). Selling has no tab here: the payout account and the shop name are petals in the Sell menu (see "Where do I set up payouts and tax forms?").
6. At the bottom of every tab is "Send feedback".
7. The "×" at the top right closes Settings.

**You will see:** a window with the tab they chose; the tab's name is highlighted.

**If something goes wrong:**
- A setting they describe is not in the tab named here: ask what they see, and offer to pass it to the team.
- Anything about tax figures, amounts or payouts is not for the assistant: use the runbook's hand-off.

```controls any
#settings-btn | Settings
#settings-tabs [data-section="general"] | General
#settings-tabs [data-section="shop"] | Shop
#settings-tabs [data-section="build"] | Build
#settings-feedback-btn | Send feedback
#settings-close-btn | Close
```

### What do "Notices" and "My lándlets" say when there is nothing in them?

1. Tap the round logo at the top left to open the menu, then tap "Notices" or "My lándlets".
2. A person with nothing to read in "Notices" sees "Nothing new. Updates about your products, your lándlet and your account will show up here."
3. A person who has not claimed a lándlet sees, in "My lándlets", "You don't own a lándlet yet. Claim one in Build mode to start building." (The steps for claiming are in "How do I get my own lándlet?".)

**You will see:** one plain sentence saying what will appear there. An empty list is not a fault.

**If something goes wrong:**
- The sentence is different from what is described here: ask what they see, and offer to pass it to the team.

```controls any
#notifications-btn | Notices
#my-lands-btn | My lándlets
```

### How do I wear an avatar I bought, or apply an animation?

1. Tap the round higglehaven logo at the top left (the head of the flower; the word Menu sits beside it until it has been opened once), then "Settings", then the "Shop" tab.
2. Under "My avatars", each avatar they own is a row, and the first row is always "Default avatar". Tap "Equip" on the one they want.
3. Under "My animations", tap "Apply" on an animation to use it with the avatar they are wearing, or "Clear" to take it off.

**You will see:** their character in the world changes to the avatar. The row they chose says it is equipped.

**What it does when it moves:** every avatar walks, stands and flies with a simple
motion of its own, so none of them glides. The starting avatar swings its legs and
arms. An avatar that carries no motion of its own gets a small bob and lean. An
avatar that carries its own motion uses that. An animation they apply under "My
Animations" replaces the simple motion, so a bought animation is a different
motion, not the only way to move. Other people see the same.

**If something goes wrong:**
- "My avatars" or "My animations" is not on the tab: they own none yet, so the section is not drawn. Where to buy one is in "How do I buy something?".
- A message says it couldn't equip the avatar: read it out; try once more, then offer to pass it to the team.
- An animation that does not suit the avatar is marked as not matching: the app says so next to it. Read that note out rather than guessing.

```controls any
#settings-tabs [data-section="shop"] | Shop
```

### How do I send feedback about a problem?

1. Tap the round higglehaven logo at the top left (the head of the flower; the word Menu sits beside it until it has been opened once), then "Settings".
2. Tap "Send feedback" at the bottom.
3. A window titled "Submit feedback" shows a picture of what they were looking at. In the box under "Describe what happened (optional)", say what went wrong, in as much detail as they like.
4. Tap "Submit". "Cancel" closes it without sending.

**You will see:** the app says "Thanks! Your feedback was submitted." and the window closes by itself.

**If something goes wrong:**
- It says it couldn't send: read the words out and ask them to try again in a minute.
- They would rather talk it through: they can also leave a message here in the assistant window, and the assistant can pass it to the team.

```controls any
#settings-feedback-btn | Send feedback
#feedback-modal h2 | Submit feedback
#feedback-modal label | Describe what happened (optional)
#feedback-submit-btn | Submit
#feedback-cancel-btn | Cancel
```

### How do I change my password or log out?

1. Tap the round higglehaven logo at the top left (the head of the flower; the word Menu sits beside it until it has been opened once), then tap their username (the first picture along the top) to open "Account".
2. To change the password, tap "Change password". Fill in "Current password" and "New password (8+ characters)" and tap "Change password" again. This signs them out of every other device, but keeps this one signed in.
3. To log out, tap "Log out".

**You will see:** after a password change, the app says "Your password has been changed. You have been signed out of your other devices." After "Log out", the first leaf of the menu says "Log in / Sign up" again.

**If something goes wrong:**
- The app says the current password is wrong: they can log out and use "Forgot password?" from the log in screen.
- The same panel also has "Change email" and "Download my data". "Delete account" is permanent and cannot be undone: only describe where it is if asked, and never suggest it. Anything about an account's standing goes to the runbook's hand-off.

```controls any
#auth-change-password-btn | Change password
#auth-change-password-form button[type="submit"] | Change password
#auth-logout-btn | Log out
#auth-change-email-btn | Change email
#auth-export-data-btn | Download my data
```

## Getting around and Shop

### What is higglehaven, and what can I do here?

1. higglehaven is a world you walk around in. The lándlets, items and products in it
   are made by the people who use it.
2. In "Shop" you walk the world, look at products and buy them.
3. In "Build" you claim a lándlet of your own and fill it with items.
4. In "Sell" you put your own products up for sale.
5. The round logo at the top left (the bud) is the menu. It opens "Shop", "Build"
   and "Sell", your account, and "Help", which holds these pages and a way to ask an
   assistant.

**You will see:** the world, with only the bud on top of it. Tap the bud to see
everything else.

**If something goes wrong:**
- Someone asks about something this does not cover: use the other entries in this
  handbook, and if none fits, say so and offer to pass the question to the team.

```controls any
.mode-nav-btn[data-mode="shop"] | Shop
.mode-nav-btn[data-mode="build"] | Build
.mode-nav-btn[data-mode="sell"] | Sell
#bud-petal-row-help | Help
```

### How do I go between Shop, Build and Sell?

1. Tap the round logo at the top left (the bud).
2. Three petals grow out of it in an arc: "Shop", "Build" and "Sell". The place you
   are in is shaded green. A row of four small pictures also opens along the top (your name,
   Notices, Settings and "Help"), and the menu of the place you are in opens below the petals.
3. Tap the place you want. Tapping the place you are already in does nothing more, because its menu
   is already open.

**You will see:** a petal for another place turns green at once and the petals stay out while that
place loads; when it is on screen they fold back into the bud. Tapping the place you are already in
a menu is open below them: the one for the place you are in (Build's has "Add item", "Levels", "Tools" and so on; Sell's has "My
products", "Add a product", "Payouts", "Storefront" and "Orders"; Shop's has "Friends", "My purchases", "Chat" and "Nearby"). Each place has its own menu, and it is the same every time. The row along the top
(your name, Notices, Settings and "Help") is the same in all three places.

**If something goes wrong:**
- The petals are not there: the bud is folded. Tap the round logo once.
- A tool someone is looking for is not in the menu that opened: it lives in its own place's menu
  (for example "Add item" is in Build's menu, and "Friends" is in Shop's). Go to that place with its petal.
- Tapping the round logo again, or tapping the world, folds everything away: that is expected.

```controls any
.mode-nav-btn[data-mode="shop"] | Shop
.mode-nav-btn[data-mode="build"] | Build
```

### How do I walk around and look around?

1. To walk, put a finger on the left half of the screen and drag it in the
   direction you want to go. The further you drag, the faster you move.
2. To look around, put a finger on the right half of the screen and drag it to turn
   the view. You can do this standing still, and you can do both at once, one thumb
   on each side.
3. Lift your finger and you stop. There are no buttons to find: the world itself is
   the control.
4. On a computer, use the keyboard: W, A, S and D (or the arrow keys) walk, Q and E
   turn, R looks up and F looks down, and double-pressing the space bar takes off or
   comes back down (the flying entry says more). The mouse wheel zooms in and out.
   With a mouse you can also hold the left button on the world and drag to look
   around.

**You will see:** your bird walks or turns as you drag, and the view follows. Every
avatar has a simple motion of its own for walking, standing and flying: the
starting bird swings its legs and arms as it walks, and an avatar you have bought
that carries no motion of its own gets a small bob and lean instead of sliding. An
animation you have applied (see the avatar entry below) replaces that motion.

**If something goes wrong:**
- Nothing moves: a quick tap does not move you, so keep the finger down and drag a
  little further, then try again.
- Looking needs two fingers at once, so it can be awkward with one thumb: rest the
  first finger anywhere and turn with the second.
- You want to go up in the air: see the flying entry below.

```controls shop
#app | (no words)
```

### How do I fly, go up and come back down?

1. You start each visit in the air. To come down, double-tap the world: two quick
   taps in the same place. It works while your other thumb is walking or looking,
   so you do not have to stop first. On a keyboard, press T once instead.
2. While you are flying, you go where the view points. To climb, drag on the
   right half of the screen to look up, and drag on the left half to walk
   forward. To descend, look down and walk forward. A level view flies level,
   and when you stop walking you hold your height. On a keyboard, R looks up and
   F looks down.
3. Walk and look by dragging, as usual.
4. To go up again from the ground, double-tap the world again, or press T.

**You will see:** the bird tips its nose up or down with your view, and a
double-tap switches between flying and standing. At the top of the sky, or as low
as you can fly, a short note says so and you stay there.

**If something goes wrong:**
- You do not climb: you are on the ground. Double-tap the world to fly.
- A double-tap on a product opens that product instead: double-tap on open ground.
- You cannot find the ground: double-tap the world and let it come down by itself.

```controls shop
#app | (no words)
```

### How do I get back to where I was?

1. When you arrive, look near the top of the screen for a button that says "Go to
   Last Location". It shows only when the app has a last place on record for you.
2. Tap it. Your bird fades out, comes back above the place you were last, and comes
   down.

**You will see:** the bird reappears above your last spot and settles onto the
ground.

**If something goes wrong:**
- The button is not there: it goes away on its own as soon as you start moving, and
  it does not show when the app has no last place for you. There is no way to bring
  it back until the next time you arrive.

```controls shop
#shop-last-location-btn | Go to last location
```

### How do I look at a product and read about it?

1. Walk or fly to a product somewhere in the world and tap it.
2. A small card blooms beside the product with its name, its price and any notes
   about it (for example that it ships to the United States only, or that it has no
   returns).
3. When the product is for sale and you are standing near it, the card has a yellow
   "Buy" button. "More" opens "Rate this product" and "Return policy".
4. Tap anywhere else in the world, or the cross at the top right of the card, when
   you are done.
5. Without tapping (on a keyboard, or with a screen reader): press N to open the card
   of the nearest product, and N again for the next nearest; Shift and N go back. The
   product's name is read out, and Tab reaches the card's buttons. Escape closes it.
6. Without a keyboard (a screen reader on a phone): tap the round logo at the top left,
   tap the "Shop" petal, then tap "Nearby". The box lists the products within reach, the
   nearest first, each with how far away it is; tap one to open its card.

**You will see:** a small card next to the product, with the world still moving
behind it.

**If something goes wrong:**
- Nothing opens when tapping: you may have tapped the ground beside it. Tap the
  product itself, or move closer.
- The card has no "Buy" button: it says why in a line of its own. "Walk closer to buy
  this." means to go up to the product. "Out of stock." and "Not for sale." mean it
  cannot be bought right now.
- "Return policy" tells the person what the seller says about returns, which can
  differ by product. Read it with them, and do not promise more than it says.

```controls any
#product-card-more-btn | More
#product-card-review-btn | Rate this product
#product-card-buy-btn | Buy
#product-card-return-policy-btn | Return policy
#bud-petal-shop-nearby | Nearby
```

### How do I buy something?

1. Open the product's card (see the entry above) and tap "Buy".
2. A sheet titled "Checkout" shows what you are buying. Enter your card in the card
   box.
3. Tap "Pay".

**You will see:** the sheet closes when the payment goes through, and the product
shows under "My purchases".

**If something goes wrong:**
- A sheet titled "Verify to continue" appears instead. It is the adult check: it asks
  the person for proof they are 18 or older (a credit card, or a government ID instead).
  It is shown once, and the tick to confirm they are at least 18 only appears if they never
  gave it when signing up. They tap "Continue" once they have. If it will not complete, use the runbook's hand-off. The
  person can also tap "Log out instead".
- The payment fails, the person is charged twice, or they want a refund: that is
  money. Say plainly that you cannot do it yourself, say you are sending it to the
  team, and use the runbook's hand-off.

```controls any
#product-card-buy-btn | Buy
#checkout-modal-title | Checkout
#checkout-pay-btn | Pay
#verify-modal h2 | Verify to continue
label:has(#verify-age-attest) | at least 18
#verify-continue-btn | Continue
#verify-logout-btn | Log out instead
```

### Where are the things I bought, and how do I rate a seller?

1. Tap the round higglehaven logo at the top left (the head of the flower; the word Menu sits beside it until it has been opened once) ("Account menu"). A row of pictures opens along the top
   with your name, "Notices", "Settings" and "Help", and (in Shop) a stem of leaves opens below the petals with "Friends", "My purchases", "Chat" and "Nearby".
2. Tap "My purchases".
3. Each purchase has a "Rate this seller" button and a "Rate this product" button. Tap one to rate
   the seller or the product for that purchase. Once given, the rating shows under the purchase
   with buttons to edit or delete it.

**You will see:** a list of what you bought. Someone who has bought nothing yet sees
"You haven't bought anything yet. Tap a product in Shop mode to buy it, and your orders will be listed here."

**If something goes wrong:**
- The list is empty but they remember buying: ask which account they are signed in
  as; another account would have a different list. If it still looks wrong, use the
  runbook's hand-off, because a missing purchase is a money question.
- Rating a seller is for after they have had the item, so it is offered here, not at
  checkout.

```controls any
#account-menu-toggle | Account menu
#my-purchases-btn | My purchases
#my-purchases-empty | You haven't bought anything yet. Tap a product in Shop mode to buy it, and your orders will be listed here.
```

### How do I leave a review for a product?

A product is rated from a purchase: one rating for each thing someone bought.

1. Open the account menu and tap "My purchases", then tap "Rate this product" under the purchase.
2. Choose a rating from 1 to 5 stars (5 is chosen to begin with), add a comment if you want (it is
   optional), and tap "Save product rating".

The product's card also offers "Rate this product" (under "More") when that person has a purchase
of that product they have not rated yet; it opens a sheet titled "Review this product". They tap a
rating, write a comment if they want, and tap "Post review". If they have no unrated purchase of it,
the card does not offer it.

**You will see:** the rating shown under the purchase and on the product.

**If something goes wrong:**
- No "Rate this product" button on a purchase: it is already rated, was refunded, or the product
  has since been removed. They can edit or delete a rating they gave under that purchase.
- A product they never bought cannot be rated.
- The review sheet on the card says to choose a star rating from 1 to 5: tap one of the star choices;
  to back out, tap "Cancel".

```controls any
#product-card-review-btn | Rate this product
#product-review-modal-title | Review this product
#product-review-save-btn | Post review
#product-review-cancel-btn | Cancel
```

### What are the glowing orbs, and what if I hit the limit?

1. Glowing orbs float around the world. Walk or fly into one to collect it.
2. A short word, "Credit +1", shows beside the round logo at the top left (the Account menu button) for a moment
   and goes by itself. Credits are free and are used when you make a model from a picture or a
   description in Build.
3. There is a limit on how many you can collect in a short time. When you reach it, the word
   "Orb limit" shows beside the logo. Tap it to read how many you can collect and in how long you
   can collect more, for example "You can collect up to 20 orbs every 15 minutes. Try again in
   about 7 minutes." The numbers can change, so go by what your own screen says.

**You will see:** a short word beside the round logo when you collect an orb, and, when you reach
the limit, the word "Orb limit" that stays until you have opened it and closed it again.

**If something goes wrong:**
- "Orb missed" beside the logo: tap it to read why. Usually "Someone else collected that orb just
  before you." Another person got there first. Try the next orb.
- "Offline" beside the logo: tap it. "Can't collect orbs right now. You appear to be offline."
  Their connection has dropped. Ask them to check it and try again.
- To dismiss one of these, tap its word to open it, then tap the small cross at the top right of
  what opened.

```controls any
#account-menu-toggle | Account menu
```

### How do I chat with people nearby?

1. Tap the round logo at the top left (the bud), then tap the "Shop" petal (Shop's own menu opens
   with it; "Chat" is in it), then tap "Chat". A small chat box opens
   with a cross at its top right to close it.
2. Type in the box that says "Say something nearby…" and tap "Send".
3. People close to you see it. Their messages show in the same box.
4. If you have muted someone, "Muted" with a number shows above the box. Tap it to
   see who.

**You will see:** your message appears in the box, and messages from people near you
appear in the same box. With nobody having spoken yet the box says: Nobody has said anything nearby yet. What you type here is seen by people close to you.

**If something goes wrong:**
- The box says chatting opens once their ID is verified: nearby chat, like direct
  messages and voice, is only for people whose age and identity the app has checked.
  Do not explain the rules: if they want to know how to get verified, use the
  runbook's hand-off.
- Someone is bothering them: they can mute that person from the box. For harassment,
  use the runbook's hand-off.

```controls any
#bud-petal-shop-chat | Chat
#shop-nearby-chat-input | Say something nearby
#shop-nearby-chat-panel button[type="submit"] | Send
#shop-nearby-chat-muted-toggle | Muted
```

### How do I talk to people nearby by voice?

1. Tap the round logo at the top left (the bud), tap the "Shop" petal, tap "Chat", and tap the
   microphone button in the box that opens. Its label reads "Unmute microphone" while you are
   muted.
2. Your phone asks for permission to use the microphone. Allow it.
3. The button shows what your microphone is doing right now. Tap it again to mute
   yourself. While your microphone is on, the logo says "Mic on": tap that to get back
   to the box.
4. People close to you can hear you, and you can hear them; voices get quieter the
   further away they are.

**You will see:** the button changes to show you are unmuted, and again while you
are speaking.

**If something goes wrong:**
- The box says chatting opens once their ID is verified, with no microphone button: like nearby chat, voice is only for people whose age
  and identity the app has checked. Use the runbook's hand-off if they ask how to
  get verified.
- The button shows the microphone is blocked: the phone's own settings are stopping
  it. They need to allow the microphone for this site in their browser's settings.
  You cannot do that for them.

```controls any
#shop-voice-btn | microphone
```

### How do I add a friend and send them a message?

To offer friendship to someone standing near you in Shop: tap their avatar, then
"Send request" in the box that asks. Nothing to type. (If you change your mind, "Not now".)

To add someone who is not nearby:

1. Tap the round higglehaven logo at the top left (the head of the flower; the word Menu sits beside it until it has been opened once) ("Account menu"), then "Friends" (it is in Shop's menu, so be in Shop first).
2. Tap "+ Add friend". A small box asks for the friend's name. Type it exactly as
   their name is written, then tap "Save".
3. They get your request. When they accept, they show in your list.
4. To write to an accepted friend, tap "Message" beside their name, type in the box
   that says "Message…" and tap "Send".

**You will see:** your friend's name in the list once they accept, and a thread with
your messages when you tap "Message". Until then the panel says "No friends yet. Tap + Add friend to invite someone by name."

**If something goes wrong:**
- The panel says there is no one by that name: the name has to match exactly. Ask
  them to read it out from their own screen.
- A request for you shows with "Accept" and "Decline" buttons.
- To stop hearing from someone, tap "Block this person" in their thread. They are
  not told. For anything worse, use the runbook's hand-off.
- Like chat and voice, messages are only for people whose age and identity the app
  has checked.
- "Show map" in the Friends panel shows where friends are.

```controls any
#account-menu-toggle | Account menu
#friends-btn | Friends
#friends-add-btn | + Add friend
#friends-map-btn | Show map
#friends-panel-empty | No friends yet. Tap + Add friend to invite someone by name.
```

### How do I talk to an assistant?

1. Tap an assistant's bird in the world, or tap the round logo (the bud), then "Help",
   then "Ask an assistant".
2. A small window opens once your earlier messages are in it (a moment after the tap, while the
   "Ask an assistant" row or the bud shows it is working). Type in the box that says "Ask a question…" and tap "Send".
3. An assistant answers there. Keep going in the same window.
4. To tuck it away without ending the chat, tap the minus at the top right of the
   window ("Minimise"). While it is tucked away the little bud in the corner shows
   the assistant's name, with a dot once they have replied. To bring it back, tap
   that name beside the bud (one tap, and the conversation opens at the newest
   message), or tap the bud, then "Assistant". To end the chat, tap the cross ("End the conversation
   and close").

**You will see:** a window at the bottom of the screen with your message and the
assistant's replies, each labelled with who wrote it.
The message box starts one line tall and grows as you type, up to about five lines. On a phone the keyboard's Enter key starts a new line, and "Send" sends; with a computer keyboard, Enter sends and Shift+Enter starts a new line. A message can be up to 280 characters, and the window says so when you reach it.

**If something goes wrong:**
- The window opens and says "We couldn't load your conversation. Check your connection and try
  again." with a "Try again" button: nothing is lost, the messages are just not loaded yet.
- No assistant is free: the window says so, and the message waits in line. It is
  answered when one is free.
- The assistant is on shift but somewhere else in the world: a line at the top of the window says which lándlet she is standing on, with a "Take me there" button that walks them to her. The line is not shown when she is close by or off shift.
- To stop an assistant from contacting them, tap "Block" in the window.
- Assistants are AI helpers, and the window says so. They cannot do anything to an
  account; for money, an account's standing, or a report about someone, they send it
  to the team.

```controls any
#bud-petal-row-help | Help
#assistant-chat-input | Ask a question
#assistant-chat-send | Send
#assistant-chat-minimize | Minimise
#assistant-chat-close | End the conversation
#assistant-chat-block | Block
```

## Build

### How do I get my own lándlet?

1. Tap the round logo at the top left (the bud). Three petals grow out of it:
   "Shop", "Build" and "Sell". Tap "Build".
2. The first time, a sheet opens with the title "Claim a lándlet" and a small map.
   Green squares are "Available", grey are "Claimed", blue is "Water".
3. Tap an available green square on the map. The line under the map names it and
   its size, and the "Claim" button turns on.
4. Tap "Claim". The sheet closes and you are standing on your own lándlet.

**You will see:** the sheet goes away and you are standing on your own lándlet. The
top left is the small round bud with the higglehaven logo: tap it and it unfolds.
"Add item", "Levels", "Tools" and, once you have done something, "Undo" and "Redo"
are inside it: tap the Build petal to see them (the bud opens on the menu of the place you are in, and each place keeps its own tools in its own menu).

**If something goes wrong:**
- The line under the map says "No lándlets are ready to claim yet — check back
  again shortly." Tap "Refresh" after a moment. If it stays that way, offer to
  pass it to the team.
- The "Claim" button stays off: nothing is chosen yet. Tap a green square first.
- The sheet says you can only claim one lándlet. Choose carefully before tapping
  "Claim".

```controls any
.mode-nav-btn[data-mode="build"] | Build
#claim-modal h2 | Claim a lándlet
#claim-confirm-btn | Claim
#claim-refresh-btn | Refresh
```

### How do I add an item to my lándlet?

1. In Build, tap the small round bud with the higglehaven logo at the top left,
   then the Build petal, then tap "Add item". A short strip opens at the bottom: a "Search" box and a
   row of items to swipe, the ones used most recently first.
2. Swipe along the row, or type in the "Search" box. For the whole list, tap
   "All items": a wider panel opens with the "Search" box and, on the same row,
   "All", "Products" and "Bundles", which narrow it to everything, single items
   or saved bundles. The items scroll underneath; "Manual" and "Prompt" are at
   the top, beside the close button.
3. Tap an item's name. The list closes and the top of the screen says "Tap a spot
   to place" and the item's name.
4. Tap the ground where you want it.

**You will see:** the item stands where you tapped and is already selected, with a
a small card beside it that has "Copy", "Delete" and "More", and a ring around it.

**If something goes wrong:**
- The search finds nothing: the list says No products match what they typed, and then: Try fewer letters, or clear the search to see everything.
- Changed your mind before tapping the ground: the "Add item" petal in the bud
  now reads "Cancel placing". Tap the bud, then the Build petal, then that.
- The item is not where you wanted. It is selected, so drag it (below), or tap
  the round logo button at the top left, the Build petal, then "Undo" to take it back.
- Nothing seems to happen when tapping the ground: ask what the top of the screen
  says, and offer to pass it to the team if it does not explain.

```controls any
#add-item-btn | Add item
#catalog-all-items-btn | All items
#catalog-search-input | Search
.search-scope-btn[data-search-scope="both"] | All
.search-scope-btn[data-search-scope="products"] | Products
.search-scope-btn[data-search-scope="bundles"] | Bundles
#undo-btn | Undo
```

### How do I move an item?

1. Tap the item. It gets a ring around it and a small card beside it.
2. Put a finger on the item and drag. It slides along the ground under your
   finger, staying at the same height. If you start the drag on empty ground
   instead, the view turns and the item stays put.
3. Let go where you want it. It saves by itself.
4. To lift it, lower it or move it in small exact steps, tap "More" on the card:
   see "Nudge" below.

**You will see:** the item follows your finger and stays where you leave it.

**If something goes wrong:**
- It will not go any further: it has reached a limit and the app stops it there,
  saying so at the top of the screen. If the message is about how high or how deep
  the lándlet goes, see the levels entry below.
- You want to line it up with something nearby: tap "More" on the card beside the
  item, then "Snap" so it is yellow. A dragged item then lines its edges and
  middle up with items close to it.
- Wrong spot: the round logo button at the top left, the Build petal, then "Undo".
- You want to place it exactly: tap "More" on the card beside the item. "Nudge" has "Left", "Right",
  "Forward" and "Back", which slide it a small step along the item's own direction (a tenth of a metre,
  or a quarter of a foot), so sliding along a turned wall is one press; and "Up" and "Down", which raise
  or lower it, with its height shown beside the word "Nudge". If a press does nothing, a line says why:
  the edge of the lándlet, the floor, or something in the way.

```controls build
#toggle-snap | Snap
```

### How do I turn an item?

1. Tap the item. A blue ring appears around it, and a line on the card reads the
   angles.
2. Drag the ring to turn the item flat, like a record on a turntable. The line
   calls this "Turn".
3. To tip it over instead, tap "More" on the card and type a number under "Angles":
   "Tilt red" or "Tilt green" (the line calls these "Tilt").

**You will see:** the item turns as you drag, and the line on the card shows how far.

**If something goes wrong:**
- It turned the wrong way or too far: the round logo button at the top left, the Build petal, then "Undo".
- You want an exact angle: tap "More" on the card beside the item, and type the angle in degrees under
  "Angles": "Turn", "Tilt red" or "Tilt green" (the same three the line reads). An empty or invalid
  number is put back as it was.
- A bundle says "This bundle is too big to turn any further here." It cannot turn
  more without leaving your lándlet. Move it first, or turn it the other way.

```controls build
#item-card-more-btn | More
```

### How do I copy an item?

1. Tap the item, then tap "Copy" on the card beside it. The top of the screen says
   "Copied 1 item".
2. Tap the bud, then the Build petal, then "Tools", then "Paste" (it is only listed once something is
   copied). With the item still selected, the copy appears
   right on top of it.
3. To put the copy somewhere else instead, tap empty ground first so nothing is
   selected, then tap "Paste" the same way. The top of the screen says "Tap a spot to paste 1
   item": tap the ground where it should go.
4. The copy is selected, so drag it to place it exactly.

**You will see:** a second item, the same as the first.

**If something goes wrong:**
- Changed your mind about where to paste: the "Add item" petal in the bud now
  reads "Cancel placing". Tap the bud, then the Build petal, then that.
- Wrong spot: the round logo button at the top left, the Build petal, then "Undo".

```controls build
#copy-item | Copy
#paste-btn | Paste
```

### How do I remove an item, or get it back?

1. Tap the item.
2. Tap "Delete" on the card beside it.

**You will see:** the item disappears at once. There is no "are you sure" for a
single item.

**If something goes wrong:**
- It was a mistake: tap the round logo button at the top left, the Build petal, then "Undo", straight away and it comes back.
- It is gone and "Undo" no longer brings it back: items taken off by the world
  itself (for example because their seller was suspended) wait under "Removed
  Items". If that button shows, tap it. Otherwise offer to pass it to the team.

```controls build
#delete-item | Delete
#undo-btn | Undo
#pending-restoration-btn | Removed items
```

### How do I undo a mistake, or redo it?

1. Tap the round higglehaven logo button at the top left (labelled Menu until it has been opened once),
   then "Undo". It is there only once you have done something. The last thing you
   did is taken back: a move, a turn, an add, a removal.
2. Tap it again to go back further.
3. If you went too far, "Redo" appears next to it. Tap it to put things back.

**You will see:** the item jumps back to how it was. "Redo" shows up only after an
"Undo".

**If something goes wrong:**
- "Undo" is greyed out, or the logo button shows no "Undo": there is nothing to take back yet.
- "Redo" has gone: it only shows while there is something to put back.

```controls build
#undo-btn | Undo
#redo-btn | Redo
```

### How do I select several items at once?

1. Tap the bud, then the Build petal, then "Tools", then "Multi-Select". The sheet goes away and the bud
   says "Selecting" while it is on. Before anything is chosen, the "Brush" slider
   is in the Tools sheet: tap the bud, the Build petal, then "Tools" again to change it.
2. Tap each item you want, or drag across several: the slider sets how wide the
   sweep is. Once something is chosen, the slider is on the card beside the
   chosen items, so you can change the sweep without leaving them.
3. The card beside the items says how many are chosen, for example "2 items
   selected".
4. Tap the bud, the Build petal, "Tools", then "Multi-Select" again when you want to go back to
   choosing one item at a time. The bud says "Menu" again.

**You will see:** the same card as for one item, with "Copy", "Delete" and the rest acting
on all of them; and a drag that starts on any chosen item moves all of them together.

**If something goes wrong:**
- Some buttons on the card are greyed out, such as "Trim": they work on one item at
  a time.
- The card, with its count and the slider, only shows once something is chosen.

```controls build
#toggle-multiselect | Multi-Select
#multiselect-brush-size-input | brush
```

### How do I make a bundle, and use it again?

1. Select two or more items (see the entry above).
2. Tap "Bundle" on the card that opens beside them. They become one thing: one box around them,
   moved and turned together.
3. To keep it for later, tap "Save bundle", give it a name, choose whether
   "Anyone can place this bundle" or "Only you can place this bundle", and tap
   "Save".
4. To use a saved bundle, tap the bud, then the Build petal, then "Add item", then "All items", then
   "Bundles", and tap its name.
5. To split one apart, select it and tap "Unbundle".

**You will see:** after "Bundle" the buttons "Unbundle" and "Edit" appear. After
"Save", a saved bundle is in the "Add item" list under "All items" and "Bundles".

**If something goes wrong:**
- The app says "Still saving your items. Try Bundle again in a moment." Wait a
  few seconds and tap "Bundle" again.
- "Edit" on a saved bundle changes every copy of it, and only the person who
  saved it can do that. Anyone else can tap "Unbundle" and keep their own.

```controls build
#group-item | Bundle
#save-bundle-item | Save bundle
#ungroup-item | Unbundle
#edit-bundle-item | Edit
#bundle-name-save-btn | Save
label:has(#bundle-name-share-public) | Anyone can place this bundle
label:has(#bundle-name-share-private) | Only you can place this bundle
```

### How do I build up or dig down to another level?

1. Tap the round higglehaven logo button at the top left (labelled Menu until it has been opened once), then the Build petal, then "Levels". A sheet
   opens that says which level you are on: "You are on Ground" when you are on the
   ground level.
2. Tap "Build level above" to add a level over the one you are on, or "Dig Level
   Below" to add one underneath. The button shows in brackets how much space the
   new level uses.
3. Use the up and down arrows ("Level up", "Level down") to move between levels.
   The sheet says which level you are on.
4. On a level above or below the ground, "Remove this level" appears. It removes
   that level.
5. The "×" at the top right of the sheet puts it away. It stays open while you move
   between levels, so you can read what the app says after each tap.

**You will see:** the world shifts to the new level and the level's name on the sheet changes.

**If something goes wrong:**
- The app says "That's as high as this lándlet goes. Use Build level above to
  build higher." or "That's as deep as this lándlet goes. Use Dig level below to
  go deeper." It means an item has hit the top or bottom level you have.
- Adding a level is refused: the app says why in words. Read it out with the
  person and do not promise more than it says. If money or allowances are
  involved, use the runbook's hand-off.
- "Remove this level" takes the items on that level off your lándlet. Say so
  before the person taps it.

```controls build
#bud-petal-build-levels | Levels
#level-build-btn | Build level above
#level-dig-btn | Dig level below
#level-up-btn | Level up
#level-down-btn | Level down
#level-remove-btn | Remove this level
```

### How do I measure something?

1. Tap the bud, then the Build petal, then "Tools", then "Measure". The bud says "Measuring" while it is
   on.
2. Tap one point: an item's surface or the bare ground. Tap a second point.
3. The top of the screen reads the straight-line distance and how much of it is
   across, along and up, for example "5.83m — Δx 0.55m, Δy 5.80m, Δz 0.00m".
4. Drag either point to adjust it, or tap somewhere else to start a new
   measurement. Turn it off the same way: bud, "Tools", "Measure".

**You will see:** two small markers joined by a dashed line, and the numbers at the
top of the screen.

**If something goes wrong:**
- Nothing is read out: turn "Measure" on first, then tap both points.
- Taps select items instead: "Measure" is off. The bud should say "Measuring".

```controls build
#toggle-measure | Measure
#bud-petal-build-tools | Tools
```

## Sell

### What does Sell mode show, and where is my showroom?

1. Tap the round logo at the top left (the bud). Three petals grow out of it:
   "Shop", "Build" and "Sell". Tap "Sell".
2. Your showroom opens: a small, empty piece of the world with your products
   standing on shelves. A pill at the top reads "Page 1 of 1"; use "Previous page"
   and "Next page" (the two small arrows) when you have more than one page.
3. Nothing covers the showroom: walk around it as you would anywhere. To see your
   list, tap the round logo at the top left (the bud), then the Sell petal, then "My products". Tap "Close"
   (the × at its top right) to put the list away again.

**You will see:** your own products only. Nobody else's products and no real
lándlets are shown here.

**If something goes wrong:**
- "My products" says "No products yet. Tap "Add a product" in the menu to put your first one up for sale."
  You have not uploaded anything yet. The next entry shows how.
- The list is not on screen: it does not open by itself. Tap the round logo at the top
  left, then "My products".

```controls sell
.mode-nav-btn[data-mode="sell"] | Sell
#bud-petal-sell-my-products | My products
#seller-showcase-prev-btn | Previous page
#seller-showcase-next-btn | Next page
#seller-close-btn | Close
```

### How do I put my own product up for sale?

1. In Sell, tap the round logo at the top left (the bud), then the Sell petal, then "Add a product". A
   small window opens under it and asks which way. Tap "Upload my own model". The
   window is now called "Upload model".
2. Fill in "Name". Fill in "Price": it starts empty on purpose, so type a number
   in dollars, or 0 for a free product.
3. Choose the model file with "Choose File". It must be a .glb or .fbx file, up to
   20MB. Tick "This is a digital good" only for things like an avatar or an art
   file that is delivered, not placed.
4. Tap "Add product". The app shrinks the model and shows a preview; this can take
   a moment.
5. The window is now called "Confirm dimensions". Set the product's real size with
   "Width (X)", "Depth (Y)" and "Height (Z)" in metres; changing one changes the
   other two so the proportions stay the same.
6. Tap "Create product".

**You will see:** the window closes and the product is on your showroom shelf (and in
your "My products" list).

**If something goes wrong:**
- The window says "Name is required.", "Enter a price — use 0 for a free product."
  or "Choose a .glb or .fbx file first." Fill in the one it names and tap "Add
  Product" again. The app checks the price on this first step, not later.
- You have no model file: tap "Or generate a model from a video instead" at the
  bottom of the first step. It takes a short video of one object and uses one of
  your video credits, which that part of the window shows. "Back to manual file upload" returns.
- The window shows an error after "Add product" that is not one of those: ask the
  person to read it out, and offer to pass it to the team.
- You already have a product with that name: the app asks you to confirm before it
  makes a second one.

```controls sell
#bud-petal-sell-add-product | Add a product
#add-product-upload-btn | Upload my own model
#upload-submit-btn | Add product
#upload-mode-video-btn | generate a model from a video
```

### How do I sell a product someone else already made?

1. In Sell, tap the round logo at the top left (the bud), then the Sell petal, then "Add a product", then
   "Sell one that is already here".
2. Look through the products, or type in "Search products". Tap the one you want to
   sell.
3. Fill in "Your price" (0 for free). "Stock quantity (optional)" is how many you
   have; leave it blank for unlimited.
4. Tap "Add listing". Tap "Back" instead to choose a different product.

**You will see:** the product appears in your "My products" list with your own
price and stock. The original maker's listing is not changed.

**If something goes wrong:**
- "Stock must be a whole number of 0 or more, or left blank." Type digits only, or
  clear the box.
- The price is refused: it must be a number, 0 or more.

```controls sell
#add-product-sell-too-btn | Sell one that is already here
#sell-this-too-search-input | Search products
#sell-this-too-add-btn | Add listing
#sell-this-too-back-btn | Back
```

### How do I find, change the price of, or rename one of my products?

1. In "My products", tap the product's name to open it. "Manage" is the view that
   shows each product with its buttons; "List view" is a plainer list.
2. To find one quickly, type in "Search products" above the list, or use the
   category and sort boxes beside it.
3. To rename it, tap "Rename", type the new name in the window that opens and
   confirm.
4. To change its price, tap "More settings" on the product, then "Edit price", type the new
   price and tap "Save price". The other "Edit" lines (size, shipping, returns) are under
   "More settings" too and work the same way: open it, change it, tap its own Save button.
5. To change how many are in stock, tap the product in your showroom. A small card opens
   beside it showing its price and its stock ("No limit on stock", "3 in stock" or "Sold out").
   Tap "Stock" on that card, type how many you have left (a whole number, 0 or more) and
   tap "Save". Leave the box blank for no limit; 0 marks it sold out.

**You will see:** the new name or price on the product straight away, and the word
"Saved." beside the button.

**If something goes wrong:**
- "You already have another product named ... Rename anyway?" You can keep the
  name or choose another.
- A price above the limit is refused with a message naming the limit.
- "Stock must be a whole number of 0 or more, or left blank for no limit." Type digits
  only, or clear the box.
- Something changed does not show up: close "My products" and open it again with
  the round logo at the top left, the Sell petal, then "My products"; if it is still wrong, ask
  what they see and offer to pass it on.

```controls sell
.seller-view-btn[data-view="manage"] | Manage
.seller-view-btn[data-view="list"] | List view
#seller-search-input | Search products
```

```controls sell-row
.seller-rename-btn | Rename
.seller-price-toggle | Edit price
.seller-price-save-btn | Save Price
```

### How do I take a product off sale, and what do buyers keep?

1. In "My products", in the "Manage" view, tap the product to open it, then tap
   "Delete".
2. A window called "Delete this product?" names it and says it cannot be undone.
   Tap "Delete" in that window to go ahead, or the cancel button to keep it.

**You will see:** the product leaves your list and the showroom.

**What buyers keep:** a digital good such as an avatar or an animation that
someone has already bought is taken off sale but stays with the people who own it,
exactly as it was; it keeps working for them and they are not told. A product that
nobody owns and nothing uses is removed completely.

**If something goes wrong:**
- The window says "Still placed somewhere — remove those instances first, or
  Duplicate to edit a copy instead." Someone has it placed on a lándlet. It cannot
  be deleted while that is so.
- It says the product is still saved in someone's layout library, or was used in a
  lándlet's past published version. It cannot be deleted while that is so; do not
  promise when it will be possible, and offer to pass it to the team.
- They only want a quiet copy to change: "Duplicate" (under "More settings" on the
  product) makes a copy to edit without touching the original.

```controls sell
.seller-view-btn[data-view="manage"] | Manage
```

```controls sell-row
.seller-row-action-btn.danger | Delete
```

### Where do I set up payouts and tax forms?

1. Switch to Sell (tap the round logo at the top left, then the "Sell" petal), then tap the logo again and the "Sell" petal to open Sell's menu.
2. Tap "Payouts". The leaf that opens says first what is owed to them so far (even when it is $0.00), then whether a payout account is set up.
3. "Set up payouts" opens two short steps: "About you", then "Where you live" and "Your bank". Use "Next" and "Back" to move between them; the last step's button is "Set up payout account". If an account already exists, "Change payout details" (or "Continue setup", when the payment provider needs something more) opens the same steps.
4. Tax forms and identity checks, where they are asked for, are filled in by you on
   those screens.

**You will see:** at the top of the "Payouts" leaf, how much is owed to them so far, then the payout account's status.

**If something goes wrong:**
- Anything about an amount, whether they are eligible, a payout that is late or
  wrong, a tax figure or a refund is not for the assistant to answer: say so
  plainly and use the runbook's hand-off.
- The fields look different from what is described here: ask what they see, and
  offer to pass it to the team.

```controls sell
.mode-nav-btn[data-mode="sell"] | Sell
#bud-petal-sell-payouts | Payouts
```

### Where do I see what I have sold, and mark something shipped?

1. Switch to Sell (tap the round logo at the top left, then the "Sell" petal), then tap the logo again and the "Sell" petal to open Sell's menu.
2. Tap "Orders". Every sale of every product they have for sale is one row, newest first: the product's name, who bought it, how many, the total, what they earned and when.
3. For a real-money sale of a physical product, "Mark shipped" starts the clock that lets the money be cashed out. A sale that has been refunded says "Refunded".

**You will see:** "No orders yet. When someone buys one of your products, it will show up here." until something sells.

**If something goes wrong:**
- A refund, a missing payment or an amount that looks wrong is not for the assistant to answer: say so plainly and use the runbook's hand-off.
- The list looks different from what is described here: ask what they see, and offer to pass it to the team.

```controls sell
.mode-nav-btn[data-mode="sell"] | Sell
#bud-petal-sell-orders | Orders
```

### How do I rename my shop, or start my seller profile over?

1. Switch to Sell, tap the logo and then the "Sell" petal to open Sell's menu, and tap "Storefront".
2. The leaf shows the shop name. "Rename" changes it. "Reset profile" starts the seller profile over after a confirmation, and says what it will do first.

**You will see:** the new name in the leaf straight away.

**If something goes wrong:**
- "Reset profile" is refused: the leaf shows the reason; do not promise anything about money, and use the runbook's hand-off if it is about unpaid proceeds.

```controls sell
.mode-nav-btn[data-mode="sell"] | Sell
#bud-petal-sell-storefront | Storefront
```
