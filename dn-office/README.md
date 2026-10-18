# DN Office

The office app for **Debug Networks**, a CCTV and network services business in Hazaribagh, Jharkhand: clients, jobs, quotes with PDF, payments, follow-ups, CCTV cards and the ₹1 lakh goal.

- `web/` is the app itself, a single web page that also works as an installable web app.
- `android/` wraps it as an Android app (APK). GitHub builds it on every push to the `dn-office` branch and puts the results on the `dn-office-build` branch.

Records are saved only on the phone. Nothing is sent to this repository or to any server. Use **Settings → Back up now** every week.
