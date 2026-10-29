import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as XLSX from 'xlsx';

// =====================================================================
// The lead fields an import can fill, and the column names we recognise
// =====================================================================
export type ImportFieldKey =
  | 'name'
  | 'phone'
  | 'whatsapp_number'
  | 'whatsapp_username'
  | 'alt_phone'
  | 'email'
  | 'area'
  | 'guardian_name'
  | 'guardian_phone'
  | 'guardian_relation'
  | 'source'
  | 'course'
  | 'notes';

export type ImportField = {
  key: ImportFieldKey;
  label: string;
  required?: boolean;
  aliases: string[]; // lower-case column names that mean this field
};

// Order matters: more specific fields first (guardian phone before phone).
// A row needs a name and one of: phone, WhatsApp number, WhatsApp username.
export const IMPORT_FIELDS: ImportField[] = [
  {
    key: 'guardian_phone',
    label: 'Guardian phone',
    aliases: ['guardian phone', 'guardian mobile', 'father phone', 'father mobile', "father's mobile",
      "father's phone", 'parent phone', 'parent mobile', 'অভিভাবকের মোবাইল'],
  },
  {
    key: 'guardian_name',
    label: 'Guardian name',
    aliases: ['guardian name', 'guardian', 'father name', "father's name", 'father', 'parent name', 'অভিভাবক'],
  },
  {
    key: 'guardian_relation',
    label: 'Guardian relation',
    aliases: ['relation', 'guardian relation', 'relationship'],
  },
  {
    key: 'alt_phone',
    label: 'Alternative phone',
    aliases: ['alt phone', 'alternative phone', 'alternate phone', 'phone 2', 'mobile 2', 'other phone', 'second phone'],
  },
  {
    key: 'whatsapp_username',
    label: 'WhatsApp username',
    aliases: ['whatsapp username', 'wa username', 'whatsapp user', 'whatsapp id', 'username', 'user name'],
  },
  {
    key: 'whatsapp_number',
    label: 'WhatsApp number',
    aliases: ['whatsapp', 'whatsapp number', 'whatsapp no', 'whatsapp mobile', 'wa number', 'wa',
      'হোয়াটসঅ্যাপ'],
  },
  {
    key: 'phone',
    label: 'Phone',
    aliases: ['phone', 'mobile', 'mobile no', 'mobile number', 'phone no', 'phone number', 'contact',
      'contact no', 'contact number', 'cell', 'number', 'মোবাইল', 'ফোন'],
  },
  {
    key: 'name',
    label: 'Name',
    required: true,
    aliases: ['name', 'student name', 'full name', 'student', 'lead name', 'নাম'],
  },
  { key: 'email', label: 'Email', aliases: ['email', 'e-mail', 'email address', 'mail'] },
  { key: 'area', label: 'Area', aliases: ['area', 'thana', 'address', 'location', 'district', 'upazila', 'এলাকা'] },
  { key: 'source', label: 'Source', aliases: ['source', 'lead source', 'from', 'channel'] },
  {
    key: 'course',
    label: 'Course',
    aliases: ['course', 'program', 'programme', 'subject', 'interested in', 'interested course', 'department'],
  },
  { key: 'notes', label: 'Notes', aliases: ['note', 'notes', 'remarks', 'remark', 'comment', 'comments'] },
];

export type ColumnMapping = Partial<Record<ImportFieldKey, number | null>>;

export type ImportRow = { row: number } & Partial<Record<ImportFieldKey, string>>;

export type Spreadsheet = { headers: string[]; rows: string[][] };

// =====================================================================
// Pick a file
// =====================================================================
const SPREADSHEET_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // .xls
  'text/csv',
  'text/comma-separated-values',
  'application/csv',
];

export async function pickSpreadsheet(): Promise<{ name: string; uri: string } | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: SPREADSHEET_TYPES,
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled || !result.assets?.[0]) return null;
  const asset = result.assets[0];
  return { name: asset.name, uri: asset.uri };
}

// =====================================================================
// Read the first sheet into headers + rows (all cells as text)
// =====================================================================
function cellToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  // Numbers (e.g. phone 1711234567) come without scientific notation
  if (typeof value === 'number') return Number.isInteger(value) ? value.toFixed(0) : String(value);
  return String(value).trim();
}

export async function readSpreadsheet(uri: string): Promise<Spreadsheet> {
  const bytes = await new File(uri).bytes();
  const workbook = XLSX.read(bytes, { type: 'array' });

  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error('This file has no sheets.');

  const sheet = workbook.Sheets[firstSheetName];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: '' });

  const [headerRow, ...dataRows] = grid;
  if (!headerRow) throw new Error('The file is empty.');

  const headers = headerRow.map(cellToText);
  const rows = dataRows
    .map((r) => headers.map((_, i) => cellToText(r[i])))
    .filter((r) => r.some((cell) => cell !== '')); // drop blank lines

  if (rows.length === 0) throw new Error('No data rows found under the header row.');
  return { headers, rows };
}

// =====================================================================
// Guess which column is which field
// =====================================================================
const normalise = (s: string) => s.toLowerCase().replace(/[_\-.:]/g, ' ').replace(/\s+/g, ' ').trim();

export function autoMapColumns(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<number>();
  const cleanHeaders = headers.map(normalise);

  // 1st pass: exact matches
  for (const field of IMPORT_FIELDS) {
    const index = cleanHeaders.findIndex((h, i) => !used.has(i) && field.aliases.includes(h));
    if (index >= 0) {
      mapping[field.key] = index;
      used.add(index);
    }
  }

  // 2nd pass: header contains an alias (e.g. "Student Mobile Number")
  for (const field of IMPORT_FIELDS) {
    if (mapping[field.key] != null) continue;
    const index = cleanHeaders.findIndex(
      (h, i) => !used.has(i) && field.aliases.some((alias) => alias.length > 3 && h.includes(alias)),
    );
    if (index >= 0) {
      mapping[field.key] = index;
      used.add(index);
    }
  }

  return mapping;
}

// =====================================================================
// Turn sheet rows into import rows using the mapping
// =====================================================================
export function buildImportRows(sheet: Spreadsheet, mapping: ColumnMapping): ImportRow[] {
  return sheet.rows.map((cells, index) => {
    const row: ImportRow = { row: index + 2 }; // +2: header is row 1 in Excel
    for (const field of IMPORT_FIELDS) {
      const col = mapping[field.key];
      if (col != null) row[field.key] = cells[col] ?? '';
    }
    return row;
  });
}

// =====================================================================
// Write an Excel file and open the share sheet
// =====================================================================
export async function writeAndShareSpreadsheet(
  fileName: string,
  headers: string[],
  rows: (string | number | null)[][],
  sheetName = 'Sheet1',
): Promise<void> {
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows.map((r) => r.map((v) => v ?? ''))]);

  // Reasonable column widths
  sheet['!cols'] = headers.map((h, i) => ({
    wch: Math.min(40, Math.max(h.length, ...rows.slice(0, 200).map((r) => String(r[i] ?? '').length)) + 2),
  }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName.slice(0, 31));
  const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

  const file = new File(Paths.cache, fileName);
  file.create({ overwrite: true });
  await file.write(new Uint8Array(bytes));

  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this phone.');
  }

  await Sharing.shareAsync(file.uri, {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    dialogTitle: fileName,
    UTI: 'org.openxmlformats.spreadsheetml.sheet',
  });
}

// =====================================================================
// A ready-made template for preparing import files
// =====================================================================
export async function shareImportTemplate(): Promise<void> {
  const headers = IMPORT_FIELDS.map((f) => f.label);
  const example: Record<ImportFieldKey, string> = {
    name: 'Nusrat Akter',
    phone: '01711234567',
    whatsapp_number: '',
    whatsapp_username: '',
    alt_phone: '',
    email: 'nusrat@example.com',
    area: 'Mirpur',
    guardian_name: 'Abdul Akter',
    guardian_phone: '01811234567',
    guardian_relation: 'Father',
    source: 'Facebook',
    course: 'BBA',
    notes: 'Asked about fees',
  };
  await writeAndShareSpreadsheet(
    'lead-import-template.xlsx',
    headers,
    [IMPORT_FIELDS.map((f) => example[f.key])],
    'Leads',
  );
}

export const fieldLabel = (key: ImportFieldKey) => IMPORT_FIELDS.find((f) => f.key === key)?.label ?? key;