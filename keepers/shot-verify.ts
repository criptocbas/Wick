/** Targeted UI verification: capture the verdict "settled in Xms" subline and
 *  the House Desk P&L chart. Onboards, places a 5s bet, screenshots at settle,
 *  then opens the Desk. */
import puppeteer from "puppeteer-core";

const URL = process.env.APP_URL ?? "http://localhost:5174";
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
    if (m.type() === "error") console.log("[err]", m.text().slice(0, 160));
  });

  await page.goto(URL, { waitUntil: "networkidle2" });
  await sleep(2000);
  await page.$(".btn-flame").then((b) => b?.click());
  console.log("onboarding…");
  await page.waitForSelector(".shell", { timeout: 90_000 });
  await sleep(3500);

  // place a 5s LONG, screenshot right when it settles (verdict window)
  await page.evaluate(() => {
    const chips = [...document.querySelectorAll(".chip")];
    (chips.find((c) => c.textContent === "5s") as HTMLElement)?.click();
  });
  await page.click(".dir-btn.long");
  console.log("placed 5s LONG, waiting for the verdict to appear…");
  // poll for the verdict subline and grab it the instant it shows
  try {
    await page.waitForSelector(".verdict-settle", { visible: true, timeout: 30_000 });
    await page.screenshot({ path: "/tmp/wick-verdict.png" });
    const settleText = await page.$eval(".verdict-settle", (el) => el.textContent);
    console.log("verdict subline:", settleText);
  } catch {
    console.log("verdict subline: (did not appear in time)");
  }

  // open the Desk to verify the P&L chart
  await sleep(3000);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.trim().startsWith("Desk")
    ) as HTMLElement;
    btn?.click();
  });
  await sleep(1200);
  await page.screenshot({ path: "/tmp/wick-desk.png" });
  const legend = await page
    .$$eval(".pnl-k", (els) => els.map((e) => e.textContent?.trim()))
    .catch(() => []);
  console.log("desk P&L legend:", JSON.stringify(legend));

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
