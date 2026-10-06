# Paystack runbook

For whoever holds the Chronix Paystack account, and for school bursars' questions. What Chronix Edu does
by itself, and what is done by hand. Written 6 Oct 2026. Facts about Paystack come from its own support
pages, read that day; the questions they leave open are in the email sent to Paystack (WORKING-CHECKLIST).

The pilot runs on Moses's personal Paystack account, in Live mode. Before a real school pays, Chronix's
business account replaces it (WORKING-CHECKLIST 3b): new keys in Railway, every school saves its payout
details again, and the settings below are made again in the new account.

## Settings to make in the Paystack dashboard

- **Live Webhook URL** (Settings → API Keys & Webhooks): the pilot school's own address,

      https://api.chronixtechnology.com/api/schools/f1347b5c-584f-43e5-ba05-6770139c6c8f/payments/paystack/webhook

  It credits every school's payments, not only the pilot's: a payment is matched by its own record
  (migration 062), never by the school in the address. Leave the **Callback URL** as it is; Chronix Edu
  sets the return address on every payment itself.
- **Disputes Email** (Settings → Contact): an inbox someone reads every working day. Chargebacks have a
  16-hour deadline (below).
- **The Paystack Merchant app**, signed in, for dispute reminders.
- **Education pricing**: apply at http://bit.ly/paystackforschools (0.7% capped at ₦1,500 for local
  cards; ₦300 flat for other methods, instead of 1.5% + ₦100).

## Refunds: the school pays them back itself

A school refunds a parent **from its own money**, by cash or bank transfer, and the bursar records it:
Invoices → the student → Payments → Refund, with the amount, how it was paid back, a reason, and the
transfer reference if there is one (often there is none). This works for online payments too.

Why not refund through Paystack's dashboard:
- **A Paystack refund is taken from the main account's pending payout or balance, which is Chronix's.** The
  school's share of an online payment has already been paid out to the school's bank account, so Paystack
  cannot take it back from there. Chronix would pay the parent and then have to recover the money.
- A personal or starter Paystack account may have no balance at all, and Paystack refuses a refund when
  there is not enough waiting to be paid out.
- **Paystack's charge is never refunded**, whoever makes the refund.

What the school loses on a refund: only Paystack's charge on the original payment, when the school paid it
(today's setting). That is 1.5% of the payment, plus ₦100 on payments of ₦2,500 or more, never more than
₦2,000: about ₦1.50 on ₦100, ₦850 on ₦50,000. It is Paystack's, not an error in Chronix Edu's arithmetic.
When the parent paid it as a convenience fee instead, the school refunds the school fee only and loses
nothing; the parent was told before paying that the fee is not refundable.

**Instead of a refund, for an overpayment:** the school can keep it as a credit towards next term. Nothing
is lost to charges. (Carrying a credit forward automatically is not built yet.)

## Chargebacks: a parent's bank takes a payment back

A chargeback is not a refund. The school does not choose it: the parent asks their own bank to reverse the
payment (often "I did not make this payment", sometimes a stolen card), and the bank takes it back through
Paystack.

- **Answer within 16 hours** (business days; a CBN rule), in the Paystack dashboard (Disputes), or Paystack
  accepts it automatically and takes the full amount from **the main account's payouts: Chronix's**.
  Paystack's terms make the account holder liable for every chargeback.
- **Decline it with evidence** when the payment was owed: the invoice, the receipt (Chronix Edu's PDF), the
  enrolment record, and any messages with the parent. Upload everything the first time.
- **Accept it** when the parent is right. Then record it in Chronix Edu as a refund (reason: Other, with a
  note saying it was a chargeback), so the invoice shows the money is owed again.
- **Recover a lost chargeback from the school.** Its money went to the school, and Paystack took it from
  Chronix. The school agreement should say the school repays a chargeback it loses. (The legal pages are
  fixed text: a decision for Moses and a lawyer.)

Automatic dispute alerts and automatic recording of Paystack refunds and chargebacks are built and parked
for the second school (branch `parked/paystack-account-webhook`). Until then, the Disputes Email is the
alert.

## Payments Chronix Edu does not credit by itself

An online payment is credited only through the record made when the parent started it (migration 062). A
payment with no such record, or verified at a different amount, raises the `fee_payment_not_credited`
alert (Sentry, by email). Check it in the Paystack dashboard; if it is a real school fee, the bursar
records it with its Paystack reference: Invoices → Record Payment → Paystack.
