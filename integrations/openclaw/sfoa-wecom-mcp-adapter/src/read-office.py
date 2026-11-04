"""Bounded, read-only Office basics for the host adapter (Python standard library).

No Office execution, formula evaluation, network, extraction to disk or external
relationships. Coverage describes paragraphs/table rows/cached spreadsheet cells,
not page layout, drawings, comments, macros or a successful CRM operation.
"""
import csv
import datetime
import hashlib
import io
import json
import posixpath
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

MAX_FILE = 16 * 1024 * 1024
MAX_EXPANDED = 32 * 1024 * 1024
MAX_MEMBER = 8 * 1024 * 1024
MAX_CHARS = 24000
MAX_ROWS = 1000
MAX_SHEETS = 32
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


class BoundedReadError(Exception):
    pass


def xml(archive, name):
    info = archive.getinfo(name)
    if info.file_size > MAX_MEMBER:
        raise BoundedReadError("OFFICE_MEMBER_LIMIT")
    data = archive.read(info)
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise BoundedReadError("OFFICE_XML_DECLARATION_UNSUPPORTED")
    return ET.fromstring(data)


def text_nodes(node, namespace):
    return "".join(item.text or "" for item in node.iter(namespace + "t"))


def docx(archive):
    document = xml(archive, "word/document.xml")
    lines, paragraphs, rows = [], 0, 0
    body = document.find(W + "body")
    if body is None:
        raise BoundedReadError("OFFICE_BODY_MISSING")
    for block in body:
        if block.tag == W + "p":
            paragraphs += 1
            lines.append(text_nodes(block, W))
        elif block.tag == W + "tbl":
            for row in block.findall(W + "tr"):
                rows += 1
                lines.append("\t".join(text_nodes(cell, W) for cell in row.findall(W + "tc")))
    return "\n".join(lines), {
        "unit": "body-paragraphs-and-basic-table-rows", "paragraphs": paragraphs,
        "tableRows": rows, "pages": "UNKNOWN",
        "excluded": ["headers", "footers", "drawings", "comments", "layout"],
    }, []


def xlsx(archive):
    shared = []
    if "xl/sharedStrings.xml" in archive.namelist():
        shared = [text_nodes(node, S) for node in xml(archive, "xl/sharedStrings.xml").findall(S + "si")]
    workbook = xml(archive, "xl/workbook.xml")
    date1904 = workbook.find(S + "workbookPr")
    date1904 = date1904 is not None and date1904.get("date1904") in ("1", "true")
    formats, styles = {}, []
    if "xl/styles.xml" in archive.namelist():
        style_xml = xml(archive, "xl/styles.xml")
        formats = {node.get("numFmtId"): node.get("formatCode", "") for node in style_xml.findall(S + "numFmts/" + S + "numFmt")}
        styles = [node.get("numFmtId", "0") for node in style_xml.findall(S + "cellXfs/" + S + "xf")]
    rels = {}
    for rel in xml(archive, "xl/_rels/workbook.xml.rels"):
        if rel.get("TargetMode") == "External":
            continue
        target = rel.get("Target", "")
        target = posixpath.normpath(target.lstrip("/") if target.startswith("/") else "xl/" + target)
        if target.startswith("xl/"):
            rels[rel.get("Id")] = target
    sheets = workbook.findall(S + "sheets/" + S + "sheet")
    lines, coverage, reasons = [], [], []
    if len(sheets) > MAX_SHEETS:
        reasons.append("OFFICE_SHEET_LIMIT")
    for sheet in sheets[:MAX_SHEETS]:
        name = sheet.get("name", "")
        target = rels.get(sheet.get(R + "id"))
        if not target:
            coverage.append({"sheet": name, "status": "UNREAD", "reason": "SHEET_RELATIONSHIP_UNAVAILABLE"})
            reasons.append("SHEET_RELATIONSHIP_UNAVAILABLE")
            continue
        try:
            rows = xml(archive, target).findall(S + "sheetData/" + S + "row")
        except (KeyError, ET.ParseError, BoundedReadError):
            coverage.append({"sheet": name, "status": "UNREAD", "reason": "SHEET_UNREADABLE"})
            reasons.append("SHEET_UNREADABLE")
            continue
        lines.append("Sheet: " + name)
        formulas_without_value = 0
        for row in rows[:MAX_ROWS]:
            values = []
            for cell in row.findall(S + "c"):
                value = cell.find(S + "v")
                kind = cell.get("t")
                if kind == "inlineStr":
                    rendered = text_nodes(cell, S)
                elif kind == "s" and value is not None:
                    try:
                        rendered = shared[int(value.text)]
                    except (ValueError, TypeError, IndexError):
                        rendered = "[unread shared string]"
                        reasons.append("SHARED_STRING_UNAVAILABLE")
                elif value is not None:
                    rendered = value.text or ""
                    try:
                        fmt = styles[int(cell.get("s", "0"))] if styles else "0"
                        code = re.sub(r'"[^"]*"|\\.', "", formats.get(fmt, "")).lower()
                        is_date = int(fmt) in range(14, 23) or bool(re.search(r"[yd]", code))
                        if kind not in ("b", "e", "str") and is_date and "[" not in code:
                            days = float(rendered)
                            base = datetime.datetime(1904, 1, 1) if date1904 else datetime.datetime(1899, 12, 30)
                            if not date1904 and 0 < days < 60:
                                days += 1
                            stamp = base + datetime.timedelta(days=days)
                            if int(fmt) in range(18, 22):
                                rendered = stamp.time().isoformat(timespec="seconds")
                            else:
                                rendered = stamp.isoformat(timespec="seconds") if stamp.time() != datetime.time() else stamp.date().isoformat()
                    except (ValueError, IndexError, OverflowError):
                        pass  # Preserve the exact stored value when a format cannot be interpreted.
                elif cell.find(S + "f") is not None:
                    rendered = "[formula has no cached value]"
                    formulas_without_value += 1
                else:
                    rendered = ""
                values.append(cell.get("r", "?") + "=" + rendered)
            lines.append("\t".join(values))
        coverage.append({"sheet": name, "rowsRead": min(len(rows), MAX_ROWS), "rowsTotal": len(rows),
                         "formulasWithoutCachedValue": formulas_without_value})
        if len(rows) > MAX_ROWS:
            reasons.append("OFFICE_ROW_LIMIT")
        if formulas_without_value:
            reasons.append("FORMULA_VALUE_UNAVAILABLE")
    return "\n".join(lines), {"unit": "basic-cells", "sheetsTotal": len(sheets), "sheets": coverage,
                             "values": "stored/cached values; basic date-formatted serials use the workbook date system without a timezone", "excluded": ["charts", "drawings", "formula evaluation", "complex formatting"]}, reasons


def read_document(file_path, kind):
    with open(file_path, "rb") as handle:
        data = handle.read(MAX_FILE + 1)
    if len(data) > MAX_FILE:
        raise BoundedReadError("OFFICE_FILE_LIMIT")
    sha = hashlib.sha256(data).hexdigest()
    if kind == "csv":
        source = data.decode("utf-8-sig")
        rows, total = [], 0
        for row in csv.reader(io.StringIO(source), strict=True):
            total += 1
            if total <= MAX_ROWS:
                rows.append("\t".join(row))
        content = "\n".join(rows)
        coverage = {"unit": "rows", "rowsRead": len(rows), "rowsTotal": total, "encoding": "utf-8"}
        reasons = ["OFFICE_ROW_LIMIT"] if total > MAX_ROWS else []
    else:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            members = archive.infolist()
            if len(members) > 4096 or sum(item.file_size for item in members) > MAX_EXPANDED:
                raise BoundedReadError("OFFICE_EXPANDED_LIMIT")
            if any(item.flag_bits & 1 for item in members):
                raise BoundedReadError("OFFICE_ENCRYPTED")
            content, coverage, reasons = docx(archive) if kind == "docx" else xlsx(archive)
    if len(content) > MAX_CHARS:
        reasons.append("OFFICE_TEXT_LIMIT")
    coverage["textCharactersTotal"] = len(content)
    coverage["textCharactersProvided"] = min(len(content), MAX_CHARS)
    return {"status": "PARTIAL" if reasons else "READ", "text": content[:MAX_CHARS],
            "contentSha256": sha, "coverage": coverage, "reasons": sorted(set(reasons))}


try:
    result = read_document(sys.argv[1], sys.argv[2])
except BoundedReadError as error:
    result = {"status": "FAILED", "reason": str(error)}
except UnicodeDecodeError:
    result = {"status": "FAILED", "reason": "OFFICE_TEXT_ENCODING_UNSUPPORTED"}
except (OSError, ValueError, KeyError, RuntimeError, zipfile.BadZipFile, ET.ParseError, csv.Error):
    result = {"status": "FAILED", "reason": "OFFICE_INVALID_OR_UNREADABLE"}
sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))
