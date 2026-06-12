import path from 'path';
import fs from 'fs';
import Handlebars from 'handlebars';
import puppeteer, { Browser } from 'puppeteer';
import { supabaseAdmin } from '../supabaseClient';
import { findSchoolById } from '../db/queries/schools';
import {
  fetchStudentReportData,
  fetchSubjectComments,
  fetchPrincipalRemark,
  upsertReportCard,
} from '../db/queries/reportCards';
import { computeClassResults } from './resultEngine';
import type { ClassResult } from './resultEngine';

// ── Template compilation (lazy, once per template) ────────────────────────────

export type TemplateName = 'classic' | 'modern';

type CompiledTemplate = ReturnType<typeof Handlebars.compile>;

const TEMPLATE_FILES: Record<TemplateName, string> = {
  classic: 'reportCard.hbs',
  modern: 'reportCardModern.hbs',
};

const compiledTemplates = new Map<TemplateName, CompiledTemplate>();

export function getTemplate(name: TemplateName = 'classic'): CompiledTemplate {
  let tpl = compiledTemplates.get(name);
  if (!tpl) {
    const tplPath = path.join(__dirname, `../templates/${TEMPLATE_FILES[name]}`);
    const source = fs.readFileSync(tplPath, 'utf-8');
    tpl = Handlebars.compile(source);
    compiledTemplates.set(name, tpl);
  }
  return tpl;
}

// ── Report config overrides ───────────────────────────────────────────────────

export interface ReportConfigOverrides {
  template?: string;
  show_attendance?: boolean;
  footer_text?: string;
  next_term_resumption?: string | null;
}

// Applies school-level report card settings (template selector, attendance
// toggle, custom footer, principal signature, resumption-date override) onto
// a built templateData object, mutating and returning it.
export function applyReportConfig(
  templateData: Record<string, unknown>,
  reportConfig: ReportConfigOverrides,
  signatureUrl: string | null
): Record<string, unknown> {
  const showAttendance = reportConfig.show_attendance !== false;
  templateData.showAttendance = showAttendance;
  templateData.remarkFlex = showAttendance ? 2 : 3;
  templateData.footerText = reportConfig.footer_text || null;
  (templateData.school as Record<string, unknown>).signatureUrl = signatureUrl;

  if (reportConfig.next_term_resumption) {
    (templateData.term as Record<string, unknown>).nextTermResumption = reportConfig.next_term_resumption;
  }

  return templateData;
}

// ── In-memory job store ────────────────────────────────────────────────────────

export type JobStatus = 'pending' | 'running' | 'done' | 'error';

export interface ReportCardJob {
  jobId:     string;
  status:    JobStatus;
  classId:   string;
  termId:    string;
  schoolId:  string;
  total:     number;
  completed: number;
  failed:    number;
  errors:    string[];
  startedAt: Date;
  finishedAt?: Date;
}

const jobs = new Map<string, ReportCardJob>();

export function getJob(jobId: string): ReportCardJob | undefined {
  return jobs.get(jobId);
}

// ── Browser singleton ──────────────────────────────────────────────────────────

let browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
  }
  return browser;
}

export async function closeReportCardBrowser(): Promise<void> {
  if (browser?.isConnected()) {
    await browser.close();
    browser = null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

export function gradeClass(grade: string): string {
  return ['A', 'B', 'C', 'D', 'F'].includes(grade) ? grade : 'F';
}

export function lookupGrade(score: number, scale: Array<{ min: number; max: number; grade: string }>): string {
  for (const band of scale) {
    if (score >= band.min && score <= band.max) return band.grade;
  }
  return 'F';
}

// Build per-subject position from class results (DENSE_RANK per subject)
export function buildSubjectPositions(
  classResult: ClassResult
): Map<string, Map<string, number>> {
  // subjectId → studentId → position
  const out = new Map<string, Map<string, number>>();

  // Gather all subject IDs
  const subjectIds = new Set<string>();
  for (const s of classResult.students) {
    for (const sub of s.subjects) subjectIds.add(sub.subject_id);
  }

  for (const subjectId of subjectIds) {
    // Collect (studentId, totalScore) pairs, sorted descending
    const rows: Array<{ studentId: string; total: number }> = [];
    for (const s of classResult.students) {
      const sub = s.subjects.find(x => x.subject_id === subjectId);
      rows.push({ studentId: s.student_id, total: sub?.result?.total_score ?? 0 });
    }
    rows.sort((a, b) => b.total - a.total);

    const posMap = new Map<string, number>();
    let pos = 1;
    for (let i = 0; i < rows.length; i++) {
      if (i > 0 && rows[i].total < rows[i - 1].total) pos = i + 1;
      posMap.set(rows[i].studentId, pos);
    }
    out.set(subjectId, posMap);
  }
  return out;
}

// ── Core PDF generator ─────────────────────────────────────────────────────────

export async function generateReportCard(
  studentId: string,
  termId: string,
  schoolId: string,
  classResult: ClassResult,
  subjectPositions: Map<string, Map<string, number>>
): Promise<string> {
  const [studentData, school] = await Promise.all([
    fetchStudentReportData(studentId, termId, schoolId),
    findSchoolById(schoolId),
  ]);

  if (!studentData) throw new Error(`Student report data not found for ${studentId}`);
  if (!school)      throw new Error(`School not found: ${schoolId}`);

  const [comments, principalRemark] = await Promise.all([
    fetchSubjectComments(studentId, termId),
    fetchPrincipalRemark(studentId, termId),
  ]);

  const commentMap = new Map(comments.map(c => [c.subject_id, c.comment_text]));

  const identityConfig = (school.identity_config ?? {}) as Record<string, string | null>;
  const academicConfig = (school.academic_config ?? {}) as Record<string, unknown>;
  const reportConfig = (school.report_config ?? {}) as ReportConfigOverrides;

  // Grading scale from academic_config (or default)
  const gradingScale: Array<{ min: number; max: number; grade: string }> =
    Array.isArray(academicConfig.grading_scale)
      ? (academicConfig.grading_scale as Array<{ min: number; max: number; grade: string }>)
      : [
          { min: 70, max: 100, grade: 'A' },
          { min: 60, max: 69,  grade: 'B' },
          { min: 50, max: 59,  grade: 'C' },
          { min: 40, max: 49,  grade: 'D' },
          { min: 0,  max: 39,  grade: 'F' },
        ];

  const promotionCutoff =
    typeof academicConfig.promotion_cutoff === 'number'
      ? (academicConfig.promotion_cutoff as number)
      : 40;

  // Find this student's record in classResult
  const studentRecord = classResult.students.find(s => s.student_id === studentId);

  // Collect all assessment component headers (ordered union across all subjects)
  const componentHeaderSet: string[] = [];
  if (studentRecord) {
    for (const sub of studentRecord.subjects) {
      for (const comp of sub.result?.components ?? []) {
        if (!componentHeaderSet.includes(comp.name)) componentHeaderSet.push(comp.name);
      }
    }
  }

  // Build subject rows aligned to componentHeaderSet
  const subjectRows = (studentRecord?.subjects ?? []).map(sub => {
    const scoreByName = new Map<string, number | null>();
    for (const comp of sub.result?.components ?? []) {
      scoreByName.set(comp.name, comp.contribution);
    }

    const componentScores = componentHeaderSet.map(h => {
      const v = scoreByName.get(h);
      return v !== null && v !== undefined ? v.toFixed(2) : '—';
    });

    const totalScore = sub.result ? sub.result.total_score.toFixed(2) : '—';
    const grade      = sub.result ? lookupGrade(sub.result.total_score, gradingScale) : '—';
    const posMap     = subjectPositions.get(sub.subject_id);
    const posNum     = posMap?.get(studentId);
    const position   = posNum !== undefined ? ordinal(posNum) : '—';

    // Class average for this subject
    let classTotal = 0; let classCount = 0;
    for (const s of classResult.students) {
      const r = s.subjects.find(x => x.subject_id === sub.subject_id)?.result;
      if (r) { classTotal += r.total_score; classCount++; }
    }
    const classAverage = classCount > 0 ? (classTotal / classCount).toFixed(1) : '—';

    return {
      name:            sub.subject_name,
      componentScores,
      totalScore,
      grade:           gradeClass(grade),
      position,
      classAverage,
      teacherComment:  commentMap.get(sub.subject_id) ?? null,
    };
  });

  const hasComments = subjectRows.some(s => s.teacherComment);

  // Overall average
  const scoredSubjects = (studentRecord?.subjects ?? []).filter(s => s.result !== null);
  const overallAvg =
    scoredSubjects.length > 0
      ? scoredSubjects.reduce((sum, s) => sum + (s.result?.total_score ?? 0), 0) /
        scoredSubjects.length
      : 0;
  const overallGrade = overallAvg > 0 ? lookupGrade(overallAvg, gradingScale) : '—';

  let promotionClass: 'promoted' | 'repeat' | 'pending';
  let promotionStatus: string;
  if (scoredSubjects.length === 0) {
    promotionClass = 'pending'; promotionStatus = 'Pending';
  } else if (overallAvg >= promotionCutoff) {
    promotionClass = 'promoted'; promotionStatus = 'Promoted';
  } else {
    promotionClass = 'repeat'; promotionStatus = 'Repeat Class';
  }

  const templateData = {
    school: {
      name:     school.name,
      logoUrl:  identityConfig.logo_url   ?? null,
      stampUrl: identityConfig.stamp_url  ?? null,
      motto:    identityConfig.motto      ?? null,
      address:  identityConfig.address    ?? null,
    },
    student: {
      fullName:    `${studentData.first_name} ${studentData.last_name}`,
      admissionNo: studentData.admission_no,
      photoUrl:    studentData.photo_url,
      className:   studentData.class_name,
    },
    term: {
      name:                studentData.term_name,
      sessionName:         studentData.session_name,
      nextTermResumption:  studentData.next_term_resumption,
    },
    componentHeaders: componentHeaderSet,
    overallColspan:   1 + componentHeaderSet.length,
    subjects:         subjectRows,
    overall: {
      average:      overallAvg > 0 ? overallAvg.toFixed(2) : '—',
      grade:        gradeClass(overallGrade),
      position:     studentRecord?.position !== undefined ? ordinal(studentRecord.position) : '—',
      totalStudents: classResult.students.length,
    },
    hasComments,
    principalRemark: principalRemark?.remark_text ?? null,
    attendance: {
      daysPresent: '—',
      daysAbsent:  '—',
      totalDays:   '—',
      percentage:  '—',
    },
    promotionClass,
    promotionStatus,
    generatedAt: new Date().toLocaleDateString('en-GB', {
      day: '2-digit', month: 'long', year: 'numeric',
    }),
  };

  applyReportConfig(templateData, reportConfig, identityConfig.signature_url ?? null);

  // Render HTML
  const templateName: TemplateName = reportConfig.template === 'modern' ? 'modern' : 'classic';
  const html = getTemplate(templateName)(templateData);

  // Generate PDF via Puppeteer
  const b   = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load', timeout: 15_000 });
    const pdfBuffer = await page.pdf({
      format:          'a4',
      printBackground: true,
      margin:          { top: '5mm', bottom: '5mm', left: '0', right: '0' },
    });

    // Upload to Supabase Storage: report-cards/{schoolId}/{termId}/{studentId}.pdf
    const storagePath = `${schoolId}/${termId}/${studentId}.pdf`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from('report-cards')
      .upload(storagePath, Buffer.from(pdfBuffer), {
        contentType: 'application/pdf',
        upsert:      true,
      });

    if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

    const { data: { publicUrl } } = supabaseAdmin.storage
      .from('report-cards')
      .getPublicUrl(storagePath);

    // Persist record
    await upsertReportCard(studentId, termId, schoolId, publicUrl);

    return publicUrl;
  } finally {
    await page.close();
  }
}

// ── Live preview (settings page) ──────────────────────────────────────────────

function dummyTemplateData(): Record<string, unknown> {
  return {
    student: {
      fullName:    'Jane Doe',
      admissionNo: 'CE/2026/0001',
      photoUrl:    null,
      className:   'JSS 2A',
    },
    term: {
      name:               'First Term',
      sessionName:        '2025/2026',
      nextTermResumption: '2026-09-08',
    },
    componentHeaders: ['CA1', 'CA2', 'Exam'],
    overallColspan:   4,
    subjects: [
      { name: 'Mathematics',      componentScores: ['9.00', '8.00', '65.00'], totalScore: '82.00', grade: 'A', position: '1st', classAverage: '68.5', teacherComment: 'Excellent performance this term.' },
      { name: 'English Language', componentScores: ['7.00', '8.00', '55.00'], totalScore: '70.00', grade: 'B', position: '3rd', classAverage: '60.2', teacherComment: 'Good effort, keep it up.' },
      { name: 'Basic Science',    componentScores: ['8.00', '7.00', '50.00'], totalScore: '65.00', grade: 'B', position: '4th', classAverage: '58.0', teacherComment: null },
    ],
    overall: {
      average:       '72.33',
      grade:         'B',
      position:      '2nd',
      totalStudents: 32,
    },
    hasComments: true,
    principalRemark: 'A commendable result. Keep up the good work.',
    attendance: {
      daysPresent: 58,
      daysAbsent:  2,
      totalDays:   60,
      percentage:  '96.7%',
    },
    promotionClass:  'promoted',
    promotionStatus: 'Promoted',
    generatedAt: new Date().toLocaleDateString('en-GB', {
      day: '2-digit', month: 'long', year: 'numeric',
    }),
  };
}

// Renders a report card PDF for dummy student data using the school's real
// branding (logo/stamp/signature/motto) and the given (possibly unsaved)
// report config — used for the settings page's live preview.
export async function generateReportCardPreview(
  schoolId: string,
  reportConfig: ReportConfigOverrides
): Promise<Buffer> {
  const school = await findSchoolById(schoolId);
  if (!school) throw new Error(`School not found: ${schoolId}`);

  const identityConfig = (school.identity_config ?? {}) as Record<string, string | null>;

  const templateData = dummyTemplateData();
  templateData.school = {
    name:     school.name,
    logoUrl:  identityConfig.logo_url  ?? null,
    stampUrl: identityConfig.stamp_url ?? null,
    motto:    identityConfig.motto     ?? null,
    address:  identityConfig.address   ?? null,
  };

  applyReportConfig(templateData, reportConfig, identityConfig.signature_url ?? null);

  const templateName: TemplateName = reportConfig.template === 'modern' ? 'modern' : 'classic';
  const html = getTemplate(templateName)(templateData);

  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load', timeout: 15_000 });
    const pdfBuffer = await page.pdf({
      format:          'a4',
      printBackground: true,
      margin:          { top: '5mm', bottom: '5mm', left: '0', right: '0' },
    });
    return Buffer.from(pdfBuffer);
  } finally {
    await page.close();
  }
}

// ── Async batch processor ──────────────────────────────────────────────────────

export function startReportCardBatch(
  jobId: string,
  classId: string,
  termId: string,
  schoolId: string,
  eligibleStudents: Array<{ student_id: string }>
): void {
  const job: ReportCardJob = {
    jobId,
    status:    'pending',
    classId,
    termId,
    schoolId,
    total:     eligibleStudents.length,
    completed: 0,
    failed:    0,
    errors:    [],
    startedAt: new Date(),
  };
  jobs.set(jobId, job);

  // Run asynchronously — caller does not await
  void runBatch(job, eligibleStudents);
}

async function runBatch(
  job: ReportCardJob,
  students: Array<{ student_id: string }>
): Promise<void> {
  job.status = 'running';

  try {
    const classResult = await computeClassResults(job.classId, job.termId, job.schoolId);
    const subjectPositions = buildSubjectPositions(classResult);

    for (const student of students) {
      try {
        await generateReportCard(
          student.student_id,
          job.termId,
          job.schoolId,
          classResult,
          subjectPositions
        );
        job.completed++;
      } catch (err) {
        job.failed++;
        job.errors.push(
          `${student.student_id}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  } catch (err) {
    job.status = 'error';
    job.errors.push(`Batch failed: ${err instanceof Error ? err.message : String(err)}`);
    job.finishedAt = new Date();
    return;
  }

  job.status    = job.failed === 0 ? 'done' : 'error';
  job.finishedAt = new Date();
}
