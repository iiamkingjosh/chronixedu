/** Shared by every CSV the API produces: the super-admin exports and the school data export. */

// Escapes a value for inclusion in a CSV cell.
export function csvCell(value: unknown): string {
  let str = value === null || value === undefined ? '' : String(value);
  // Prevent formula/DDE injection: a cell whose first character is =, +, -, @, tab, or
  // CR can be interpreted as a formula by Excel/LibreOffice when the CSV is opened.
  // Prefixing with a leading apostrophe forces it to be read back as literal text.
  // This must run before the quote-escaping below so the apostrophe is included in
  // whatever gets quoted.
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
