import { assertFixtureTruth, buildFixturePng, getGroundTruth } from "../lib/fixtures.js";
import fs from "node:fs";

try {
  const report = await assertFixtureTruth();
  console.log("FIXTURE OK — all", report.checks.length, "checks passed");
  for (const c of report.checks) console.log("  ✓", JSON.stringify(c));
  console.log("\nMeasured contrast per line:");
  for (const [id, m] of Object.entries(report.measured)) {
    console.log(`  ${id}: ratio=${m.contrast_ratio} measurable=${m.measurable} fg=${m.foreground?.hex ?? "-"} bg=${m.background.hex} wcag_aa=${m.wcag_aa}`);
  }
  const png = await buildFixturePng();
  fs.mkdirSync("tmp", { recursive: true });
  fs.writeFileSync("tmp/fixture.png", png);
  console.log("\nwrote tmp/fixture.png", png.length, "bytes");
  console.log("ONLY_BOX_WITH_PLUS =", getGroundTruth().only_box_with_plus);
} catch (e) {
  console.error("FIXTURE FAILED:\n", e.message);
  process.exitCode = 1;
}
