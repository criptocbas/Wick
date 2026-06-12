/** UI review driver: screenshots the app, optionally walks the onboarding + places a bet.
 *    npx tsx shot.ts onboard      → wait for onboarding, screenshot
 *    npx tsx shot.ts trade        → click "Light the wick", wait, screenshot trading view
 *    npx tsx shot.ts bet          → also place a LONG, capture mid-burn + post-resolve
 */
import puppeteer from "puppeteer-core";

const mode = process.argv[2] ?? "onboard";
const URL = process.env.APP_URL ?? "http://localhost:5173";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--window-size=1440,900"],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));

  await page.goto(URL, { waitUntil: "networkidle2" });
  await sleep(2500);
  await page.screenshot({ path: "/tmp/wick-1-onboard.png" });
  console.log("shot: /tmp/wick-1-onboard.png");

  if (mode === "onboard") return browser.close();

  // walk onboarding
  const btn = await page.$(".btn-flame");
  if (btn) {
    await btn.click();
    console.log("clicked Light the wick…");
    await page.waitForSelector(".shell", { timeout: 90_000 });
    await sleep(Number(process.env.OBSERVE_MS ?? 3500)); // let prices stream in
  }
  await page.screenshot({ path: "/tmp/wick-2-trading.png" });
  console.log("shot: /tmp/wick-2-trading.png");

  if (mode !== "bet") return browser.close();

  // place a long (duration/stake chips configurable for hedger tests)
  const durChip = process.env.DUR_CHIP ?? "10s";
  const stakeChip = process.env.STAKE_CHIP ?? "10";
  await page.evaluate(
    (dur, stake) => {
      const chips = [...document.querySelectorAll(".chip")];
      (chips.find((c) => c.textContent === dur) as HTMLElement)?.click();
      (chips.find((c) => c.textContent === stake) as HTMLElement)?.click();
    },
    durChip,
    stakeChip
  );
  await page.click(".dir-btn.long");
  console.log("placed LONG");
  await sleep(2600);
  await page.screenshot({ path: "/tmp/wick-3-burning.png" });
  console.log("shot: /tmp/wick-3-burning.png");
  await sleep(9000);
  await page.screenshot({ path: "/tmp/wick-4-after.png" });
  console.log("shot: /tmp/wick-4-after.png");

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
