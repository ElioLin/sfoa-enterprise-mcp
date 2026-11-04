import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readMaterial } from "../src/material-reader.js";

const python = process.env.SFOA_MATERIAL_PYTHON ?? (process.platform === "win32" ? "python3.12" : "python3");
const run = promisify(execFile);

async function fixture(kind, body) {
  const root = await mkdtemp(path.join(tmpdir(), "sfoa-office-"));
  const filePath = path.join(root, "material." + kind);
  if (kind === "csv") await writeFile(filePath, body);
  else {
    // Produce actual standard ZIP bytes independently of the reader.
    await run(python, ["-c", "import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED); [(z.writestr(k,v)) for k,v in json.loads(sys.argv[2]).items()]; z.close()", filePath, JSON.stringify(body)], { windowsHide: true });
  }
  return { filePath, fileName: path.basename(filePath), close: () => rm(root, { recursive: true, force: true }) };
}

test("real DOCX basic paragraphs/tables preserve source text and known coverage", async () => {
  const file = await fixture("docx", { "word/document.xml": '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>客户尚未承诺采购。</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>数量</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>0</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>' });
  try {
    const value = await readMaterial(file, { python });
    assert.equal(value.status, "READ");
    assert.match(value.text, /客户尚未承诺采购。\n数量\t0/u);
    assert.equal(value.coverage.tableRows, 1);
    assert.equal(value.coverage.pages, "UNKNOWN");
    assert.match(value.contentSha256, /^[0-9a-f]{64}$/u);
  } finally { await file.close(); }
});

test("real XLSX reads shared/inline/numeric/cached-formula cells and flags missing caches", async () => {
  const file = await fixture("xlsx", {
    "xl/workbook.xml": '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="参会人" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/sharedStrings.xml": '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>陈经理</t></si></sst>',
    "xl/worksheets/sheet1.xml": '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>技术负责人</t></is></c><c r="C1"><v>0</v></c><c r="D1"><f>2+3</f><v>5</v></c><c r="E1"><f>2+4</f></c></row></sheetData></worksheet>',
  });
  try {
    const value = await readMaterial(file, { python });
    assert.equal(value.status, "PARTIAL");
    assert.match(value.text, /A1=陈经理\tB1=技术负责人\tC1=0\tD1=5/u);
    assert.match(value.text, /E1=\[formula has no cached value\]/u);
    assert.deepEqual(value.reasons, ["FORMULA_VALUE_UNAVAILABLE"]);
    assert.equal(value.coverage.sheets[0].rowsRead, 1);
  } finally { await file.close(); }
});

test("CSV quoted multiline cells, UTF-8 BOM and exact original hash are read", async () => {
  const bytes = Buffer.from('\ufeff客户,诉求\r\n测试公司,"先测试,\n尚未通过"\r\n');
  const file = await fixture("csv", bytes);
  try {
    const value = await readMaterial(file, { python });
    assert.equal(value.status, "READ");
    assert.equal(value.coverage.rowsRead, 2);
    assert.equal(value.contentSha256, createHash("sha256").update(bytes).digest("hex"));
    assert.match(value.text, /先测试,\n尚未通过/u);
  } finally { await file.close(); }
});

test("long tables and bodies are explicitly partial, not reported fully read", async () => {
  const file = await fixture("csv", Array.from({ length: 1100 }, (_, i) => `${i},${"事实".repeat(30)}`).join("\n"));
  try {
    const value = await readMaterial(file, { python });
    assert.equal(value.status, "PARTIAL");
    assert.equal(value.coverage.rowsRead, 1000);
    assert.equal(value.coverage.rowsTotal, 1100);
    assert.equal(value.text.length, 24000);
    assert.deepEqual(value.reasons, ["OFFICE_ROW_LIMIT", "OFFICE_TEXT_LIMIT"]);
  } finally { await file.close(); }
});

test("corrupt Office, unsupported encoding and missing Python give separate reading failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sfoa-office-bad-"));
  try {
    const filePath = path.join(root, "broken.docx");
    await writeFile(filePath, "This is not a ZIP");
    assert.equal((await readMaterial({ filePath, fileName: "broken.docx" }, { python })).reason, "OFFICE_INVALID_OR_UNREADABLE");
    assert.equal((await readMaterial({ filePath, fileName: "broken.docx" }, { python: path.join(root, "missing-python") })).reason, "OFFICE_READER_UNAVAILABLE");
    await writeFile(filePath, Buffer.from([0xff, 0xfe, 0x20]));
    assert.equal((await readMaterial({ filePath, fileName: "other.csv" }, { python })).reason, "OFFICE_TEXT_ENCODING_UNSUPPORTED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native image, PDF and audio remain native and never gain invented read coverage", async () => {
  for (const fileName of ["image.png", "scan.pdf", "voice.amr", "meeting.m4a"]) {
    const result = await readMaterial({ fileName, filePath: "/not-read-by-this-adapter" }, { python });
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.source, "OPENCLAW_NATIVE");
    assert.equal(result.text, undefined);
  }
});
