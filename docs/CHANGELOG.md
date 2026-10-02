# Chronix Edu — Changelog

## The ERP can now pull Chronix's revenue number (2026-10-02)

### For Chronix administrators
- The shared key the ERP uses to ask edu for the current revenue total is set in production, and the connection has been tested live end to end — a real request, with the real key, came back with a real answer.
- That answer is ₦0 right now, correctly: no school is a paying customer yet, so there's nothing to total. It will show real money the moment a real school pays, with nothing further to build or switch on.

## A school can pay its own Chronix subscription online (2026-10-02)

### For schools
- Settings → Platform Billing (principal, bursar) shows what the school currently owes Chronix, when it's next billed, and a "Pay now" button that opens Paystack. There's no late fee and no partial amount — it's always the current per-student rate, same as the amount already shown.
- A school whose trial has lapsed into read-only can still use this page to pay and restore full access itself, without contacting support.

### For Chronix administrators
- The amount a school pays is fixed the moment they start checkout, and a payment that comes back verified at a different amount is refused rather than accepted — so a price change or a stale page can't settle for the wrong figure.
- A trial school and a cancelled subscription can't be charged — checkout refuses both before ever reaching Paystack.

## The school-deletion script reports real login accounts (2026-10-02)

### For Chronix administrators
- Before deleting anything, the deletion script now says how many of the school's users actually have a login, for example "0 (of 6 users; the other 6 have no login)". It used to count every user as an account.
- It only removes logins that exist, and retries a brief network error before stopping. A failure that persists still stops it before anything in the database is touched.

## Shorter messages on the password-reset page and after adding people (2026-10-02)

### For schools
- When a password-reset link cannot be used, the page now says what happened in one short sentence, for example "This link has already been used, or it has expired." The "Request a new link" button is right there. The longer explanations are gone.
- After adding parents or staff, the screen now says simply whether the welcome email was sent, and who to help if it was not.

## Signing in takes about half a second instead of two and a half (2026-10-02)

### For schools
- The app now runs in Europe, beside its database. It used to run in California, so every step of signing in crossed the Atlantic twice. In the server, signing in now takes about 0.4 s, down from about 2.6 s, and every page's data loads faster for the same reason.

## A password-reset link that does not work now says why (2026-10-02)

### For schools
- If a reset link cannot be used, the page now says which reason applies:
  - the link was already used or has expired (some email services use a link up by checking it before you click);
  - the page was opened without a link;
  - the problem is on our side, not with your link.

  It used to show the same "invalid or expired" message every time.
- If your new password is refused, the page shows the reason instead of saying the link expired.

### For Chronix administrators
- A reset link that cannot be used is now recorded on the server. A link the page cannot read, or a login with no account behind it, raises an alert.

## Signing in again waits for one round trip less (2026-10-02)

### For schools
- Before every request to the server, the browser first asks whether the request is allowed. It used to forget the answer after 5 seconds, so every sign-in and most pages waited for that extra exchange. It now remembers it for 2 hours. The first visit of the day still makes it once.

## Failed emails are no longer kept forever (2026-10-02)

### For Chronix administrators
- An email the provider refused is kept for retrying for 7 days, then deleted, whether it was eventually sent or not. Until now none was ever deleted.
- The old queue has been emptied. It held 1,990 such emails, most of them welcome emails from before 1 Oct that contained a temporary password. None of those passwords still worked.

## New staff and parents set their own password (2026-10-01)

### For schools
- The welcome email for a new parent or staff member no longer contains a password. It says the account is ready and how to set a password with "Forgot password" on the login page.
- Adding a parent, or registering a student with a parent, asks for the parent's email address twice. The second box does not accept pasting.
- Before a bulk import of students or staff, the screen lists every email address it will create an account for and email. You tick to confirm them before importing.
- After adding people, the screen says plainly whether the welcome emails went, and names anyone whose email did not.
- Staff added by bulk import set their own password with "Forgot password", so nobody else ever sees it.
- Unchanged: the registrar's screen and the import results sheet still show temporary passwords for students and parents.

### For Chronix administrators
- Completing onboarding now says the welcome email was NOT sent when the email service refused it. It used to say "sent" whenever email was configured.

## Adding people no longer fails at random (2026-10-01)

### For schools
- Adding a student, parent or staff member, one at a time or in a bulk import, could occasionally fail with an error. A random six-digit support code given to every new account sometimes matched one already in use. New codes are now always unused, and nothing about existing accounts changes.

## Failures that used to vanish now raise alerts (2026-10-01)

### For Chronix administrators
- New alerts:
  - a new parent's or staff member's welcome email failing to go out;
  - an announcement or message notification failing;
  - a deleted platform admin's sign-in account failing to be removed.
- The end-of-session student promotion now reports when its audit record could not be written.
- A support session's revoked-token check now reports when Redis cannot answer it. Behaviour is unchanged: the session is still let through, and the ended-session check still applies.
- When email is not configured, platform announcements no longer print each recipient's address and the message to the server log.

## A new principal sets their own password (2026-10-01)

### For schools
- A new school's principal now receives an email with a link to set their own password. Nobody at Chronix sees it or passes it on.
- If the link has expired by the time it is opened, "Forgot password" on the login page sends a new one to the same address.

### For Chronix administrators
- Onboarding asks for the principal's email address twice, and the second box does not accept pasting.
- No temporary password is shown any more: there is nothing to copy or pass on.
- Completing onboarding needs a second tick: that you read the address back to the principal by phone and they confirmed it. It is recorded with your name and the time.
- If the server cannot send email, completing now says so plainly. It used to say "Welcome email sent" either way.

## Chronix is told when something breaks quietly (2026-10-01)

### For Chronix administrators
- The API now raises a Sentry alert, which emails the team, for a chosen list of problems it used to only write to its logs: Redis down (which switches off the login-guessing protections), email failing, password-reset emails failing, a parent or teacher notification lost, a payout-change alert not sent, a scheduled job failing, an audit record not written, a paid plan stuck in trial, a school without a recognised plan, SMS failing while switched on, the database certificate nearing expiry, and the payment return address missing.
- Each problem sends at most one alert every 15 minutes, so an outage is one email, not thousands.
- Alerts carry technical details only: never an email address, name or phone number.
- A restart no longer sets off a false "Redis is unreachable" alert. The login-guessing protections waited for nothing at start-up and occasionally gave up before Redis had connected; they now wait for it, at start-up only.

## Password reset no longer reveals who has an account (2026-10-01)

### For schools
- "Forgot password" now gives the same answer for every email address: if an account exists, a reset link is on its way. Before, when the reset email could not be sent, it showed a technical error, and only for addresses that had an account, so anyone could check whether a given person was registered.
- The answer also arrives at the same speed for every address. The reset email itself is sent just after.

## Text messages are switched off (2026-10-01)

### For schools
- The app no longer sends text messages (SMS). Attendance alerts, fee reminders and result notices still reach parents in the app and by email, as before.
- The website and sign-in page now say "in the app and by email" where they used to promise SMS.

### For Chronix administrators
- SMS is off on purpose while Termii is not funded. A new setting, `SMS_ENABLED`, is the switch: texts go only when it is `true` and a Termii key is set. It is unset, so SMS is off, and the Termii keys stay in place for when SMS comes back. Before, every reminder and alert tried to text each parent and recorded a failure for each one. Now nothing is attempted, and each run logs one line saying SMS is off and why.
- When SMS is switched back on, a message Termii rejects is now logged. Before, those rejections were recorded nowhere.
- The feature-adoption figure for SMS counts only messages actually delivered.

## Error monitoring now covers the web app's server (2026-10-01)

### For Chronix administrators
- Sentry now receives errors and performance data from the web app's server and from its middleware. Before, only the browser side of the web app reported: the server half of Sentry was never started, because the file that starts it did not exist.
- Browser reporting is unchanged and was already working. Session replays keep text, form inputs and media masked, as before.

## Clearer errors, an optional motto, and search for platform admins (2026-10-01)

### For schools
- When something you enter is not accepted, the app now says which field and what is wrong ("Motto: Required", "Enter a valid email address"), instead of showing technical text.

### For Chronix administrators
- In onboarding, the motto is genuinely optional: leaving it blank no longer stops you on the Branding step.
- Clicking Next with a required field empty now shows what is missing, beside the field. Before, nothing happened. The Review step says why Complete is greyed out until the confirmation is ticked.
- The platform-admin area has the Ctrl K search too, for the ten platform pages. Its sidebar is grouped: Platform, Schools, Communication, Administration.

## Search for any page with Ctrl K (2026-10-01)

### For schools
- A **Search** button at the top right of every staff page finds any page you can open. Type part of its name or what it is for: "export" finds Data Export, and "pass mark" finds the grading settings. Each result shows where it lives.
- Open it with **Ctrl K** (**⌘K** on a Mac), or tap the button on a phone. Arrow keys move, Enter opens the page, and Esc closes.
- It only ever lists pages your role can open. It searches pages, not students or staff.

## Onboarding is five steps, and each school sets its own grading (2026-10-01)

### For Chronix administrators
- Onboarding a school now has five steps: Info, Branding, Calendar, Admin, Review. The Grading and Assessment steps are gone.
- The Calendar step asks for one term only, the one the school is starting in. The step that previously would not let you continue is fixed. Later terms are added from Settings → Academic Structure.

### For schools
- A new school starts with no grading scale, pass mark or assessment structure. The principal sets them in Settings, and nothing is filled in on the school's behalf.
- Results cannot be published until the class has a grading scale. The message says so and points to Settings → Grading Scale.

## Every new school is marked customer or demo (2026-10-01)

### For Chronix administrators
- Onboarding a school now asks whether it is **a customer** or **a demo or test school**, with neither preselected. Demo schools are left out of platform totals and revenue. Before, every new school counted as a customer unless someone changed it later.
- School names (and the onboarding email) are trimmed, so a stray space no longer makes two schools look the same in a list.

## Deleting a school now deletes everything (2026-10-01)

### For Chronix administrators
- The school-deletion script now removes a school's audit history, its users and the school itself, so a completed deletion leaves nothing behind. It checks that before it finishes and undoes the whole run if anything remains. The one record kept is a note that the deletion happened, naming the administrator who ran it.
- Running a deletion now needs `--operator <your email>`; the script refuses anyone who is not an active Chronix super admin.
- The script prints every email address and phone number it is about to remove, before removing them, so they can be cleared from SendGrid's suppression lists and named in a deletion request to Termii.
- See `docs/data-deletion-runbook.md` for the procedure.

## Principals can export their school's data (2026-10-01)

### For schools
- Principals have a new **Settings → Data Export** page: every record the school holds, one spreadsheet (CSV) per kind: students, parents and staff, classes, attendance, scores, results, report-card records, fees and payments, timetables, assignments, notices, messages and more. Each download is recorded in the school's audit log.
- It keeps working when a school is read-only after its trial, and the read-only notice now points principals to it.
- The home page now describes what we actually do. Parents get an SMS when a student is absent **three times within a week** (the page said "three days running"); school data is kept separate by checks on every request (not "at the database level"); and we describe monitoring and uptime checks rather than round-the-clock monitoring or automated backups.

### For Chronix administrators
- Error reports sent to Sentry no longer include users' email addresses, only their user id.
- A school's data can now be deleted with a tested script, following `docs/data-deletion-runbook.md`. It also fixes a database rule that made deleting a school's assessment setup impossible.

## One plan, termly billing, and a gentler end to the free trial (2026-09-30)

### For schools
- When a free trial ends, nothing is locked straight away. There are 14 more days with everything working, and a notice at the top of every page says how many are left.
- After that the school becomes read-only rather than suspended: everyone can still sign in, see and export every record — results, attendance, report cards — but new changes are paused until the subscription is renewed. Before, the whole school was shut out the morning the trial ended.
- The pricing page now shows one plan, Premium, at ₦800 per student per term with every feature included. Enterprise is an enquiry for boarding schools and multi-campus groups. The Basic plan has been removed.

### For Chronix administrators
- Subscriptions can be billed per term, and new ones are termly by default. The next billing date for a termly school is the start of its next term; when that term has not been set up yet, the screens say so instead of showing a blank.
- Monthly recurring revenue now counts a termly subscription as a quarter of its term amount, everywhere it is shown. The schools list's "MRR" column is now "Amount", because it shows what each school is billed, not its monthly share.
- Recording a payment against a trial that has lapsed restores the school and moves it to Premium. Extending a trial also works after it has lapsed.

## A school that upgrades from a trial stays active (2026-09-30)

### For Chronix administrators
- Changing a school's plan from Trial to a paid plan now also ends the trial status, so the nightly trial check can no longer suspend a paying school. One school was suspended this way on 8 September; its subscription has been repaired.
- The nightly check never suspends a paid plan, and a trial now lasts through its end date: a trial ending on the 8th is usable all of the 8th and expires the next morning.
- Recording a payment against a suspended subscription reactivates the subscription and the confirmation says so. Reactivating the school itself is still a separate action.
- A suspended subscription can be reactivated from the school page. Before, it could only be suspended.

## Billing screens say why a school's figure is low (2026-09-30)

### For Chronix administrators
- The schools list now shows two numbers side by side: students **billed** (enrolled in the current session) and students **on the roll**. They differ when students have been registered or imported but not yet placed in a class.
- The Create Subscription form explains a low or zero amount in words: no current academic session; students on the roll but none enrolled yet; or some students not yet enrolled and therefore not billed. Before, each of those looked like the same bare number.

## Platform billing counts the students a school is teaching now (2026-09-30)

### For Chronix administrators
- A school's subscription amount is worked out from the students enrolled in its **current** academic session, each counted once — not from everyone who has ever been on its books. A school that has graduated three cohorts is no longer charged for them.
- The amount is recomputed automatically when students are enrolled or withdrawn and when the session rolls over. It is no longer typed in: the Create Subscription form shows the count, the rate and the amount it will be billed, and says plainly when it cannot be priced (no rate configured, or no current session).
- No money has been collected and no rate is set yet; this fixes the number before anything is charged against it.

## A shorter menu for principals (2026-09-30)

### Settings is one entry, and the daily work is grouped
- A principal's sidebar had 22 links, half of them settings that are changed once a year sitting at the same weight as Results and Attendance. It is now 12: the eleven everyday links in four labelled groups (Overview, Academics, Students, Communication) and a single **Settings** entry.
- Opening Settings shows a page listing every settings screen with a line on what it is for, grouped into Setup, Grading & Reports and Fees, with the same list beside you on every settings screen. It used to jump straight to School Identity.
- Two confusing names fixed: the report-card *template* is now "Report Card Template" (it sat next to "Report Cards", the thing you generate), and "Grading Scale" is now "School-wide Grading", next to "Grading by Level", so the relationship is visible.
- Nothing moves on its own: the menu is in the same order every time you sign in.

## Sign-in keeps working through a hiccup in its supporting service (2026-09-30)

### The app no longer goes down if the attempt-counting service does
- If the service that counts sign-in attempts and remembers recent lookups is briefly unavailable, sign-in and the rest of the app now carry on instead of failing. During such a moment the "too many attempts" protection is paused; the moment is recorded for review.
- The limit on wrong passwords from one school's connection is now 20 a minute (it was 5). After five wrong passwords for one account, that account still locks for 15 minutes.

## Limits apply to each visitor, not to everyone at once (2026-09-30)

### Sign-in protection now counts each person separately
- The app was identifying visitors by the address of the hosting provider's relay, not their own. So the limits on wrong passwords and on requests per minute were being shared by everyone using the app at the same time, and one person's mistakes could count against another. Each visitor is now counted on their own.
- The address recorded against administrator actions in the audit trail is now the administrator's own. Entries before 30 September 2026 hold the relay's address instead.

## Correct passwords are never refused for "too many requests" (2026-09-30)

### Signing in several times in a row works
- Signing in successfully no longer counts towards the sign-in limit. Only wrong passwords do. Before, the sixth correct sign-in within a minute from the same internet connection was refused — which a staff room sharing one router would hit at the start of the day.
- Protection against password guessing is unchanged: after five wrong passwords for an account, it is locked for 15 minutes.

## Logging in again no longer says "Too many requests" (2026-09-28)

### Normal use of the app no longer uses up the login limit
- Logging in, using the app, then logging in again within a minute could be refused with "Too many requests, please try again later." Every page you opened was being counted against the login limit. Now only sign-in requests count towards it.
- The protection against repeated password guessing is unchanged.

## Honest notification messages (2026-09-28)

### Publishing and returning results say whether notifications really went out
- When results are published, the confirmation now reports whether parent notifications were actually queued. If they could not be, it says so plainly instead of claiming they were — so the school knows to tell parents another way.
- The same for returning results to teachers.
- Low-attendance and behaviour alerts, and several settings changes, no longer lose their record silently if saving it fails.

## Grading by Level (2026-09-28)

### Different pass marks and grading scales for different sections
- New **Grading by Level** settings page. A school running, say, a primary and a secondary section can give each its own pass mark, its own grading scale, or both — report cards and the at-risk list already use them.
- A level left on *Same as school-wide* keeps following the school's Grading Scale settings, including later changes. A level given its own value keeps it.
- The page warns about levels spelled two different ways (e.g. "JSS" and "jss"), which are treated as separate levels, and about saved settings for levels no class uses any more.

## Notices (2026-09-27)

### Staff can post class notices
- New **Class Notices** page for principals and teachers. The student Notices page had no way to be filled — nothing in the product could create a notice.
- A notice goes to one class and appears on those students' Notices page. Teachers can post to classes they teach; principals to any class.
- Notices can be taken down by anyone who may post to that class, so a cancelled or mistaken notice does not sit there for the rest of the term. They cannot be edited, and the form says so before you post.
- To reach the whole school, use Announcements — that is the one that notifies and emails. The notices page links to it.

## ERP Integration (2026-09-27)

### Revenue figures are exchanged in kobo
- The ERP revenue endpoint and the super-admin MRR breakdown now report whole kobo rather than naira with decimals, so no figure can arrive with a repeating fraction attached.
- Displayed amounts are unchanged.

### Chronix ERP can pull platform revenue
- A new machine-to-machine endpoint reports current monthly recurring revenue by plan, for the Chronix ERP to read.
- It is aggregate only — no school names, no student or parent data.
- It stays switched off until a shared key is configured, and answers "not configured" rather than serving anything.

### One revenue figure instead of two
- The super-admin revenue snapshot counted every active subscription, while the platform overview excluded demo and suspended schools — so the same product could report two different MRR figures.
- Both now read the same calculation, which excludes demo and suspended schools. The ERP reads it too.

## Principal's Remark (2026-09-27)

### Principals can now write the remark that appears on report cards
- The report card has always had a space for the principal's remark, but there was no way to write one — so it was blank on every report card ever issued, next to a form teacher's comment that worked.
- Principals now write it from a student's profile. It appears on that student's report card for the current term.
- Saving replaces the previous remark for the same term rather than adding another, and clearing it removes it, with a warning before you do.
- Every change is recorded in the audit log, including what the remark said before.

## Part Payment for Parents (2026-09-27)

### Parents can now pay part of a term's fees online
- Previously every online payment had to be the whole outstanding balance, so a parent who could pay some of it had to go to the school office for a bursar to record cash.
- The Parent Portal now offers **Pay in full** or **Pay part**, and shows what will still be owed before the parent commits.
- Receipt emails state the outstanding balance, so a part payment is never mistaken for settling the fees.

### Schools set their own smallest part payment
- **Settings → Fee Settings** sets the least a parent may pay at a time. It starts at ₦1,000, and the page says plainly that this is the Chronix default rather than your school's figure.
- Your school pays the card processing fee on each payment, so a very low minimum means paying that fee repeatedly for the same money. The page explains the trade-off in both directions.
- **A parent settling the whole remaining balance can always do so**, even when that balance is smaller than the minimum.

## Payment Receipts (2026-09-27)

### Receipt emails now say what is still owed
- A payment confirmation told parents only the amount received. It now states the outstanding balance and the term total, or says plainly that the fees are settled.
- The outstanding amount also appears in the subject line, so it is visible without opening the email.
- An overpayment credit reads as settled rather than showing a negative balance.

## Fee Payments (2026-09-26)

### Paying the exact remaining balance is no longer refused
- A parent or bursar paying off an invoice in full was sometimes told the amount was an overpayment and the payment was rejected — for example an invoice of ₦250,000 with ₦83,333.33 already paid would refuse the remaining ₦166,666.67.
- Fee arithmetic is now exact, so an exact settlement is always accepted and an invoice reaches a balance of exactly zero.
- Genuine overpayments are still refused for cash, bank transfer and waivers, down to the kobo. Paystack overpayments are still recorded as a credit, unchanged.

## Report Card Grades (2026-09-26)

### An unscored subject no longer prints as a fail
- A subject with no scores entered showed a dash in the score column and a bold red **F** in the grade column of the same row. The report card contradicted itself.
- It now shows a dash in both, in neutral grey.

### Schools on other grading scales get their own grades
- The grade column could only ever print A, B, C, D or F. A school using the WAEC scale (A1–F9), a word scale (Excellent/Credit/Pass/Fail) or a numeric one had every grade replaced with F on the printed report card — including a score of 80.
- Grades now print exactly as the school configured them, whatever the scale. Colour is chosen by where the grade sits in the school's own scale, so the best grade is always green and the lowest always red.
- This did not affect Chronix High School, which uses the standard A–F scale.

### No promotion decision for a school that never set a pass mark
- A Third Term report card printed **Promoted** or **Repeat Class** using a built-in pass mark of 40 whenever a school had not set its own. That is a decision about a child's year, made with a number the school never chose.
- It now prints **Not determined** until the school sets a pass mark in Settings.
- Students are likewise no longer listed as at-risk against a pass mark the school never set.

### Principals see each student's grade in the Students list
- The list now shows term grade alongside average and position, from the school's own grading scale.
- A dash means no scores yet, or that the school has not configured a grading scale.

### Report cards and transcripts use the school's own scale, always
- Both documents carried a built-in 70/60/50/40 scale used whenever a school's own scale could not be read — so a school could receive a report card graded against a scale it had never agreed to. That fallback is gone.
- The overall average and grade on a report card now come from the same calculation as the approval screen and the principal's student list, so the three cannot disagree.

## Result Review for Principals (2026-09-26)

### Principals can now see the results they are approving
- The approval screen showed only subject name, teacher name and how many students had been scored. Approving from that confirmed the teacher had finished entering marks — it said nothing about whether the marks were right.
- **Review results** on a class now opens every student against every subject, with weighted totals, grades, overall average and position.
- **View scores** on a subject row opens that subject's marks as the teacher entered them, broken down by CA1, CA2 and Exam.
- Both views are read-only. Approve, publish and return are unchanged and still live on the approval screen.
- A dash means no score has been entered, which is deliberately shown differently from a zero.

### The Students list shows academic standing to principals
- Principals now see each student's term average and class position alongside the existing details, drawn from the same figures as the approval screen and report cards.
- Registrars see the list exactly as before — the academic columns are principal-only.
- Students with no scores yet still appear, with a dash rather than a zero, and the page works normally when no term is active.

## Platform Analytics Accuracy (2026-09-26)

### Platform totals now count customers, not database rows
- The super-admin overview counted every school and every student in the database, including tenants created by automated tests. Total schools, total students, new schools this month, trials and MRR were all affected.
- These figures now exclude non-customer tenants (test fixtures, sandbox and sales-demo schools), which are marked separately from suspended schools.
- A suspended school still counts towards total schools — it is a customer whose access is paused — but no longer counts towards students, trials or revenue.
- The platform school list hides demo tenants by default, so they no longer appear on screen when the dashboard is shown to a prospective school.

### Audit logs cannot be deleted or edited
- The audit trail was documented as append-only, but nothing in the database enforced it — the application's own connection could have removed or rewritten entries.
- Deleting or updating an audit entry is now rejected by the database itself.

## Account Creation & Credentials (2026-09-26)

### Newly registered students and parents can now actually log in
- Registering a student created its login record **without creating the matching sign-in account**, so neither the student nor any parent created alongside them could ever log in — the password simply never worked.
- The parent side was the visible failure: parents were emailed a welcome message with credentials that could not work.
- Registration now creates the sign-in account first and links the record to it. Bulk import is fixed the same way.
- Accounts created before this change are affected and need to be re-registered.

### Every imported account now gets its own password
- Bulk import previously gave every account — students, parents and staff, at every school — the same fixed temporary password. Anyone who knew it could sign into a freshly imported staff account before its owner did.
- Each account now gets its own randomly generated temporary password, still requiring a change at first login.
- Staff and parents receive theirs by email. Students, who have no email address of their own, now have theirs printed in the import results spreadsheet, which asks you to hand them out privately and then delete the file.
- Bulk import is somewhat slower as a result — around 3.4 seconds per row, so a full 50-row file takes roughly three minutes to commit.

## Role-by-Role Audit — Result Visibility, Attendance & Behaviour Guards (2026-09-23)

### Results are no longer visible before publication
- Parents and students previously saw scores as soon as a teacher entered them — before subject submission, principal approval, or publication. The four routes that serve score data to those roles fetched the result status but never actually checked it.
- All four now require the term's result to be **published** before any score, average, grade or class position is returned (`routes/parent.ts`, `routes/student.ts`).
- Both results pages now show a clear "Results not published yet" message explaining that scores appear once the school has finished marking, instead of rendering an empty table.
- Previously only the report-card *PDF* was gated, which made the workflow look complete when it wasn't.

### Attendance history is restricted to a teacher's own classes
- Marking attendance always required being the class's form teacher or assigned to it; *viewing* a class's roster and 30-day history did not — any teacher could read any class in the school.
- Both attendance read endpoints now apply the same relationship check (`routes/attendance.ts`). Principals and super-admins are unaffected.

### Behaviour incidents must cite a class the student is actually in
- Logging an incident verified that the student and the class each existed, but never that the student was *in* that class, nor that the reporting teacher taught it — and a suspension notifies the parent immediately.
- Now validates the student's enrollment and requires the reporter to be the form teacher or assigned to that class for the current term (`routes/behaviour.ts`).

### Principal dashboard: at-risk students and teacher activity
- Two fully-built backend capabilities had no UI and were invisible to principals. The dashboard now shows students below the promotion cut-off (with how far short they are) and per-teacher submission progress with last score-entry date.

### Onboarding no longer demands the whole year's calendar upfront
- Sign-up previously required all three terms with exact start and end dates — six date fields a school usually can't answer months ahead.
- Onboarding now asks only for the term the school is actually starting in; the others are marked optional and can be left blank.
- Remaining terms are added later from Settings → Academic Structure.

### Term dates can now be corrected when the calendar shifts
- There was previously **no way to edit a term's dates** anywhere in the product — only to mark one current. A holiday change, strike or election that moved the calendar could only be fixed with direct database access.
- Principals can now edit a term's name and dates, with the change recorded in the audit log.
- Terms are also now prevented from overlapping each other (on both adding and editing). Overlapping terms previously caused attendance to be filed against an arbitrary one of them.

### Primary schools: assign a class teacher to a whole class at once
- A primary class teacher takes every subject in their class, but assignments could only be created one subject at a time — a dozen separate saves per class, and again for every class.
- A teacher can now be assigned to every subject in one or more classes in a single action. Re-running it is safe; existing assignments are left alone.

### Teaching assignments carry forward to the next term
- Assignments belong to a term, and nothing copied them forward — so every school rebuilt its entire teaching roster by hand at the start of every term.
- A term's roster can now be copied into another term, skipping anything already there.

### Schools running both a primary and a secondary section can grade them differently
- The grading scale and promotion cut-off were stored once per school, so both sections were forced to share one pass mark.
- A school can now override the grading scale and/or pass mark per class level, falling back to the school-wide values where no override is set. Applies to results, the at-risk list and report cards alike.

### Fixed: creating a teacher via the admin API could fail
- The account-creation endpoint accepted a teaching mode value the database doesn't recognise, which failed on save. It now accepts exactly the two valid modes.

### Parents can now see school notices
- Announcements could already target parents and did reach them as in-app notifications, but there was no page listing them — the only way to read one was the notification popup. Added a Notices page to the parent menu.

### Timetables now say *why* they're empty
- A blank timetable previously looked the same whether the school hadn't activated a term or simply hadn't built the schedule yet. The teacher page even said "No active academic term, or no periods have been assigned to you yet" because the two cases were indistinguishable.
- Teacher, student and principal timetables now state which it is, so a principal knows when the fix is to activate the term.

### Smaller corrections
- Viewing an older term's results showed the student's *current* class name next to the correct scores; it now shows the class they were actually in that term.
- Students can no longer open another class's timetable by changing the address (staff are unaffected).
- Parent and student sections now redirect other roles to their own home page instead of rendering an empty shell.
- School-wide announcements are now recorded in the audit log.
- A parent can no longer be linked to a student from a different school, enforced in the database itself.

### Teacher signature on class comments
- The class-comments page fetched the teacher's signature from an admin-only endpoint, silently received a permission error, and showed nothing. Added a self-scoped `users/me` endpoint and pointed the page at it.

## Staff & Payment Bulk Import, Data-Integrity Fixes, Security Hardening (2026-08-31 — 2026-09-17)

### Staff Bulk Import
- Fourth bulk-import feature (after Students, Roster): `.xlsx`/`.csv` upload → preview → commit for staff accounts (`services/staffBulkImportParser.ts`, `staffBulkImportValidation.ts`), with a shared fixed temp password, welcome emails, and a downloadable results file (`services/staffBulkImportResults.ts`).
- Entry point added to the Users settings page.
- Follow-up fix: surfaced real per-row failure reasons instead of a generic message, hashed the shared password once per request instead of per row, and guarded against a forged/stale commit status being trusted from the client.

### Bulk Payment Import (reconciling pre-Paystack payments)
- Lets a bursar bulk-record payments collected before a school went live on Paystack, without needing a corresponding online transaction: `.xlsx`/`.csv` upload → preview → commit, matching students by admission number (`services/bulkPaymentImportParser.ts`, `bulkPaymentImportValidation.ts`, `bulkPaymentImportResults.ts`).
- Entry point added to the Fee Structures page.
- Running-balance validation tracks each student's remaining invoice balance in-file-order so multiple rows for the same student are checked cumulatively, not independently.
- Follow-up fixes: an unrelated validation error on a row no longer incorrectly consumes that student's running balance; audit-log failures are now decoupled from payment outcome so a logging failure can never retroactively mark an already-successful payment as failed; date cells use UTC getters to avoid timezone-induced off-by-one-day shifts.
- The same results-file/audit-log safety fix was backported to the three earlier bulk-import features (Students, Roster, Staff) for consistency.

### Data-integrity fix: `students.admission_no` uniqueness scope
- **File:** `migrations/027_fix_admission_no_uniqueness_scope.sql`
- The column had a *global* `UNIQUE` constraint, but the admission-number generator only scanned the current school's students when picking the next number — two schools sharing the same prefix (e.g. the default "SCH") could collide. Changed to a composite `UNIQUE(school_id, admission_no)` constraint, scoping uniqueness correctly per school.

### Security hardening
- See `SECURITY.md` Round 8 (2026-09-01) and Round 9 (2026-09-17) for full detail: forced-password-change enforcement (`requirePasswordChanged` middleware), a Paystack double-delivery bug that could surface as a false payment failure or silently lose a real payment, a payout-settings step-up brute-force lockout, a `paystack_reference` schema-tightening fix, and a scores-subsystem fix preventing a teacher from writing grades for unenrolled students or silently overwriting another subject's score.

### Reliability fixes
- `apps/api/src/db/client.ts` now handles idle pooled-connection errors (e.g. Supabase's PgBouncer reclaiming a connection) via `pool.on('error', ...)` instead of letting the unhandled event crash the whole API process.
- Added a public `/health/ping` liveness endpoint (no auth, no sensitive detail) alongside the existing token-gated `/health`, for uptime monitors whose plan doesn't support custom request headers.

### Academic operations fixes
- **Term activation was completely missing** — `terms.is_current` could never be set to `TRUE` anywhere in the system (sessions had an Activate flow; terms never did), so every feature defaulting to "the active term" (timetable, score entry, attendance, results) silently broke for every school. Added `PATCH /:schoolId/sessions/:sessionId/terms/:termId/activate` and the matching Activate button on the Academic Structure settings page.
- Principal dashboard stats (staff/student counts) were cached with nothing invalidating the cache on user creation — a newly created user wouldn't appear until the 5-minute TTL expired. Migrated to the shared `cacheService` so staff/student creation (single and bulk) can invalidate it on write.
- Report cards ignored a school's own "Primary Colour" identity setting (which already worked elsewhere, e.g. the settings nav preview) — both the classic and modern Handlebars templates hardcoded their own accent color. Wired `identity_config.primary_colour` through into a `--brand-color` CSS variable in both templates.
- The Roster bulk-import template had no explanation of its columns (in particular "Stream," an optional subject-track subdivision) — added an Instructions sheet with worked examples and per-column notes, with no change to headers/sheet names so existing filled-in templates still import correctly.
- Two workflows that already worked end-to-end had no way for a principal to discover them: added a "Students" link to the principal nav (parent-linking happens on the student-creation form, previously only reachable via the registrar nav) and a direct link to Settings → Roster in the post-creation success banner when a teacher is created (class/subject assignment is a separate step). The student bulk-import results screen now also displays each created student's admission number on screen (previously only in the downloadable file).

## Payout, Plan Gating & Bulk Import (2026-08-06 — 2026-08-20)

### School Payout via Paystack Subaccounts
- Parent fee payments now settle directly to each school's own bank account via
  Paystack Subaccounts (`services/paystackService.ts`: `listBanks`,
  `resolveBankAccount`, `createPaystackSubaccount`), at 0% platform fee —
  Chronix's account receives nothing from these transactions. Full design in
  `docs/superpowers/specs/2026-08-06-school-payout-subaccounts-design.md`.
- New bursar/principal-facing payout settings page (bank select → resolve →
  confirm) at `GET/POST/PUT /:schoolId/settings/payout`, with a narrow access
  carve-out so bursars reach only this page under Settings.
- Fee payment initiation is blocked with `PAYOUT_NOT_CONFIGURED` until a
  school's payout is active, replacing the previous single pooled Paystack
  account.
- 3-way fraud alert fires on every bank-details change (create or update):
  the principal (email + SMS), the school's own official email, and the
  platform root admin — each an independent, timestamped record.
- Super-admin schools list gained a Payout status column (Active/Pending).
- Hardening after a whole-branch review: an active payout config is no
  longer wiped on a transient Paystack failure; bank changes made during a
  support session are attributed to the real admin, not the impersonated
  bursar; `GET /onboarding/:sessionId` no longer leaks the unmasked account
  number; added cross-tenant isolation tests.
- Payout error responses moved from `502` to `424 Failed Dependency` after
  confirming Railway's edge replaces `5xx` bodies with a generic error page,
  destroying the real Paystack error message before it reached the browser.

### Plan-Based Feature Gating & Pricing
- Plan enum simplified from `trial/basic/professional/enterprise` to
  `trial/basic/premium/enterprise`. Full design in
  `docs/superpowers/specs/2026-08-06-plan-based-feature-gating-design.md`.
- `schools.subscription_tier` is now kept in sync with `platform_subscriptions`
  on every create/update and included in the login JWT payload.
- New `planIncludesFeature`/`schoolAllowsFeature` module gates SMS sending,
  online Paystack fee collection (payout settings + initiate), and the
  analytics dashboard to Premium/trial/enterprise — Basic-tier schools keep
  results, attendance, timetable, portals, messaging, and fee invoicing/manual
  payment recording. Basic-tier fee reminders skip the SMS leg but still send
  in-app + email.
- Corresponding UI (payout nav, pay-now button, analytics link) is hidden for
  Basic-tier schools.
- Homepage `#pricing` rewritten around the new per-student pricing: Basic
  ₦400/student/term, Premium ₦600/student/term (recommended), Enterprise at
  custom pricing — replacing the old 4-tier monthly/annual grid.

### Subscriptions & Fees
- New trial subscriptions default to 30 days.
- `amount_naira = 0` is now accepted when creating a trial subscription
  (paid plans still require a positive amount).
- Manual (cash/bank-transfer) invoice payments now go through the same
  overpayment guard the Paystack-initiated flow already had — recording a
  payment larger than the outstanding balance now returns
  `400 AMOUNT_EXCEEDS_BALANCE` instead of silently pushing the balance
  negative.

### Student & Parent Bulk Import
- New upload → preview → commit flow for registering many students (with up
  to two parents each) from a single `.xlsx`/`.csv` file, reusing the same
  registration logic as the single-student form. Full design in
  `docs/superpowers/specs/2026-08-19-student-bulk-import-design.md`.
- Every bulk-imported account gets the fixed temporary password
  `Password2$` and is forced to change it on first login; a downloadable
  results file lists what was created.
- Row cap lowered from 200 to 50 per file after measuring real per-row
  commit time; the JSON body limit was raised so a full 50-row commit
  payload can actually reach the server.
- Follow-up hardening: uploaded file content is validated instead of ever
  500ing on a malformed file, field-length limits now match single
  registration, emails are lowercased, name-less rows are no longer
  silently dropped, row numbering and duplicate detection were fixed, and
  the downloadable template's example row was made unmistakably a
  placeholder.
- Entry points added on the Students page and a dedicated import page.

### Roster Bulk Import
- Same upload → preview → commit pattern extended to Roster setup: a single
  `.xlsx` workbook (no CSV — three sheets don't fit a flat format) with
  Classes, Subjects, and Teacher Assignments sheets, capped at 300 rows
  combined. Full design in
  `docs/superpowers/specs/2026-08-20-roster-bulk-import-design.md`.
- Teacher Assignment rows resolve only against pre-existing classes/subjects
  (not ones created earlier in the same file), committed in a fixed
  Classes → Subjects → Assignments order.
- Entry points added on the Roster settings page and a dedicated import page.
- Roster settings page itself gained a Settings nav link — the page existed
  and worked but had no way to discover it from the sidebar.

### Support Sessions & Account Management
- Every user now has a short 6-digit support code (shown under their email
  in the sidebar) so a platform admin can start a support (impersonation)
  session by code instead of a raw UUID.
- Starting a support session now actually swaps the admin into the target
  user's session and dashboard (with an "Exit Support Session" banner to
  restore their own login), instead of just displaying an unused JWT in a
  modal.
- New `PATCH /:schoolId/users/:userId/email` lets `super_admin` reassign a
  school account to a new hire's email (e.g. principal handover), rotating
  the Supabase and local password together in one transaction so the
  departing holder can't log in as the new owner.

### Messaging, Notifications & Onboarding Polish
- An open inbox/thread now polls for new messages every 12s instead of
  requiring a manual reload.
- Stopped sending a redundant email on every new in-app message.
- Bursar and registrar are now valid announcement/messaging audiences and
  contacts, with their own read-only announcements view and Messages pages.
- School onboarding's assessment-components step (previously a fixed
  CA1/CA2/Mid-Term/Exam list) now supports adding/removing rows.
- Outgoing email now shows "Chronix Edu" as the sender name instead of the
  raw from-address.
- Timetable builder gained tap-to-place support for touchscreens, alongside
  existing mouse drag-and-drop.

### Housekeeping
- Several CI/test-infrastructure fixes: a stale duplicate root Jest config
  that skipped fixture seeding, tests silently depending on leaked mock
  state or stale fixtures, a broadened `seed-test-user` dev/test guard, and
  an unblocked CI unit-test job that no longer needs real DB/Supabase
  credentials.

---

## Phase 3 — Payments, Messaging, Analytics & Timetable (2026-06)

### Fees & Payments (Paystack)
- Per-term fee structures (line items) and per-student invoices (`migrations/011_add_fees_tables.sql`).
- Payment recording for `cash`, `bank_transfer`, `paystack`, and `waiver` methods.
- Live Paystack transaction initialization, verification, and webhook signature
  verification (`services/paystackService.ts`).
- PDF receipt generation (`services/receiptService.ts`).
- Outstanding-balance and collection-summary reporting for bursars/principals.
- Weekly automated fee reminder cron — in-app notification + email (SendGrid) +
  SMS (Termii), throttled per parent (`services/feeReminderService.ts`).

### SMS Notifications (Termii)
- `services/termiiService.ts` sends transactional SMS via the Termii API, using
  a per-school sender name from `school_settings.notification_config` with a
  configurable fallback (`TERMII_SENDER_ID`).
- SMS delivery is logged and rate-limited per recipient via
  `db/queries/notificationLogs.ts`.

### Analytics Dashboards (Recharts)
- Nightly analytics snapshot cron computing overall performance, subject
  performance, attendance summary, and fee collection per school/term
  (`services/analyticsService.ts`, `migrations/012_add_analytics_tables.sql`).
- `/api/schools/:schoolId/analytics` exposes the latest snapshot plus
  trend deltas against the previous snapshot for Recharts-based dashboards.

### Timetable (@dnd-kit)
- Drag-and-drop weekly timetable builder backed by
  `migrations/013_add_timetable.sql`, with class- and teacher-clash detection
  (`db/queries/timetable.ts`, `routes/timetable.ts`).
- Class and teacher timetable views for staff and teachers.

---

## Phase 3 Hardening — Backend Reliability & Observability (2026-06-12)

### Startup environment validation (E2)
- `apps/api/src/config/env.ts` validates all required environment variables
  with Zod on boot (`DATABASE_URL`, `JWT_SECRET`, Supabase keys, etc.) and
  throws a single combined error listing every missing/invalid var. Wired
  into `index.ts` before the Express app is created.

### Query performance — new indexes (migration 015)
- Ran `EXPLAIN ANALYZE` against the live database for the dashboard,
  teacher-activity, and audit-log queries used by
  `db/queries/dashboard.ts` / `db/queries/auditLog.ts`.
- Added composite indexes for filter predicates that lacked coverage
  (`migrations/015_add_dashboard_query_indexes.sql`):
  - `scores (school_id, term_id)`
  - `users (school_id, role)`
  - `audit_logs (school_id, action_type, created_at DESC)`

### Structured JSON error format (C6)
- Audited every route for the `{ success: true, data }` /
  `{ success: false, error: { code, message } }` envelope.
- `apps/api/src/routes/auth.ts` and `apps/api/src/middleware/auth.ts` were the
  only non-conforming files — `create-user`, `login`, `seed-test-user`, and
  `test-role` now return the standard envelope, and `verifyToken` /
  `requireRole` now return `{ success: false, error: { code: 'UNAUTHORIZED' | 'FORBIDDEN', message } }`.
- Updated `apps/web/app/(auth)/login/page.tsx` and `apps/web/app/providers.tsx`
  for the new `/api/auth/login` response shape (`data.access_token`,
  `data.user`).

### Rate limiting (S5)
- Extracted `generalRateLimiter` (100 req/min) and `authRateLimiter`
  (5 req/min) into `apps/api/src/middleware/rateLimit.ts` with a shared
  `handler` so 429 responses also use the standard error envelope
  (`RATE_LIMIT_EXCEEDED`).

### Winston structured logging (C4)
- Added `apps/api/src/config/logger.ts` (JSON-formatted Winston logger,
  `debug` outside production / `info` in production).
- Added `apps/api/src/middleware/requestLogger.ts`, logging method, path,
  status, and duration for every request.
- `errorHandler` now logs every unhandled error (message, stack, method,
  path) via the logger before responding.
- Replaced all remaining `console.log` / `console.error` calls across
  `apps/api/src` (auth routes, analytics/fee-reminder/notification cron jobs,
  email and Termii services) with structured `logger.debug` / `logger.error`
  calls.
