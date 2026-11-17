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
  ("Add Item"), or by what it looks like when it has no words (the gear, the world itself). It says what to tap, not where the code keeps it. Where the app's own
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

1. Tap the gear at the top left. When nobody is signed in, the first row says "Log In / Sign Up"; tap it.
2. Tap the "Sign Up" tab.
3. Fill in "Username" (the name other people see), "Email" and "Password (8+ characters)".
4. Tick "I confirm I am at least 18 years old". Nobody under 18 can have an account.
5. Tap "Sign Up".

**You will see:** the window closes, and the first row of the gear menu now shows the person's username instead of "Log In / Sign Up". Tapping it opens their account. A verification email is sent to the address they gave.

**If something goes wrong:**
- The app says "Account created, but the verification email failed to send": the account exists; in their account panel, "Resend verification email" sends it again.
- The app says what is wrong with a field (a username or email already taken, a password under 8 characters): read it out and fix that field.
- Signing up is enough for shopping. The first time they go into Build or Sell, a "Verify to continue" screen asks for more; the next entry covers it.
- Nothing happens, or the screen looks different from this: ask what they see, and offer to pass it to the team.

```controls any
#auth-tabs [data-auth-view="signup"] | Sign Up
#auth-signup-form label:nth-of-type(1) | Username
#auth-signup-form label:nth-of-type(2) | Email
#auth-signup-form label:nth-of-type(3) | Password (8+ characters)
#auth-signup-form .auth-checkbox-label | I confirm I am at least 18 years old
#auth-signup-form button[type="submit"] | Sign Up
```

### How do I log in, or get back in if I forgot my password?

1. Tap the gear at the top left, then "Log In / Sign Up". The "Log In" tab is the first one.
2. Fill in "Email" and "Password", then tap "Log In".
3. If they forgot the password, tap "Forgot password?" instead, type their email and tap "Send Reset Link".
4. The email carries a link. It opens a screen that says "Choose a new password": type one (8 or more characters) and tap "Reset Password".

**You will see:** after "Log In", the gear menu shows their username. After "Send Reset Link", the app says "If that email has an account, a reset link was sent." (it says the same whether or not the address has an account). After "Reset Password", it says "Password reset! You can log in with your new password now." and they log in with the new one.

**If something goes wrong:**
- The email does not arrive: ask them to look in their spam folder, and to check they typed the address they signed up with.
- A wrong email or password: the app says so; try again or use "Forgot password?".
- They cannot get in after resetting, or the app says something about their account's standing: do not guess, use the runbook's hand-off.

```controls any
#auth-tabs [data-auth-view="login"] | Log In
#auth-login-form label:nth-of-type(1) | Email
#auth-login-form button[type="submit"] | Log In
#auth-forgot-btn | Forgot password?
#auth-forgot-form button[type="submit"] | Send Reset Link
#auth-reset-form button[type="submit"] | Reset Password
```

### Why am I asked to confirm I am 18, and how do I verify?

1. The "Verify to continue" screen appears the first time a signed-in person goes into Build or Sell. Its first lines say why: building and selling take two things, confirming they are 18 or older, and proof of it, either a credit card or a government ID.
2. Tick "I confirm I am at least 18 years old" and tap "Continue".
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

1. Tap the gear at the top left, then "Settings".
2. Tabs run across the top: "General", "Shop", "Build" and "Sell".
3. "General" holds "Units" (Meters or Feet), "Version", and "Notifications" (an option to be emailed when one of their placed products sells out). If they have started selling, the tax paperwork is here too.
4. "Shop" holds "Controls", which reminds them how to walk, look and fly, and "My Avatars" and "My Animations" once they own any.
5. "Build" and "Sell" hold the settings for those modes, including the person's username (with "Rename") on "Build" and the payout account on "Sell".
6. At the bottom of every tab are "Ask an assistant" and "Send feedback".
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
#settings-tabs [data-section="sell"] | Sell
#settings-assistant-btn | Ask an assistant
#settings-feedback-btn | Send feedback
#settings-close-btn | Close
```

### How do I wear an avatar I bought, or apply an animation?

1. Tap the gear at the top left, then "Settings", then the "Shop" tab.
2. Under "My Avatars", each avatar they own is a row, and the first row is always "Default avatar". Tap "Equip" on the one they want.
3. Under "My Animations", tap "Apply" on an animation to use it with the avatar they are wearing, or "Clear" to take it off.

**You will see:** their character in the world changes to the avatar. The row they chose says it is equipped.

**If something goes wrong:**
- "My Avatars" or "My Animations" is not on the tab: they own none yet, so the section is not drawn. Where to buy one is in "How do I buy something?".
- A message says it could not equip the avatar: read it out; try once more, then offer to pass it to the team.
- An animation that does not suit the avatar is marked as not matching: the app says so next to it. Read that note out rather than guessing.

```controls any
#settings-tabs [data-section="shop"] | Shop
```

### How do I send feedback about a problem?

1. Tap the gear at the top left, then "Settings".
2. Tap "Send feedback" at the bottom.
3. A window titled "Submit Feedback" shows a picture of what they were looking at. In the box under "Describe what happened (optional)", say what went wrong, in as much detail as they like.
4. Tap "Submit". "Cancel" closes it without sending.

**You will see:** the app says "Thanks! Your feedback was submitted." and the window closes by itself.

**If something goes wrong:**
- It says it could not send: read the words out and ask them to try again in a minute.
- They would rather talk it through: they can also leave a message here in the assistant window, and the assistant can pass it to the team.

```controls any
#settings-feedback-btn | Send feedback
#feedback-modal h2 | Submit Feedback
#feedback-modal label | Describe what happened (optional)
#feedback-submit-btn | Submit
#feedback-cancel-btn | Cancel
```

### How do I change my password or log out?

1. Tap the gear at the top left, then tap their username (the first row) to open "Account".
2. To change the password, tap "Change Password". Fill in "Current password" and "New password (8+ characters)" and tap "Change Password" again. This signs them out of every other device, but keeps this one signed in.
3. To log out, tap "Log Out".

**You will see:** after a password change, the app says "Your password has been changed. You have been signed out of your other devices." After "Log Out", the first row of the gear menu says "Log In / Sign Up" again.

**If something goes wrong:**
- The app says the current password is wrong: they can log out and use "Forgot password?" from the log in screen.
- The same panel also has "Change Email" and "Download My Data". "Delete Account" is permanent and cannot be undone: only describe where it is if asked, and never suggest it. Anything about an account's standing goes to the runbook's hand-off.

```controls any
#auth-change-password-btn | Change Password
#auth-change-password-form button[type="submit"] | Change Password
#auth-logout-btn | Log Out
#auth-change-email-btn | Change Email
#auth-export-data-btn | Download My Data
```

## Getting around and Shop

### How do I walk around and look around?

1. Put one finger on the world anywhere and drag it in the direction you want to
   go. The further you drag, the faster you move.
2. To look around, keep that first finger down and put a second finger on the
   world, then drag the second finger to turn the view.
3. Lift your finger and you stop. There are no buttons to find: the world itself is
   the control.

**You will see:** your bird walks or turns as you drag, and the view follows.

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
   taps in the same place.
2. While you are flying, two green arrows sit at the bottom right: tap the up
   arrow ("Fly up") to climb and the down arrow ("Fly down") to sink.
3. Walk and look by dragging, as usual.
4. To go up again from the ground, double-tap the world again and the arrows come
   back. The arrows go away once you are on the ground.

**You will see:** the up and down arrows show only while the bird is flying, and a
double-tap switches between flying and standing.

**If something goes wrong:**
- No arrows: you are on the ground. Double-tap the world to fly.
- A double-tap on a product opens that product instead: double-tap on open ground.
- You cannot find the ground: double-tap the world and let it come down by itself.

```controls shop
#app | (no words)
#shop-up-btn | Fly up
#shop-down-btn | Fly down
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
#shop-last-location-btn | Go to Last Location
```

### How do I look at a product and read about it?

1. Walk or fly to a product somewhere in the world and tap it.
2. A card opens with a picture of it you can turn, and its details.
3. The card has three buttons: "Rate this Product", "Purchase" and "Return Policy".
4. Tap the cross at the top right of the card when you are done.

**You will see:** a card over the world with the product's picture and its price
and details.

**If something goes wrong:**
- Nothing opens when tapping: you may have tapped the ground beside it. Tap the
  product itself, or move closer.
- "Return Policy" tells the person what the seller says about returns, which can
  differ by product. Read it with them, and do not promise more than it says.

```controls any
#shop-product-preview-review-btn | Rate this Product
#shop-product-preview-buy-btn | Purchase
#shop-product-preview-return-policy-btn | Return Policy
```

### How do I buy something?

1. Open the product's card (see the entry above) and tap "Purchase".
2. A sheet titled "Checkout" shows what you are buying. Enter your card in the card
   box.
3. Tap "Pay".

**You will see:** the sheet closes when the payment goes through, and the product
shows under "My Purchases".

**If something goes wrong:**
- A sheet titled "Verify to continue" appears instead. It is the adult check: it asks
  the person to confirm they are at least 18 and to add a card or verify another
  way, then tap "Continue". If it will not complete, use the runbook's hand-off. The
  person can also tap "Log out instead".
- The payment fails, the person is charged twice, or they want a refund: that is
  money. Say plainly that you cannot do it yourself, say you are sending it to the
  team, and use the runbook's hand-off.

```controls any
#shop-product-preview-buy-btn | Purchase
#checkout-modal-title | Checkout
#checkout-pay-btn | Pay
#verify-modal h2 | Verify to continue
label:has(#verify-age-attest) | at least 18
#verify-continue-btn | Continue
#verify-logout-btn | Log out instead
```

### Where are the things I bought, and how do I rate a seller?

1. Tap the gear at the top left ("Account menu"). A short menu opens, with your name
   at the top and "Notices", "Friends", "My Purchases" and "Settings" below it.
2. Tap "My Purchases".
3. Each purchase has a "Rate this seller" button. Tap it to rate the seller.

**You will see:** a list of what you bought. Someone who has bought nothing yet sees
"You haven't bought anything yet."

**If something goes wrong:**
- The list is empty but they remember buying: ask which account they are signed in
  as; another account would have a different list. If it still looks wrong, use the
  runbook's hand-off, because a missing purchase is a money question.
- Rating a seller is for after they have had the item, so it is offered here, not at
  checkout.

```controls any
#account-menu-toggle | Account menu
#my-purchases-btn | My Purchases
#my-purchases-empty | You haven't bought anything yet.
```

### How do I leave a review for a product?

1. Open the product's card and tap "Rate this Product".
2. A sheet titled "Review this product" opens. Tap a rating from 1 to 5 stars. 5 is
   chosen to begin with.
3. If you want, write a comment in the box. It is optional.
4. Tap "Post review".

**You will see:** the sheet closes and your review is saved on the product.

**If something goes wrong:**
- The sheet says to choose a star rating from 1 to 5: tap one of the star choices.
- To change a review you left, open "Rate this Product" again: a "Delete review"
  button shows next to "Post review".
- To back out, tap "Cancel".

```controls any
#shop-product-preview-review-btn | Rate this Product
#product-review-modal-title | Review this product
#product-review-save-btn | Post review
#product-review-cancel-btn | Cancel
#product-review-delete-btn | Delete review
```

### What are the glowing orbs, and what if I hit the limit?

1. Glowing orbs float around the world. Walk or fly into one to collect it.
2. The screen says "You collected a free model-generation credit!". Credits are free
   and are used when you make a model from a picture or a description in Build.
3. There is a limit on how many you can collect in a short time. When you reach it,
   a notice says how many you can collect and in how long you can collect more, for
   example "You can collect up to 20 orbs every 15 minutes. Try again in about 7
   minutes." Read the numbers out from the person's own screen, since they can
   change.

**You will see:** a short note when you collect an orb, and a notice with a cross at
its corner when you reach the limit.

**If something goes wrong:**
- "Someone else collected that orb just before you." Another person got there first.
  Try the next orb.
- "Can't collect orbs right now — you appear to be offline." Their connection has
  dropped. Ask them to check it and try again.
- Tap the small cross on a notice to dismiss it.

```controls any
#shop-credit-orb-toast | You collected a free model-generation credit!
#shop-credit-orb-offline-notice .shop-notice-text | Can't collect orbs right now
#shop-credit-orb-rate-limit-notice .shop-notice-text | limit
#shop-credit-orb-problem-notice .shop-notice-text | Someone else collected that orb
```

### How do I chat with people nearby?

1. Tap the "Chat" button. A small chat box opens.
2. Type in the box that says "Say something nearby…" and tap "Send".
3. People close to you see it. Their messages show in the same box.
4. If you have muted someone, "Muted" with a number shows above the box. Tap it to
   see who.

**You will see:** your message appears in the box, and messages from people near you
appear in the same box.

**If something goes wrong:**
- There is no "Chat" button: nearby chat, like direct messages and voice, is only
  for people whose age and identity the app has checked. If they cannot see it, that
  is the likely reason. Do not explain the rules: if they want to know how to get
  verified, use the runbook's hand-off.
- Someone is bothering them: they can mute that person from the box. For harassment,
  use the runbook's hand-off.

```controls any
#shop-nearby-chat-btn | Chat
#shop-nearby-chat-input | Say something nearby
#shop-nearby-chat-panel button[type="submit"] | Send
#shop-nearby-chat-muted-toggle | Muted
```

### How do I talk to people nearby by voice?

1. Tap the microphone button on the screen. Its label reads "Unmute microphone"
   while you are muted.
2. Your phone asks for permission to use the microphone. Allow it.
3. The button shows what your microphone is doing right now. Tap it again to mute
   yourself.
4. People close to you can hear you, and you can hear them; voices get quieter the
   further away they are.

**You will see:** the button changes to show you are unmuted, and again while you
are speaking.

**If something goes wrong:**
- There is no microphone button: like nearby chat, voice is only for people whose age
  and identity the app has checked. Use the runbook's hand-off if they ask how to
  get verified.
- The button shows the microphone is blocked: the phone's own settings are stopping
  it. They need to allow the microphone for this site in their browser's settings.
  You cannot do that for them.

```controls any
#shop-voice-btn | microphone
```

### How do I add a friend and send them a message?

1. Tap the gear at the top left ("Account menu"), then "Friends".
2. Tap "+ Add Friend". A small box asks for the friend's name. Type it exactly as
   their name is written, then tap "Save".
3. They get your request. When they accept, they show in your list.
4. To write to an accepted friend, tap "Message" beside their name, type in the box
   that says "Message…" and tap "Send".

**You will see:** your friend's name in the list once they accept, and a thread with
your messages when you tap "Message". Until then the panel says "No friends yet".

**If something goes wrong:**
- The panel says there is no one by that name: the name has to match exactly. Ask
  them to read it out from their own screen.
- A request for you shows with "Accept" and "Decline" buttons.
- To stop hearing from someone, tap "Block this person" in their thread. They are
  not told. For anything worse, use the runbook's hand-off.
- Like chat and voice, messages are only for people whose age and identity the app
  has checked.
- "Show Map" in the Friends panel shows where friends are.

```controls any
#account-menu-toggle | Account menu
#friends-btn | Friends
#friends-add-btn | + Add Friend
#friends-map-btn | Show Map
#friends-panel-empty | No friends yet
```

### How do I talk to an assistant?

1. Tap an assistant's bird in the world, or tap the gear, then "Settings", then "Ask
   an assistant".
2. A small window opens. Type in the box that says "Ask a question…" and tap "Send".
3. An assistant answers there. Keep going in the same window.
4. To tuck it away without ending the chat, tap the minus at the top right of the
   window ("Minimise"). To end the chat, tap the cross ("End the conversation and
   close").

**You will see:** a window at the bottom of the screen with your message and the
assistant's replies, each labelled with who wrote it.

**If something goes wrong:**
- No assistant is free: the window says so, and the message waits in line. It is
  answered when one is free.
- To stop an assistant from contacting them, tap "Block" in the window.
- Assistants are AI helpers, and the window says so. They cannot do anything to an
  account; for money, an account's standing, or a report about someone, they send it
  to the team.

```controls any
#settings-btn | Settings
#settings-assistant-btn | Ask an assistant
#assistant-chat-input | Ask a question
#assistant-chat-send | Send
#assistant-chat-minimize | Minimise
#assistant-chat-close | End the conversation
#assistant-chat-block | Block
```

## Build

### How do I get my own lándlet?

1. Tap "Build" at the top right.
2. The first time, a sheet opens with the title "Claim a" and a small map.
   Green squares are "Available", grey are "Claimed", blue is "Water".
3. Tap an available green square on the map. The line under the map names it and
   its size, and the "Claim" button turns on.
4. Tap "Claim". The sheet closes and you are standing on your own lándlet.

**You will see:** the sheet goes away and the Build buttons appear: "+ Add Item",
"Multi-Select" and "Measure" at the bottom left, "Undo" at the top right.

**If something goes wrong:**
- The line under the map says "No lándlets are ready to claim yet — check back
  again shortly." Tap "Refresh" after a moment. If it stays that way, offer to
  pass it to the team.
- The "Claim" button stays off: nothing is chosen yet. Tap a green square first.
- The sheet says you can only claim one lándlet. Choose carefully before tapping
  "Claim".

```controls any
.mode-nav-btn[data-mode="build"] | Build
#claim-modal h2 | Claim a
#claim-confirm-btn | Claim
#claim-refresh-btn | Refresh
```

### How do I add an item to my lándlet?

1. In Build, tap "+ Add Item" at the bottom left. A list opens.
2. Look through the list, or type in the "Search" box. "All", "Products" and
   "Bundles" narrow it to everything, single items or saved bundles.
3. Tap an item's name. The list closes and the top of the screen says "Tap a spot
   to place" and the item's name.
4. Tap the ground where you want it.

**You will see:** the item stands where you tapped and is already selected, with a
row of buttons above it ("Move", "Rotate" and the rest) and arrows around it.

**If something goes wrong:**
- Changed your mind before tapping the ground: the "+ Add Item" button now reads
  "Cancel". Tap it.
- The item is not where you wanted. It is selected, so use "Move" (below), or tap
  "Undo" at the top right to take it back.
- Nothing seems to happen when tapping the ground: ask what the top of the screen
  says, and offer to pass it to the team if it does not explain.

```controls any
#add-item-btn | Add Item
#catalog-search-input | Search
.search-scope-btn[data-search-scope="both"] | All
.search-scope-btn[data-search-scope="products"] | Products
.search-scope-btn[data-search-scope="bundles"] | Bundles
#undo-btn | Undo
```

### How do I move an item?

1. Tap the item. It gets arrows around it and a row of buttons above it.
2. Make sure "Move" is the green one in that row. Tap it if not.
3. Drag the item to slide it along the ground. Drag the blue arrow to lift it up
   or down. Drag the red or green arrow to slide it along only that line.
4. Let go where you want it. It saves by itself.

**You will see:** the item follows your finger and stays where you leave it.

**If something goes wrong:**
- It will not go any further: it has reached a limit and the app stops it there,
  saying so at the top of the screen. If the message is about how high or how deep
  the lándlet goes, see the levels entry below.
- You want to line it up with something nearby: tap "Snap" so it is green. A
  dragged item then lines its edges and middle up with items close to it.
- Wrong spot: "Undo" at the top right.

```controls build
#mode-move | Move
#toggle-snap | Snap
```

### How do I turn an item?

1. Tap the item, then tap "Rotate" in the row above it. Three coloured rings
   appear around it, and a line at the top reads the angles.
2. Drag the blue ring to turn it flat, like a record on a turntable. The line
   calls this "Turn".
3. Drag the red or green ring to tip it over. The line calls these "Tilt".
4. Tap "Move" to go back to sliding it.

**You will see:** the item turns as you drag, and the line at the top shows how far.

**If something goes wrong:**
- It turned the wrong way or too far: "Undo" at the top right.
- A bundle says "This bundle is too big to turn any further here." It cannot turn
  more without leaving your lándlet. Move it first, or turn it the other way.

```controls build
#mode-rotate | Rotate
#mode-move | Move
```

### How do I copy an item?

1. Tap the item, then tap "Copy" in the row above it. The top of the screen says
   "Copied 1 item".
2. Tap "Paste" at the bottom left. With the item still selected, the copy appears
   right on top of it.
3. To put the copy somewhere else instead, tap empty ground first so nothing is
   selected, then tap "Paste". The top of the screen says "Tap a spot to paste 1
   item": tap the ground where it should go.
4. The copy is selected, so use "Move" to place it exactly.

**You will see:** a second item, the same as the first.

**If something goes wrong:**
- Changed your mind about where to paste: the "+ Add Item" button now reads
  "Cancel". Tap it.
- Wrong spot: "Undo" at the top right.

```controls build
#copy-item | Copy
#paste-btn | Paste
```

### How do I remove an item, or get it back?

1. Tap the item.
2. Tap "Delete" in the row above it.

**You will see:** the item disappears at once. There is no "are you sure" for a
single item.

**If something goes wrong:**
- It was a mistake: tap "Undo" at the top right straight away and it comes back.
- It is gone and "Undo" no longer brings it back: items taken off by the world
  itself (for example because their seller was suspended) wait under "Removed
  Items". If that button shows, tap it. Otherwise offer to pass it to the team.

```controls build
#delete-item | Delete
#undo-btn | Undo
#pending-restoration-btn | Removed Items
```

### How do I undo a mistake, or redo it?

1. Tap "Undo" at the top right. The last thing you did is taken back: a move, a
   turn, an add, a removal.
2. Tap it again to go back further.
3. If you went too far, "Redo" appears under it. Tap it to put things back.

**You will see:** the item jumps back to how it was. "Redo" shows up only after an
"Undo".

**If something goes wrong:**
- "Undo" is greyed out: there is nothing to take back yet.
- "Redo" has gone: it only shows while there is something to put back.

```controls build
#undo-btn | Undo
#redo-btn | Redo
```

### How do I select several items at once?

1. Tap "Multi-Select" at the bottom left so it turns green. A "Brush" slider
   appears.
2. Tap each item you want, or drag across several: the slider sets how wide the
   sweep is.
3. The top of the screen says how many are chosen, for example "2 items
   selected".
4. Tap "Multi-Select" again when you want to go back to choosing one item at a
   time.

**You will see:** the same row of buttons as for one item, acting on all of them:
"Move", "Rotate", "Copy", "Delete" and the rest.

**If something goes wrong:**
- Some buttons in the row are greyed out, such as "Trim": they work on one item at
  a time.
- The row of buttons and the count at the top only show once something is
  chosen.

```controls build
#toggle-multiselect | Multi-Select
#multiselect-brush-size-input | brush
#mode-move | Move
```

### How do I make a bundle, and use it again?

1. Select two or more items (see the entry above).
2. Tap "Bundle" in the row above them. They become one thing: one box around them,
   moved and turned together.
3. To keep it for later, tap "Save Bundle", give it a name, choose whether
   "Anyone can place this bundle" or "Only you can place this bundle", and tap
   "Save".
4. To use a saved bundle, tap "+ Add Item", then "Bundles", and tap its name.
5. To split one apart, select it and tap "Unbundle".

**You will see:** after "Bundle" the buttons "Unbundle" and "Edit" appear. After
"Save", a saved bundle is in the "+ Add Item" list under "Bundles".

**If something goes wrong:**
- The app says "Still saving your items. Try Bundle again in a moment." Wait a
  few seconds and tap "Bundle" again.
- "Edit" on a saved bundle changes every copy of it, and only the person who
  saved it can do that. Anyone else can tap "Unbundle" and keep their own.

```controls build
#group-item | Bundle
#save-bundle-item | Save Bundle
#ungroup-item | Unbundle
#edit-bundle-item | Edit
#bundle-name-save-btn | Save
label:has(#bundle-name-share-public) | Anyone can place this bundle
label:has(#bundle-name-share-private) | Only you can place this bundle
```

### How do I build up or dig down to another level?

1. Tap the pill at the bottom, which reads "Ground" when you are on the ground
   level. A small menu opens.
2. Tap "Build Level Above" to add a level over the one you are on, or "Dig Level
   Below" to add one underneath. The button shows in brackets how much space the
   new level uses.
3. Use the up and down arrows ("Level up", "Level down") to move between levels.
   The pill shows which level you are on.
4. On a level above or below the ground, "Remove This Level" appears. It removes
   that level.

**You will see:** the world shifts to the new level and the pill's name changes.

**If something goes wrong:**
- The app says "That's as high as this lándlet goes. Use Build Level Above to
  build higher." or "That's as deep as this lándlet goes. Use Dig Level Below to
  go deeper." It means an item has hit the top or bottom level you have.
- Adding a level is refused: the app says why in words. Read it out with the
  person and do not promise more than it says. If money or allowances are
  involved, use the runbook's hand-off.
- "Remove This Level" takes the items on that level off your lándlet. Say so
  before the person taps it.

```controls build
#level-menu-toggle | Ground
#level-build-btn | Build Level Above
#level-dig-btn | Dig Level Below
#level-up-btn | Level up
#level-down-btn | Level down
#level-remove-btn | Remove This Level
```

### How do I measure something?

1. Tap "Measure" at the bottom left so it turns green.
2. Tap one point: an item's surface or the bare ground. Tap a second point.
3. The top of the screen reads the straight-line distance and how much of it is
   across, along and up, for example "5.83m — Δx 0.55m, Δy 5.80m, Δz 0.00m".
4. Drag either point to adjust it, or tap somewhere else to start a new
   measurement. Tap "Measure" again to turn it off.

**You will see:** two small markers joined by a dashed line, and the numbers at the
top of the screen.

**If something goes wrong:**
- Nothing is read out: tap "Measure" first, then both points.
- Taps select items instead: "Measure" is off. Tap it so it is green.

```controls build
#toggle-measure | Measure
```

## Sell

### What does Sell mode show, and where is my showroom?

1. Tap "Sell" at the top right.
2. Your showroom opens: a small, empty piece of the world with your products
   standing on shelves. A pill at the top reads "Page 1 of 1"; use "Previous page"
   and "Next page" (the two small arrows) when you have more than one page.
3. The "My products" window opens by itself. Tap "Close" (the × at its top right)
   to put it away and look at the showroom. Tap "Products" at the bottom right to bring it back.

**You will see:** your own products only. Nobody else's products and no real
lándlets are shown here.

**If something goes wrong:**
- "My products" says "No custom products yet — use "+ Upload Model" to add one."
  You have not uploaded anything yet. The next entry shows how.
- The window seems to be missing: tap "Products" at the bottom right.

```controls sell
.mode-nav-btn[data-mode="sell"] | Sell
#seller-showcase-manage-btn | Products
#seller-showcase-prev-btn | Previous page
#seller-showcase-next-btn | Next page
#seller-close-btn | Close
```

### How do I put my own product up for sale?

1. In Sell, in the "My products" window, tap "+ Upload Model". A window opens
   called "Upload Model".
2. Fill in "Name". Fill in "Price": it starts empty on purpose, so type a number
   in dollars, or 0 for a free product.
3. Choose the model file with "Choose File". It must be a .glb or .fbx file, up to
   20MB. Tick "This is a digital good" only for things like an avatar or an art
   file that is delivered, not placed.
4. Tap "Add Product". The app shrinks the model and shows a preview; this can take
   a moment.
5. The window is now called "Confirm Dimensions". Set the product's real size with
   "Width (X)", "Depth (Y)" and "Height (Z)" in metres; changing one changes the
   other two so the proportions stay the same.
6. Tap "Create Product".

**You will see:** the window closes and the product is in your "My products" list
and on your showroom shelf.

**If something goes wrong:**
- The window says "Name is required.", "Enter a price — use 0 for a free product."
  or "Choose a .glb or .fbx file first." Fill in the one it names and tap "Add
  Product" again. The app checks the price on this first step, not later.
- You have no model file: tap "Or generate a model from a video instead" at the
  bottom of the first step. It takes a short video of one object and uses one of
  your video credits, which that part of the window shows. "Back to manual file upload" returns.
- The window shows an error after "Add Product" that is not one of those: ask the
  person to read it out, and offer to pass it to the team.
- You already have a product with that name: the app asks you to confirm before it
  makes a second one.

```controls sell
#upload-model-btn | Upload Model
#upload-submit-btn | Add Product
#upload-mode-video-btn | generate a model from a video
```

### How do I sell a product someone else already made?

1. In "My products", tap "Sell This Too".
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
#sell-this-too-btn | Sell This Too
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
4. To change its price, tap "Edit Price", type the new price and tap "Save Price".
   The other "Edit" lines (size, shipping, returns) work the same way: open it,
   change it, tap its own Save button.

**You will see:** the new name or price on the product straight away, and the word
"Saved." beside the button.

**If something goes wrong:**
- "You already have another product named ... Rename anyway?" You can keep the
  name or choose another.
- A price above the limit is refused with a message naming the limit.
- Something changed does not show up: close "My products" and open it again with
  "Products"; if it is still wrong, ask what they see and offer to pass it on.

```controls sell
.seller-view-btn[data-view="manage"] | Manage
.seller-view-btn[data-view="list"] | List view
#seller-search-input | Search products
```

```controls sell-row
.seller-rename-btn | Rename
.seller-price-toggle | Edit Price
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
- They only want a quiet copy to change: "Duplicate" makes a copy to edit without
  touching the original.

```controls sell
.seller-view-btn[data-view="manage"] | Manage
```

```controls sell-row
.seller-row-action-btn.danger | Delete
```

### Where do I set up payouts and tax forms?

1. Tap the gear at the top left, then "Settings", then the "Sell" tab.
2. "Payout Account" says whether one is set up. "Set up payout account" (or "Update
   payout account" if there already is one) opens the steps for it.
3. Tax forms and identity checks, where they are asked for, are filled in by the
   person themselves on those screens.

**You will see:** the payout account's status at the top of the "Sell" tab.

**If something goes wrong:**
- Anything about an amount, whether they are eligible, a payout that is late or
  wrong, a tax figure or a refund is not for the assistant to answer: say so
  plainly and use the runbook's hand-off.
- The fields look different from what is described here: ask what they see, and
  offer to pass it to the team.

```controls any
#settings-btn | Settings
```
