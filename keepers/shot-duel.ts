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
    await sleep(3500);
  }
  // open the latency duel via the pill
  await page.evaluate(() => (document.querySelector(".latency-pill") as HTMLElement)?.click());
  // mid-race shot
  await sleep(500);
  await page.screenshot({ path: "/tmp/wick-duel-racing.png" });
  // wait for both lanes to settle
  await sleep(9000);
  await page.screenshot({ path: "/tmp/wick-duel-done.png" });
  const result = await page.evaluate(() => {
    const times = [...document.querySelectorAll(".lane-time")].map((t) => t.textContent);
    const verdict = document.querySelector(".duel-verdict")?.textContent ?? null;
    return { times, verdict };
  });
  console.log("lane times:", result.times, "| verdict:", result.verdict?.slice(0, 80));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
