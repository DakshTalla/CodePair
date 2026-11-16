// End-to-end demo: drives two real browsers (an interviewer and a candidate)
// through a whole interview, checks that both editors show the same text, and
// saves the README screenshots to docs/screenshots/.
//
//   .\start.ps1                    (in one terminal)
//   node scripts/screenshots.mjs   (in another)
//
// Uses playwright-core with the Microsoft Edge already installed on Windows,
// so no browser download is needed.

import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const WEB = process.env.WEB_URL ?? 'http://localhost:3100';
const OUT = 'docs/screenshots';
mkdirSync(OUT, { recursive: true });

const SOLUTION = `def two_sum(nums, target):
    seen = {}
    for i, n in enumerate(nums):
        if target - n in seen:
            return [seen[target - n], i]
        seen[n] = i

print(two_sum([2, 7, 11, 15], 9))`;

const browser = await chromium.launch({ channel: 'msedge' });
const pages = [];

async function openAs(name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript((n) => localStorage.setItem('codepair:name', n), name);
  const page = await context.newPage();
  pages.push(page);
  return page;
}

// Types code the way a person would, one key at a time. The editor indents
// automatically after Enter, so we only correct the difference.
async function typeCode(page, code) {
  let autoLevel = 0;
  for (const [i, line] of code.split('\n').entries()) {
    if (i > 0) await page.keyboard.press('Enter');
    const text = line.trimStart();
    if (text === '') continue;
    const level = (line.length - text.length) / 4;
    for (let k = level; k < autoLevel; k++) await page.keyboard.press('Backspace');
    await page.keyboard.type(text, { delay: 25 });
    autoLevel = level + (text.endsWith(':') ? 1 : 0);
  }
}

const editorText = (page) => page.evaluate(() => window.monaco.editor.getModels()[0].getValue());

try {
  // ---- landing page ----
  const interviewer = await openAs('Priya');
  await interviewer.goto(WEB);
  await interviewer.waitForSelector('text=Start an interview');
  await interviewer.screenshot({ path: `${OUT}/landing.png` });

  // ---- interviewer creates the room and picks a question ----
  await interviewer.click('text=Start an interview');
  await interviewer.waitForSelector('.monaco-editor');
  const roomUrl = interviewer.url();
  if (roomUrl.includes('key=')) throw new Error('interviewer key was left in the address bar');
  await interviewer.click('nav >> text=interviewer');
  await interviewer.click('text=Two Sum');

  // ---- candidate joins with the plain link ----
  const candidate = await openAs('Daksh');
  await candidate.goto(roomUrl);
  await candidate.waitForSelector('.monaco-editor');
  await candidate.waitForSelector('h2:has-text("Two Sum")');
  if (await candidate.locator('nav >> text=interviewer').count()) throw new Error('candidate can see the interviewer tab');

  await candidate.fill('input[placeholder^="Message"]', 'Hi! I will start with a hash map approach.');
  await candidate.keyboard.press('Enter');
  await candidate.click('.monaco-editor');
  await typeCode(candidate, SOLUTION);

  // ---- interviewer types at the same time, at the top of the file ----
  await interviewer.click('.monaco-editor');
  await interviewer.keyboard.press('Control+Home');
  await interviewer.keyboard.type('# What is the time complexity?', { delay: 25 });
  await interviewer.keyboard.press('Enter');
  await interviewer.fill('input[placeholder^="Message"]', 'Looks good. Can you run it?');
  await interviewer.keyboard.press('Enter');

  // ---- run the code; both sides must see the output ----
  await candidate.click('button:has-text("Run")');
  await candidate.waitForSelector('text=Finished', { timeout: 30_000 });
  await interviewer.waitForSelector('pre:has-text("[0, 1]")');

  const [a, b] = [await editorText(interviewer), await editorText(candidate)];
  if (a !== b) throw new Error(`editors diverged:\n--- interviewer\n${a}\n--- candidate\n${b}`);
  if (a !== `# What is the time complexity?\n${SOLUTION}`) throw new Error(`unexpected text:\n${a}`);
  console.log('OK: both editors show identical text, output reached both sides');

  // ---- interviewer's private notes ----
  await interviewer.fill('textarea', 'Went straight to the one-pass hash map. Explained O(n) time / O(n) space clearly.');
  await interviewer.click('[aria-label="4 of 5"]');
  await interviewer.waitForSelector('text=Saved');
  await candidate.click('.monaco-editor'); // keep the candidate's cursor visible
  await interviewer.waitForTimeout(500);
  await interviewer.screenshot({ path: `${OUT}/room-interviewer.png` });
  await candidate.screenshot({ path: `${OUT}/room-candidate.png` });

  // ---- replay ----
  const replay = await openAs('Priya');
  await replay.goto(roomUrl.replace('/room/', '/replay/'));
  await replay.waitForSelector('input.timeline');
  const total = Number(await replay.getAttribute('input.timeline', 'max'));
  await replay.fill('input.timeline', String(Math.round(total * 0.6)));
  await replay.waitForTimeout(800);
  await replay.screenshot({ path: `${OUT}/replay.png` });
  await replay.fill('input.timeline', String(total));
  await replay.waitForTimeout(500);
  const replayed = await editorText(replay);
  if (replayed !== a) throw new Error('replay does not end at the final text');
  console.log(`OK: replay of ${total} recorded edits ends at the same text`);
  console.log(`Screenshots saved to ${OUT}/`);
} catch (err) {
  // Save what each browser was showing, to make a failure easy to diagnose.
  for (const [i, page] of pages.entries()) {
    await page.screenshot({ path: `${OUT}/failure-${i}.png` }).catch(() => {});
  }
  console.error(err);
  process.exitCode = 1;
} finally {
  await browser.close();
}
