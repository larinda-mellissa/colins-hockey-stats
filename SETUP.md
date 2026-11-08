# Hockey Stats — setup guide

Three parts, about 20 minutes total. Do parts 1 and 2 on a computer.

| Folder / file | What it is |
|---|---|
| `site/` | The app. This whole folder goes on Netlify. |
| `apps-script/Code.gs` | The Google Sheet sync code. |

---

## Part 1 — Put the app on Netlify (you)

1. Log in to Netlify → **Add new site → Deploy manually**.
2. Drag the **`site`** folder onto the page.
3. **Site configuration → Change site name** to something like `colin-hockey-stats`.
4. Write down the address, e.g. `https://colin-hockey-stats.netlify.app/`.

**Updating later:** drag the `site` folder onto the site's **Deploys** page. Whenever you change an app file, also change the version in the first line of `site/sw.js` (e.g. `v1.0.0` → `v1.0.1`) so phones pick up the update. They get it the second time the app is opened.

---

## Part 2 — Create the Google Sheet (signed in to *his* Google account)

1. Go to **sheets.new** and name the sheet **Hockey Stats**.
2. **Extensions → Apps Script.** Delete the sample code and paste in all of `Code.gs`.
3. At the top, set `APP_URL` to the Netlify address from Part 1. Click **Save** (💾).
4. In the function drop-down choose **`setup`** and click **Run**.
   - Google asks for permission: **Review permissions** → pick his account → **Advanced → Go to Hockey Stats (unsafe) → Allow**. "Unsafe" just means Google hasn't reviewed his own private script.
   - The sheet now has **Games**, **Players** and **Seasons** tabs.
5. **Deploy → New deployment** → click the gear ⚙ → **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone** *(needed so the phones can reach it; the secret access key is what keeps strangers out)*
   - Click **Deploy** and **copy the Web app URL** (ends in `/exec`).
6. Paste that URL into `WEB_APP_URL` at the top of the code. **Save.**
7. Choose **`makeSetupLink`** → **Run**. Open **View → Logs** (or the Execution log) and copy the long link that starts with his Netlify address. Email or text it to him.

> **Changing the Apps Script later:** use **Deploy → Manage deployments → ✏️ edit → Version: New version → Deploy**. That keeps the same URL. ("New deployment" would make a new URL and the phones would lose their connection.)

---

## Part 3 — Set up the phones

### Grandpa's iPhone

1. Open the Netlify address in **Safari**.
2. Tap **Share ⬆ → Add to Home Screen → Add**.
3. Open **Hockey Stats from the home screen icon** (not Safari — iPhone keeps their data separately).
4. Fill in the welcome screen: his name (Grandpa), **Colin**, season, team, level **U13 A2**, jersey number → **Start**.
5. Go to **Settings → Google Sheet sync**, paste the setup link from Part 2 into **"…or paste a setup link"** → **Connect with link** → **Connect**.
6. The dot next to the sync line turns green. Done.

### Kyla's iPhone (QR code)

1. On Grandpa's phone: **Settings → Share access** → name **Kyla** → **Make QR code**.
2. Kyla opens her **Camera**, points it at the code and taps the link. Safari opens → **Connect**.
3. In Safari: **Share ⬆ → Add to Home Screen**, then open the app from the icon.
4. If the home-screen app opens on the welcome screen instead of Colin's page, Grandpa taps **Text the link instead** (same Share access screen). Kyla pastes it into **"Got a setup link?" → Connect with link**.

Her games show **"Recorded by: Kyla"**. If both of them happen to track the same game, the app counts only one and marks the other "Duplicate" so it can be deleted.

**If her phone is lost:** on Grandpa's phone, **Settings → Reset access**. Every other phone stops syncing. Make a new QR code for anyone who should keep access.

---

## Using it at the rink

- **Before the game:** Home → **Start new game** → opponent, home/away, arena, type → **Go to game**.
- **Start Period 1** at the opening face-off.
- **Big button:** tap when Colin steps on the ice (green, **ON ICE**) and again when he reaches the bench (grey, **ON BENCH**).
- **Whistle bar:** tap at every whistle and again when the puck drops. Ice time doesn't count while it's stopped. This is optional; skipping it means stoppages count as ice time.
- **Goal / Assist** also add a **GF**, so don't tap GF as well.
- **GF / GA** record whether Colin was on the ice, which builds his plus/minus.
- **Penalty** asks for minutes and ends his shift automatically.
- **Undo** reverses the last tap (it shows what it will undo).
- **End P1/P2/P3** ends the period and his current shift. After P3: **Start overtime**, **Shootout**, or **Finish game**.
- Leaving the app or the phone locking doesn't lose anything. The timers pick up where they were.
- After the game: **Share summary** texts a summary to the family. **Edit** fixes anything missed. **Games → Add a past game by hand** covers games that weren't tracked live.
- **New season (next fall):** Settings → **+ Add season** (e.g. 2027–28, U13 A1). Older seasons stay in **Stats → Career**.
- **Cody:** Settings → **+ Add player**. Name chips appear at the top of Home to switch between them.

---

## Good to know

- **Works with no signal.** Every tap saves on the phone instantly and syncs to the Sheet when there's a connection. The sync line on Home shows the status; tap it to sync now.
- **Screen stays awake** during a game on current iOS. If it ever dims, check that iOS is up to date, or set **Settings → Display & Brightness → Auto-Lock** longer for games.
- **The Google Sheet** has one readable row per game (TOI, G, A, +/-, hits…). The hidden last column holds the full game record the app reads back, so don't edit that column.
- **Extra safety:** Settings → **Save backup file** occasionally.
- **The QR code** needs an internet connection the moment it's made. Use **Text the link instead** if it won't load.
- **Plus/minus** here counts every goal for and against while Colin's on the ice, including power-play goals.
