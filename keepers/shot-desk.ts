import puppeteer from "puppeteer-core";
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
  page.on("console", (m) => m.type() === "error" && console.log("[err]", m.text().slice(0, 200)));
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
  await page.goto(URL, { waitUntil: "networkidle2" });
  await sleep(2500);
  const btn = await page.$(".btn-flame");
  if (btn) {
    await btn.click();
    await page.waitForSelector(".shell", { timeout: 45_000 });
    await sleep(4000);
  }
  // open the house desk drawer
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".desk-btn")][0] as HTMLElement;
    b?.click();
  });
  await sleep(1200);
  await page.screenshot({ path: "/tmp/wick-desk.png" });
  console.log("shot: /tmp/wick-desk.png");

  // also capture a closed-market view if any market is closed
  const closed = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".market-row.closed")];
    if (rows[0]) {
      (rows[0] as HTMLElement).click();
      return (rows[0].querySelector(".sym") as HTMLElement)?.textContent;
    }
    return null;
  });
  if (closed) {
    await sleep(800);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".desk-btn")][0] as HTMLElement;
      b?.click(); // close desk to see the stage
    });
    await sleep(600);
    await page.screenshot({ path: "/tmp/wick-closed.png" });
    console.log(`shot: /tmp/wick-closed.png (market ${closed})`);
  } else {
    console.log("no closed markets right now (all trading)");
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
