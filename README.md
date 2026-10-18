# Tap-In Welcome

Entrance check-in and big-screen welcome for PSSDC training programmes. Feature 1 of the gesture training suite.

- **Check-in** (`/#kiosk`): attendee picks a title (Prof, Dr, Mr, Mrs, Miss), enters name and MDA; the camera snaps their photo when they tap *Check me in*.
- **Welcome screen** (`/#display`): greets each new arrival full-screen with their portrait, then files them into a numbered arrival list with the time.
- **Menu** (`/`): links, the check-in QR code, and organiser controls (programme name, clear list) protected by a PIN.

Static site (no build step) hosted on Vercel; data and photos in Supabase.

## Setup

1. **Database:** open Supabase → SQL Editor → New query, paste `supabase/setup.sql`, change the organiser PIN on the marked line, and run it.
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
