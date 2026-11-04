/** Thin Office fallback; native image/PDF/audio interpretation remains with OpenClaw. */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const script = fileURLToPath(new URL("./read-office.py", import.meta.url));

export async function readMaterial(file, options = {}) {
  const kind = path.extname(file.fileName).slice(1).toLowerCase();
  if (!["docx", "xlsx", "csv"].includes(kind)) {
    return { status: "UNKNOWN", coverage: "UNKNOWN", source: "OPENCLAW_NATIVE",
      reason: "Use actual host text, transcript or visual input; attachment metadata is not reading evidence." };
  }
  try {
    const { stdout } = await run(options.python ?? "python3", [script, file.filePath, kind], {
      timeout: 15000, maxBuffer: 512 * 1024, windowsHide: true, encoding: "utf8",
    });
    const result = JSON.parse(stdout);
    if (!["READ", "PARTIAL", "FAILED"].includes(result?.status)) throw new Error("Invalid reader result");
    return { ...result, source: "OFFICE_BASIC_READER" };
  } catch (error) {
    return { status: "FAILED", source: "OFFICE_BASIC_READER", coverage: "UNKNOWN",
      reason: error?.code === "ENOENT" ? "OFFICE_READER_UNAVAILABLE" : "OFFICE_READER_FAILED" };
  }
}
