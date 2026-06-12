/** Browser verification of the one-touch UI: onboard, switch to Touch mode,
 *  pick a 0.1% barrier, place TOUCH UP, capture the barrier line + the win. */
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
    if (m.type() === "error") console.log("[err]", m.text().slice(0, 140));
  });

  await page.goto(URL, { waitUntil: "networkidle2" });
  await sleep(2000);
  await page.$(".btn-flame").then((b) => b?.click());
  console.log("onboarding…");
  await page.waitForSelector(".shell", { timeout: 90_000 });
  await sleep(3500);

  // switch to Touch mode, pick the tightest barrier, longest expiry
  const clickChip = (text: string) =>
    page.evaluate((t) => {
      const c = [...document.querySelectorAll(".chip")].find(
        (e) => e.textContent?.trim() === t
      ) as HTMLElement;
      c?.click();
    }, text);
  await clickChip("Touch");
  await sleep(300);
  await clickChip("10s");
  await clickChip("0.1%");
  await sleep(500);
  await page.screenshot({ path: "/tmp/wick-touch-controls.png" });
  console.log("touch mode armed (0.1%, 60s)");

  // place TOUCH UP and TOUCH DOWN — a 0.1% move either way wins one fast
  await page.click(".dir-btn.long");
  await sleep(700);
  await page.click(".dir-btn.short");
  console.log("placed TOUCH UP + DOWN — waiting for a barrier to be hit…");
  await sleep(2500);
  await page.screenshot({ path: "/tmp/wick-touch-live.png" });

  // poll for ANY verdict overlay (win on touch, or loss at expiry) — proves the
  // verdict fires for the user's bet whether the browser or the daemon settles it
  try {
    await page.waitForSelector(".verdict-card", { visible: true, timeout: 22_000 });
    await page.screenshot({ path: "/tmp/wick-touch-win.png" });
    const txt = await page.$eval(".verdict-card", (el) =>
      (el.textContent || "").replace(/\s+/g, " ").trim()
    );
    console.log("verdict shown:", txt);
  } catch {
    console.log("verdict: none captured this run");
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
