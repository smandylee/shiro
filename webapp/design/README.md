# Shiro Home — design mockups

Mockups for a planned personal web app (PWA, phone and desktop): the owner's day, Google Calendar, a budget in
Hong Kong dollars, and a chat room with Shiro. Not built yet; these are the reference for building it.

| File | Screen |
|---|---|
| `Main.dc.html` | Desktop · today: schedule, to-dos and Canvas deadlines, the month's spending, this week |
| `Calendar.dc.html` | Desktop · calendar: month grid (Google Calendar events in blue, Canvas deadlines in gold), the selected day |
| `ShiroChat.dc.html` | Desktop · chat with Shiro: chat / narration tabs; what she did shows as a card with an undo |
| `Budget.dc.html` | Desktop · budget: totals against the budget, spending per day, per category, the list |
| `PhoneToday.dc.html`, `PhoneCalendar.dc.html`, `PhoneShiro.dc.html`, `PhoneBudget.dc.html` | The same on a phone (390 × 844) |
| `canvas.json` | How the screens are laid out on the design canvas |

Decisions behind them:

- The home screens carry no chat; Shiro is talked to only in her own room.
- No avatar and no voice in the web app; those will be a separate program. Her small face is a profile picture only.
- No notes section.
- The calendar is Google Calendar's primary calendar as it is; events she added are not marked apart.
- Colours come from her artwork: white ground, black ribbon for text and emphasis, her blue eye (`#1F7FB8`) for her
  actions and buttons, her gold eye (`#8A5710` on `#FBF1DF`) for deadlines. Type: IBM Plex Sans KR.

All dates, events and amounts are made-up examples.

The files are in the `.dc.html` format of the design canvas they were drawn on: plain HTML plus a small template
script, and images referenced as `/_blob/…` uploads that only resolve on that canvas (both are crops of
`avatar/shiro_base.png`). Opened straight from the repository they render without the runtime, so read them as
markup, or view them on the canvas.
