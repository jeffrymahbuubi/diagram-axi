// Checks that the persistent-profile launcher stops Chrome from failing a Windows logon on every start.
// Run it by hand on Windows after `npm run build`; it LAUNCHES a real browser N times.
//
//   node scripts/verify-chrome-logons.mjs [launches]          (default 12)
//
// It uses one profile slot in a fresh temp pool, so launch 1 is a cold profile (Chrome may fail one logon
// there) and launches 2..N reuse the cached answer (no further failed logons expected). After each launch
// it prints the account status from `net user` and stops at once if the account shows "Locked".

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

if (process.platform !== "win32") {
  console.log("verify-chrome-logons: Windows only, nothing to do here");
  process.exit(0);
}

const launches = Number.parseInt(process.argv[2] ?? "12", 10);
const HOLD_MS = 4_000;
const user = process.env.USERNAME || userInfo().username;

const pool = mkdtempSync(join(tmpdir(), "diagram-axi-verify-profiles-"));
process.env.DIAGRAM_AXI_CHROME_PROFILE_DIR = pool;
process.env.DIAGRAM_AXI_CHROME_PROFILE_SLOTS = "1";
delete process.env.DIAGRAM_AXI_CHROME_PROFILE;

const { findBrowser } = await import("../dist/render/browser.js");
const { launchContext } = await import("../dist/render/launch.js");

function status() {
  try {
    return execSync(`net user "${user}" | findstr /C:"Account active"`, { encoding: "utf8", shell: "cmd.exe" }).trim();
  } catch (error) {
    return `(could not read account status: ${error.message.split("\n")[0]})`;
  }
}

/** Failed-logon events (4625) since `since`; needs an elevated shell, otherwise "n/a". */
function failedLogons(since) {
  try {
    const ps = `(Get-WinEvent -FilterHashtable @{LogName='Security';Id=4625;StartTime=[datetime]'${since.toISOString()}'} -ErrorAction Stop | Measure-Object).Count`;
    return execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "n/a";
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const isLocked = (line) => /locked/i.test(line);

const startedAt = new Date();
console.log(`user: ${user}`);
console.log(`profile pool: ${pool} (1 slot)`);
console.log(`before: ${status()}`);
if (isLocked(status())) {
  console.log("account is already locked, not launching anything");
  process.exit(2);
}

const info = await findBrowser();
console.log(`browser: ${info.name} at ${info.path}`);
console.log(`launches: ${launches}, each held ${HOLD_MS / 1000} s`);

let code = 0;
try {
  for (let n = 1; n <= launches; n++) {
    const t0 = Date.now();
    const browser = await launchContext(info, { timeout: 30_000, context: { serviceWorkers: "block" } });
    try {
      if (browser.profile === "temp") {
        console.log(`launch ${n}: used a TEMP profile, not the slot; the test is invalid, stopping`);
        code = 3;
        break;
      }
      const page = await browser.context.newPage();
      await page.goto("data:text/html,<title>verify</title><p>verify");
      await sleep(HOLD_MS); // Chrome runs the blank-password check a little after startup
    } finally {
      await browser.close();
    }
    const line = status();
    console.log(`launch ${n}/${launches} (${((Date.now() - t0) / 1000).toFixed(1)} s): ${line}`);
    if (isLocked(line)) {
      console.log("ACCOUNT LOCKED: stopping now");
      code = 1;
      break;
    }
  }
} finally {
  console.log(`after: ${status()}`);
  console.log(`failed logons (event 4625) since start: ${failedLogons(startedAt)} (n/a = Security log needs an elevated shell)`);
  rmSync(pool, { recursive: true, force: true });
}
process.exit(code);
