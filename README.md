# Tap-In Welcome

Entrance check-in and big-screen welcome for PSSDC training programmes. Feature 1 of the gesture training suite.

- **Programmes:** the organiser signs in with the PIN and opens a portal per programme (name, programme code, coordinator). Each gets its own QR code, welcome screen and register.
- **Check-in / tap-out** (`/#kiosk/CODE`): attendee picks a title (Prof, Dr, Mr, Mrs, Miss), enters name and MDA; the camera snaps their photo when they tap *Check me in*.
- **Welcome screen** (`/#display/CODE`): greets each arrival with *Ẹ káàbọ̀ / You are welcome* and each departure with *Ó dàbọ̀ / Goodbye*, then files them into the numbered list.
- **Coordinators:** each programme has its own coordinator PIN. With the coordinator link (or link code + PIN on the menu) they open that programme's register, screens and QR code, and can close or reopen it.
- **Register** (`/#register/CODE`): attendance with time in, time out and duration; downloads as CSV for Excel.
- **QR poster** (`/#qr/CODE`): full-screen QR code to project or print.
- **Logos:** add `assets/pssdc-logo.png` and `assets/lagos-logo.png`; they show at the top left of every screen.

Static site (no build step) hosted on Vercel; data and photos in Supabase.

## Setup

1. **Database:** open Supabase → SQL Editor → New query, paste `supabase/setup.sql`, change the organiser PIN on the marked line, and run it. Then run `supabase/upgrade-2-programmes.sql` and `supabase/upgrade-3-coordinators.sql` the same way, in that order.
2. **Key:** put the project's *anon public* key in `config.js` (Supabase → Project Settings → API). Never use the `service_role` key.
3. **Hosting:** Vercel deploys automatically from the `main` branch. Framework preset: *Other*; no build command.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure for all three modes |
| `styles.css` | Look and feel |
| `app.js` | Camera, check-in, live welcome screen, organiser actions |
| `config.js` | Supabase URL and public key |
| `supabase/setup.sql` | Tables, access rules, live updates, photo bucket |

## Privacy

Check-ins and photos are readable through the public key because they are shown on the public welcome screen. Attendees give consent on the form. Use *Clear all check-ins* after each programme.
