**English** | [简体中文](README.zh-CN.md)

# NodeLoc Reading-Time Background Helper

Accumulate NodeLoc reading time at a natural reading pace up to 600 minutes by default. The target can be changed in the script configuration.

> This project is intended for personal account testing and automation experiments. Use it only with an account you control and follow the target site's rules.

## Recommended: Tampermonkey userscript

File: `nodeloc-readtime.user.js`

### Option A: Quick start without Tampermonkey

1. Open any NodeLoc page and make sure you are signed in.
2. Press `F12`, open the Console tab.
3. Paste the full contents of `nodeloc-readtime.user.js` and press Enter.
4. You can close the Console. The script keeps running in the current tab and shows a progress panel in the bottom-right corner.

If you prefer bookmarks, save the line in `nodeloc-readtime.bookmarklet.txt` as a bookmark and click it while on a NodeLoc page.

This method stops when the page is refreshed. Use Option B for long-running sessions.

### Option B: Tampermonkey (auto-starts after refresh)

1. Open the Tampermonkey dashboard in Edge.
2. Create a new script, paste the full contents of `nodeloc-readtime.user.js`, and save it.
3. Open or refresh `https://www.nodeloc.com/latest`. The script starts automatically and shows its progress in the bottom-right corner.
4. You can switch to other tabs or minimize the window. **Keep the NodeLoc tab open** and prevent the computer from sleeping.

The userscript uses your existing browser session, so no Cookie export is needed. It only does three things:

- waits a random 58–76 seconds between requests;
- picks a real topic and submits one normal `/topics/timings` event;
- switches topics every 3–5 minutes and backs off according to `Retry-After` on HTTP 429.

## Background CLI (no browser tab required)

File: `nodeloc-readtime.mjs`

Use this when you want the process to run independently of a browser tab. In the NodeLoc page, open Cookie-Editor, choose **Export → JSON**, save the export as `cookies.json` in this directory, then run:

```powershell
cd nodeloc-readtime
node .\nodeloc-readtime.mjs --cookie-file .\cookies.json
```

Or double-click:

```text
start-background.cmd
```

It starts a hidden Node process. **You can close the NodeLoc page and use other applications**; it does not occupy your mouse or keyboard.

Stop the background process:

```powershell
.\stop-background.ps1
```

Logs are written to `nodeloc-readtime.log`, and progress is written to `nodeloc-readtime-state.json`.

## Anti-Abuse and Stability Design

NodeLoc's anti-abuse checks generally combine request frequency, timing authenticity, behavioral patterns, account/device correlation, and abnormal interaction signals. This project avoids concurrent hard-flooding and focuses on reducing anomaly signals:

| Signal | What the script does |
|---|---|
| Request frequency | Waits a random 58–76 seconds between requests; one serial instance only, with no one-second loops or concurrency |
| Timing distribution | Randomizes `topic_time` between 45–59.5 seconds instead of using identical values |
| Data validity | Reads real topics from `/latest.json` and generates valid post numbers from `posts_count` so invalid posts are not dropped |
| Behavioral pattern | Reads 3–5 times per topic before switching and requests the topic page to imitate normal browsing |
| Account correlation | One account and one tab; a leader lock prevents multiple tabs from submitting at the same time |
| Interaction anomalies | Reading timings only; no automatic likes, replies, follows, or posts |
| Server rate limits | Handles HTTP 429 with `Retry-After` plus randomized backoff instead of repeatedly hitting the limit |
| Target control | Stops automatically after the 600-minute target instead of running indefinitely |

Additional notes:

- Reading time is accumulated by the server from the real elapsed time between timing requests. One account can normally accumulate about one minute per minute; forged `topic_time` values do not create a valid jump.
- These measures can only reduce anomaly signals, not guarantee that no anti-abuse rule is triggered. Account age, usual IP, device environment, and multi-account behavior also affect the result.
- The safest operating pattern is one account, one browser, one tab, a familiar network environment, and stopping when the target is reached.

## Notes

- NodeLoc reading time is based on real server-side elapsed time. One account can normally accumulate about one minute per minute; the script does not hard-flood with concurrent requests.
- The default target is 600 minutes. Current progress is read automatically and the script stops when the target is reached.
- Run only one instance or one tab; multiple instances are likely to hit rate limits.
- If the page says you are not signed in, sign in normally in the browser and refresh the page.
