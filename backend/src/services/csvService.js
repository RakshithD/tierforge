// CSV service: parses and strictly validates the uploaded store CSV before any database work.

import { parse } from 'csv-parse/sync';
import { HttpError } from '../middleware/errorHandler.js';

// The exact column set a valid upload must contain (order-independent).
export const REQUIRED_HEADERS = ['store_id', 'store_name', 'address', 'city', 'state', 'country'];
const MAX_PROBLEMS = 10; // cap reported row errors so the response stays small

// Throw a 400 HttpError; used for all CSV validation failures.
function fail(code, message, details = []) {
  throw new HttpError(400, code, message, details);
}

/**
 * Parse and validate CSV text. Returns an array of trimmed store rows or throws HttpError(400).
 * Checks, in order: non-empty file -> exact header set (no missing/extra/duplicate)
 * -> at least one data row -> per-row rules (store_id and store_name required,
 * store_id unique). Rows are collected before failing so the user sees several errors at once.
 */
export function parseStoresCsv(buffer) {
  let text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  // Strip the UTF-8 BOM that Excel adds, otherwise the first header would not match.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.trim() === '') fail('EMPTY_FILE', 'The uploaded file is empty');

  let records;
  try {
    records = parse(text, {
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    });
  } catch (err) {
    fail('INVALID_CSV', `Could not parse CSV: ${err.message}`);
  }
  if (records.length === 0) fail('EMPTY_FILE', 'The uploaded file is empty');

  const headers = records[0].map((h) => h.trim());
  const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  const extra = headers.filter((h) => !REQUIRED_HEADERS.includes(h));
  const dupHeaders = headers.filter((h, i) => headers.indexOf(h) !== i);
  if (missing.length || extra.length || dupHeaders.length) {
    const parts = [];
    if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
    if (extra.length) parts.push(`unexpected: ${extra.join(', ')}`);
    if (dupHeaders.length) parts.push(`duplicated: ${[...new Set(dupHeaders)].join(', ')}`);
    fail('INVALID_HEADERS', `Invalid CSV headers (${parts.join('; ')})`, [
      ...missing.map((h) => ({ field: h, problem: 'missing' })),
      ...extra.map((h) => ({ field: h, problem: 'unexpected' })),
      ...[...new Set(dupHeaders)].map((h) => ({ field: h, problem: 'duplicated' })),
    ]);
  }

  const dataRows = records.slice(1);
  if (dataRows.length === 0) fail('NO_ROWS', 'The file contains a header but no data rows');

  const problems = [];
  const addProblem = (row, message) => {
    if (problems.length < MAX_PROBLEMS) problems.push({ row, message });
  };

  const stores = [];
  const seen = new Map(); // store_id -> first row number
  dataRows.forEach((cells, i) => {
    const rowNumber = i + 2; // 1-based, header is row 1 (matches what the user sees in a spreadsheet)
    // Map cells to header names, so column order in the file doesn't matter.
    const rec = {};
    headers.forEach((h, idx) => {
      rec[h] = (cells[idx] ?? '').trim();
    });
    if (!rec.store_id) addProblem(rowNumber, 'store_id is required');
    if (!rec.store_name) addProblem(rowNumber, 'store_name is required');
    if (rec.store_id) {
      if (seen.has(rec.store_id)) {
        addProblem(rowNumber, `duplicate store_id "${rec.store_id}" (first seen on row ${seen.get(rec.store_id)})`);
      } else {
        seen.set(rec.store_id, rowNumber);
      }
    }
    stores.push(Object.fromEntries(REQUIRED_HEADERS.map((h) => [h, rec[h]])));
  });

  if (problems.length) {
    fail('INVALID_ROWS', `CSV has invalid rows (showing first ${problems.length})`, problems);
  }
  return stores;
}
