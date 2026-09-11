/**
 * A small, correct delimited-text parser. Handles quoted fields containing the
 * delimiter, escaped quotes (`""`), CRLF, and a UTF-8 BOM — which between them
 * account for essentially every "the import broke" ticket you would otherwise
 * get from a spreadsheet exported on someone's laptop.
 *
 * .xlsx goes through a converter first (SheetJS, or LibreOffice headless) and
 * arrives here as rows; the importer below takes parsed rows either way, so
 * nothing downstream cares which format the admin uploaded.
 */
export function parseDelimited(
  input: string,
  delimiter?: string,
): string[][] {
  const text = input.replace(/^﻿/, "");
  const delim = delimiter ?? sniffDelimiter(text);
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\r") {
      // handled by the \n branch
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function sniffDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts: Record<string, number> = {
    ",": 0,
    "\t": 0,
    ";": 0,
  };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]!++;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : ",";
}

/** Headers arrive as "Mentor Email", "mentor_email", "MENTOR E-MAIL". */
export function normaliseHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[\s\-.]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}
