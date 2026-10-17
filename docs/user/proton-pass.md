# Fill browser logins with Proton Pass

In the desktop app's integrated browser, right-click a login field and choose **Proton Pass →
Link a login to this site…**. Choose the vault and login yourself. T3 Code links that item to the
page's exact origin and the selected browser profile, then fills the username and password.
Use **Fill** in the same menu for later visits. The form is never submitted automatically.

The integration requires Proton Pass CLI 2.4.2 installed and already signed in on that desktop.
Its session is separate from the Proton Pass desktop app. If it is locked or signed out, unlock
or sign in to the CLI yourself, then try again.

Sharing and agent access pause before the selected credentials are read and remain paused after
filling. When finished, right-click in the tab and choose **Clear login fields and resume
sharing**. Removing a linked login only removes its saved association; it does not clear fields
or resume sharing. Cancelling selection also leaves sharing paused until you explicitly resume.

Autofill supports a visible main-frame form with one username/email field and one password field
on HTTPS sites or HTTP localhost. Incognito profiles, frames, agent-owned tabs, remote viewers,
recordings and open browser developer tools cannot use this native fill. If the page replaces
fields during filling or clearing, sharing stays paused; close the tab if it cannot be cleared.
Web and mobile clients do not read the desktop's vault.
