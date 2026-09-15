# HTML LMS — Proctored HTML Coding Platform

A self-hosted LMS for teaching/testing HTML. Students write code in a left-pane editor and see a live-rendered
output in the right pane, inside a proctored exam session. Admins create students and exams, assign exams to
students, and watch a live monitoring dashboard that shows proctoring violations as they happen.

## Stack

- **Backend:** Node.js, Express, MongoDB (via Mongoose), JWT auth (httpOnly cookie), Socket.io for
  real-time events
- **Frontend:** Plain HTML/CSS/JS (no build step) + CodeMirror for the code editor, loaded from CDN
- **Database:** MongoDB — either a local `mongod` for development, or a free MongoDB Atlas cluster for
  anything shared or hosted

## Requirements

- Node.js 18 or newer. Check with `node -v`.
- A MongoDB connection. Pick one:
  - **Local (fastest for development):** `brew install mongodb-community` then `brew services start
    mongodb-community`. No further config needed — the app defaults to `mongodb://127.0.0.1:27017/html_lms`.
  - **Atlas (needed for anything beyond your own machine):** create a free cluster at
    mongodb.com/cloud/atlas, add a database user, allow network access from your IP (or `0.0.0.0/0` for
    simplicity while testing), and copy the connection string into `MONGODB_URI` in `.env`.

## Setup

```bash
cd html-lms
cp .env.example .env   # then edit .env if you're using Atlas instead of local MongoDB
npm install
npm run seed     # creates a default admin account
npm start         # starts the server on http://localhost:4000
```

Default admin login (created by `npm run seed`):

```
username: admin
password: admin123
```

**Change this password before real use** — easiest way is to create a new admin user directly in the database
(there's no "create admin" UI on purpose, to avoid students self-promoting) and retire the seeded one, or edit
the `users` collection directly with a new bcrypt hash.

Open `http://localhost:4000/login.html` to sign in. Admins land on `/admin.html`, students on `/student.html`.

## How it works

**Admin flow:** Students tab → create student logins one at a time, or import many at once from a CSV (see
below). Exams tab → create an exam (title, instructions, starter HTML, time limit, violation limit) and
assign it to one or more students — the assign dialog has "Select all" / "Clear all" buttons so a whole
class can be assigned in one click instead of checking each student individually. Live Monitor tab → shows
every exam currently in progress, live violation counts, and last-activity timestamps, updated in real time
over WebSockets. Click "View" on any row to see the student's live code and full violation log; locked exams
can be unlocked from there.

Click **"Edit"** next to any exam to change it later — title, instructions, starter code, time limit,
violation limit, and the auto-grading checks are all editable, reusing the same form as creating a new exam
("Save changes" replaces "Create exam" while editing; "Cancel edit" backs out without saving). Editing an
exam doesn't touch students who've already started it — their in-progress code is untouched, and starter
code only ever seeds an assignment that hasn't been opened yet; changes to checks simply apply the next time
a submission is (re-)graded.

**Continuing a submitted exam:** if a student needs to keep working after submitting — submitted too early
by mistake, ran out of time unfairly, whatever the reason — click **"Continue test"** in the assignment
detail modal, or **"Continue"** next to their row in the Submissions list. This puts the exam back into
`in_progress` and gives them a fresh full time limit starting from that moment (rather than immediately
re-expiring against the original start time); their existing code, and any test results from the earlier
submission, are left in place until they submit again.

## Classes/sections and bulk student creation via CSV

Students can optionally be tagged with a class/section (e.g. "CSE A") — set it in the "Add student" form,
via the CSV import (see below), or after the fact with the **"Edit class"** button next to any student in
the Students table. The Students table has a class filter dropdown, and the **"Assign exam to students"**
dialog groups students by class with a **"Select class"** button per group, so you can assign a whole
section in one click instead of checking students off a flat list (the existing global "Select all"/"Clear
all" buttons still work across every class at once). Students with no class set are grouped under
"Unassigned".

Under Students → **Import students from CSV**, upload a CSV with a header row of
`username,password,full_name,section` (`full_name` and `section` are both optional — a "Download sample
CSV" button gives you a template). Each row becomes a student account. Every account created this way has
**`must_change_password`** set, so the student is forced onto a "set a new password" screen the moment
they log in with the temporary password from the CSV — they can't reach anything else in the app until
they do (this is enforced on the server, not just hidden by the UI, so it can't be bypassed by calling the
API directly).

You can also force this for any individual student at any time — a **"Force change"** button appears next
to each student in the Students table (except ones already pending a change) for cases like a forgotten or
possibly-compromised password. If that student is mid-session when you do this, their very next action in
the app will redirect them straight to the password-change screen instead of completing whatever they were
doing.

Students can also change their password voluntarily any time via the **"Change password"** button in their
own top bar, without needing to be forced into it.

**Student flow:** Log in → see assigned exams → Start/Resume opens the exam in fullscreen. Left pane is the
HTML code editor, right pane is a live-updating sandboxed `<iframe>` preview. Code autosaves ~800ms after
each edit. Submit locks in the final code.

## Retrieving code and output later

Both the code and its rendered output can be pulled up again at any time, by either the admin or the
specific student who wrote it — this isn't limited to while an exam is "live":

- **Students** see a "View" button (instead of Start/Resume) on any exam that's `submitted` or `locked`.
  It reopens the saved code read-only, alongside an output pane that re-renders it live, plus their own
  proctoring log if the exam was locked.
- **Admins** click "Submissions" next to any exam in the Exams tab to list every student assigned to it —
  not-started, in-progress, submitted, or locked — and "View" any of them to see the current/final code,
  a live-rendered output pane, and the full violation history.

Output isn't stored as a separate file — it's a static re-render of the saved code. Since this is plain
HTML/CSS/JS with no server-side execution, re-rendering the exact saved code always reproduces the exact
same output, so there's nothing extra to keep in sync or go stale. (If you specifically need a frozen
screenshot captured at the moment of submission — e.g. for exercises with animations or time-based JS —
that's a separate feature; ask and it can be added, with `html2canvas` and some extra sandboxing care since
it touches the same cross-origin boundary that keeps student code from reaching the rest of the app.)

## Auto-grading

When creating an exam, admins can optionally add **auto-grading checks** under "Auto-grading checks" in the
Create Exam form. Each check is one of:

- **Element exists** (`selector_exists`) — a CSS selector must match at least a configured minimum number of
  elements (e.g. `table tr` with a minimum of 5, or `h1` with a minimum of 1).
- **Rendered text contains** (`text_contains`) — a substring must appear in the page's rendered (visible)
  text, with an optional case-sensitive toggle.
- **Raw HTML contains** (`html_contains`) — a substring must appear in the raw HTML source the student
  submitted (useful for checking for things like `<!DOCTYPE html>` or a specific attribute that produces no
  visible text).

Checks can also be added in bulk instead of one at a time. The **"Bulk add"** box above the check list
takes one check per line in the form `type|label|value|extra` (e.g.
`selector_exists|Has a heading|h1|1` or `text_contains|Contains welcome|Welcome|case`). Below that,
**"Import checks from a CSV file"** does the same thing from an actual `.csv` file — header row
`type,label,value,extra` — for cases where the checks already live in a spreadsheet (a "Download sample
CSV" button gives you a template). Either way, the parsed checks populate the same rows below, which can
still be edited or removed individually afterward.

Checks run automatically, server-side, the moment a student submits — using Cheerio to parse the submitted
HTML statically (no JavaScript execution, so this is safe to run without any sandboxing concerns). The score
is simply the percentage of checks passed. Both the per-check pass/fail with a short explanation, and the
overall score, are visible to:

- **Admins** — in the Submissions list (a colored score badge per row) and in the assignment detail modal
  (full per-check breakdown), which also has a **"Run tests"** button to re-run the checks on demand — handy
  if you edit an exam's checks after some students have already submitted.
- **Students** — in their own read-only "View" of a submitted/locked exam, as a dedicated "Test results"
  panel next to the code and output panes.

Exams with no checks defined simply show no score/test results anywhere — auto-grading is entirely optional
per exam.

## Proctoring — what's actually enforced, and what isn't

Browsers cannot give a web page control over the operating system, so a page **cannot literally prevent** a
student from alt-tabbing to another application — no website can do that; that level of lockdown requires a
dedicated native kiosk app (e.g. Safe Exam Browser) that takes over the whole OS session. What this LMS does
instead, entirely from the browser:

- **Forces fullscreen** at exam start; exiting fullscreen is immediately logged and blocks the student behind
  a "return to fullscreen" prompt.
- **Detects tab switches** via the Page Visibility API (`visibilitychange`).
- **Detects leaving the browser window entirely** via the `blur` event — this fires both when switching tabs
  *and* when switching to another application, so it's the closest browser-available signal to "switched
  programs."
- **Blocks and logs** right-click, copy, cut, and paste inside the editor.
- **Blocks and logs** common DevTools shortcuts (F12, Ctrl/Cmd+Shift+I/J/C, Ctrl/Cmd+U). This is a deterrent,
  not a real barrier — a determined student can still open DevTools another way — but the attempt is logged.
- **Blocks and logs reload shortcuts** (Ctrl/Cmd+R, F5) via `preventDefault()` on the keydown event, so the
  page doesn't actually reload.
- **Traps the back button.** Uses the History API to immediately push the student back onto the exam page
  the instant a back-navigation is detected (`popstate`), and logs it.
- **Catches exits the above two can't stop**, as a last resort: closing the tab, using the browser's own
  reload/back *button in its UI chrome* (not the keyboard shortcut), or quitting the browser. A page can
  never intercept clicks on the browser's own toolbar — that's a hard platform boundary, not a bug — so
  instead a `beforeunload` handler fires a `navigator.sendBeacon()` call (which, unlike a normal `fetch`,
  is specifically designed to still get delivered even as the page is being torn down) to log the exit
  attempt, and shows the browser's native "leave site?" confirmation as a speed bump.
- **Blocks text selection** everywhere on the exam page except inside the code editor itself (where
  selection is needed to edit). This closes off the older "long-press a word → select → search" flow
  some on-device search assistants use.
- Every violation is written to the database and pushed instantly to the admin's Live Monitor over
  Socket.io. Each exam has a configurable violation limit (default 5); hitting it **auto-locks** the exam
  and the student is shown a "contact your administrator" screen until an admin unlocks it.

**What's still not achievable from a webpage, and why:** a browser tab has no access to the operating
system, so nothing here can literally prevent alt-tabbing to another application, block screenshots, or stop
someone closing the laptop lid and using a second device — those require a dedicated native lockdown browser
(Safe Exam Browser, Respondus) pointed at this app's URL, or wrapping this frontend in an Electron kiosk app
that takes over the whole OS session. The same boundary applies to OS-level screen-search gestures on
mobile — Android's **Circle to Search** and similar Assistant/Bixby "search what's on screen" features work
by reading pixels directly off the display at the OS level, entirely outside any webpage's reach, so a
website genuinely cannot detect or block the gesture itself (only the older text-selection-based search
flow, which is blocked — see above). Every control above is a deterrent-plus-detection layer: it makes the
easy, absent-minded ways of leaving an exam either blocked outright or immediately logged, which is what a
browser-based tool can honestly promise. Say the word if you want the native-lockdown path built out.

## Deploying beyond your local network (GitHub + Render + Atlas)

Running `npm start` on your own Mac only serves the app on your machine/LAN. To make it reachable from
anywhere (students at home, different networks, etc.), you need to host it on a server with a public
address, and a database it's reachable from too. GitHub itself can't run this — GitHub Pages only serves
static files, and this app needs a live Node.js process and a WebSocket connection. What GitHub *can* do is
hold the source code and hand it to a host that runs Node apps. **Render** is the simplest option; paired
with a free **MongoDB Atlas** cluster for the database, this whole setup can run at no cost.

**1. Create a free MongoDB Atlas cluster**

- Sign up at mongodb.com/cloud/atlas, create a free (M0) cluster.
- Under **Database Access**, add a database user with a username/password.
- Under **Network Access**, add an IP allowlist entry — `0.0.0.0/0` (allow from anywhere) is the simplest
  option since Render's outbound IPs aren't fixed on the free plan.
- Click **Connect** on your cluster → **Drivers** → copy the connection string (looks like
  `mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/`). Fill in your password and add a database
  name at the end, e.g. `.../html_lms?retryWrites=true&w=majority` — you'll paste this into Render next.

**2. Push the code to GitHub**

This project already has a git repo initialized with an initial commit (see `git log` inside the folder).
Create an empty repo on github.com (no README/gitignore — just the empty repo), then from inside the
`html-lms` folder:

```bash
git remote add origin https://github.com/<your-username>/<your-repo>.git
git branch -M main
git push -u origin main
```

**3. Deploy to Render**

- Go to render.com, sign up/log in, and connect your GitHub account.
- Click **New +** → **Blueprint**, and select the repo you just pushed. Render detects `render.yaml` in the
  repo root and provisions the web service for you.
- Render will prompt you for `MONGODB_URI` (marked `sync: false` in the blueprint so it isn't hardcoded in
  git) — paste the Atlas connection string from step 1. `JWT_SECRET` is generated for you automatically.
- Click **Apply**. First deploy takes a couple of minutes. No persistent disk is needed — data lives in
  Atlas, not on Render's filesystem — so the free web service plan works.

**4. Seed the admin account and go live**

Render gives you a **Shell** tab on the service once it's deployed — open it and run:
```bash
npm run seed
```
Then visit the public URL Render gives you (something like `https://html-lms-xxxx.onrender.com/login.html`)
and log in with `admin` / `admin123`. Change that password soon after (see the note in Setup above).

**Updating later:** any `git push` to the connected branch triggers an automatic redeploy on Render. Since
data lives in Atlas rather than on the Render instance, redeploys never touch student data.

**Alternatives to Render:** Railway and Fly.io work similarly (connect a GitHub repo, they build and run
it) and pair with Atlas the same way. A plain VPS (DigitalOcean, Lightsail) works too but needs more manual
setup — SSH in, install Node, clone the repo, run it under a process manager like `pm2`, and put a reverse
proxy (Caddy or nginx) in front for HTTPS.

## Data model

Four MongoDB collections (see `server/models/`):

- `User` — admins and students, role-based, bcrypt-hashed passwords, plus a `must_change_password` flag
  used by CSV imports and the admin's "Force change" action
- `Exam` — title, instructions, starter code, time limit, violation limit, and an optional array of
  auto-grading `checks`
- `ExamAssignment` — one document per (student, exam) pair; tracks status (`not_started` / `in_progress` /
  `submitted` / `locked`), timestamps, **and the student's current/final code directly on the document** —
  there's no separate "submissions" collection since it's always a strict 1:1 relationship. Also stores
  `test_results` and `score` once auto-grading has run.
- `Violation` — every proctoring event, referencing the assignment/student/exam, with type/detail/timestamp

## Notes / next steps if you want to extend this

- Currently one HTML/CSS/JS blob per exam (single editor pane). If you want separate HTML/CSS/JS tabs, the
  editor and preview-building logic in `public/js/student.js` (`initEditor` / `updatePreview`) is the place
  to extend.
- No email/password-reset flow — admin sets student passwords directly.
- Auto-grading checks (element exists / text contains / HTML contains) run automatically on submit — see
  "Auto-grading" above. There's no rubric/partial-credit-per-check weighting yet — every check counts equally
  toward the score.
- For production use: put this behind HTTPS, set a strong `JWT_SECRET` in `.env`, and consider rate-limiting
  the login route.
