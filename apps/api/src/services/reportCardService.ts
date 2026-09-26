import path from 'path';
import fs from 'fs';
import Handlebars from 'handlebars';
import puppeteer, { Browser } from 'puppeteer';
import { supabaseAdmin } from '../supabaseClient';
import { findSchoolById } from '../db/queries/schools';
import {
  fetchStudentReportData,
  fetchClassTeacherComment,
  fetchFormTeacher,
  fetchPrincipalRemark,
  upsertReportCard,
  fetchClassLevel,
} from '../db/queries/reportCards';
import { computeClassResults, lookupGrade } from './resultEngine';
import type { ClassResult, GradeBand } from './resultEngine';

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

// ── Storage access (signed URLs) ────────────────────────────────────────────────
// Report cards, transcripts, and receipts all live in the same private 'report-cards'
// Supabase Storage bucket. Objects are addressed by storage path (never a public URL) —
// a fresh, short-lived signed URL is minted at the point of serving to an authenticated
// client, after the caller's role/ownership checks have already passed.

export const REPORT_CARDS_BUCKET = 'report-cards';

export const DEFAULT_SIGNED_URL_TTL_SECONDS = 15 * 60; // 15 minutes

/**
 * Extracts the bare storage object path from either a bare path (returned as-is) or a
 * legacy Supabase public URL (e.g. rows persisted before this bucket was made private).
 * Kept for backward compatibility with any already-stored public-URL values.
 */
export function extractStoragePath(pdfUrlOrPath: string, bucket: string = REPORT_CARDS_BUCKET): string {
  const marker = `/storage/v1/object/public/${bucket}/`;
  const idx = pdfUrlOrPath.indexOf(marker);
  if (idx === -1) return pdfUrlOrPath;
  return decodeURIComponent(pdfUrlOrPath.slice(idx + marker.length));
}

/**
 * Mints a fresh, time-limited signed URL for an object in the report-cards bucket.
 * Accepts either a bare storage path or a legacy full public URL. Returns null if the
 * object cannot be signed (e.g. it no longer exists in storage).
 */
export async function signReportCardAsset(
  pdfUrlOrPath: string,
  ttlSeconds: number = DEFAULT_SIGNED_URL_TTL_SECONDS
): Promise<string | null> {
  const storagePath = extractStoragePath(pdfUrlOrPath);
  const { data, error } = await supabaseAdmin.storage
    .from(REPORT_CARDS_BUCKET)
    .createSignedUrl(storagePath, ttlSeconds);
  if (error || !data) return null;
  return data.signedUrl;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/**
 * Colour tier for a grade cell, derived from the band's RANK in the resolved scale —
 * never from the grade text.
 *
 * The templates define .grade-A through .grade-F and nothing else, and the old helper
 * squeezed the grade into that set with
 * `['A','B','C','D','F'].includes(grade) ? grade : 'F'`. Because the same value was
 * used as BOTH the CSS class suffix and the printed text, the squeeze leaked onto the
 * page: an unscored subject's em-dash printed as a bold red F, and every band of a
 * WAEC A1–F9 scale printed F, including a score of 80.
 *
 * Deriving the class from the text instead — first character, say — rebuilds the same
 * bug more quietly: it works for A1/F9 and then fails on the word scales
 * (Excellent/Credit/Pass/Fail) and numeric 1–9 scales Nigerian schools also use. Rank
 * exists for every scale whatever the labels say, so that is what this reads. The label
 * is for reading; the colour is for ranking; they are different functions of one band.
 */
export function gradeCss(band: GradeBand | null, scale: GradeBand[]): string {
  if (!band || scale.length === 0) return 'none';
  const bestFirst = [...scale].sort((a, b) => b.min - a.min);
  const rank = bestFirst.findIndex(b => b.min === band.min && b.max === band.max);
  if (rank < 0) return 'none';
  const tiers = ['A', 'B', 'C', 'D', 'F'];
  // Anchored at both ends: the best band is always 'A' and the WORST is always 'F',
  // whatever the scale's length. Scaling by length alone put the worst band of a
  // four-band word scale ('Fail') on 'D'.
  if (bestFirst.length === 1) return tiers[0];
  return tiers[Math.round((rank * (tiers.length - 1)) / (bestFirst.length - 1))];
}

// Promotion decisions are only made at the end of the academic session (Third Term).
export function computePromotionStatus(
  termName: string,
  scoredSubjectsCount: number,
  overallAvg: number,
  promotionCutoff: number | null
): { promotionClass: 'promoted' | 'repeat' | 'pending' | 'not-applicable'; promotionStatus: string } {
  if (termName.trim().toLowerCase() !== 'third term') {
    return { promotionClass: 'not-applicable', promotionStatus: 'Term Completed' };
  }
  if (scoredSubjectsCount === 0) {
    return { promotionClass: 'pending', promotionStatus: 'Pending' };
  }
  // The school has not set a pass mark, so there is nothing to decide against.
  // Refusing to assert is a case this function already knows how to express; printing
  // "Repeat Class" from a default would be Chronix deciding a child's year.
  if (promotionCutoff === null) {
    return { promotionClass: 'pending', promotionStatus: 'Not determined' };
  }
  if (overallAvg >= promotionCutoff) {
    return { promotionClass: 'promoted', promotionStatus: 'Promoted' };
  }
  return { promotionClass: 'repeat', promotionStatus: 'Repeat Class' };
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

/**
 * Renders and stores a student's report card PDF. Returns the storage path (not a URL) —
 * the object lives in a private bucket, so callers must mint a signed URL via
 * `signReportCardAsset` at the point of serving it to a client.
 */
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

  const [classTeacherComment, formTeacher, principalRemark] = await Promise.all([
    fetchClassTeacherComment(studentId, termId),
    fetchFormTeacher(studentData.class_id),
    fetchPrincipalRemark(studentId, termId),
  ]);

  const identityConfig = (school.identity_config ?? {}) as Record<string, string | null>;

  // academic_config may carry per-level overrides so a school running both a primary
  // and a secondary section can grade them differently (school_settings holds exactly
  // one row per school, so without this every section shares one scale). Keyed by
  // classes.level, matching how assessment_configs already resolve.
  const baseAcademicConfig = (school.academic_config ?? {}) as Record<string, unknown>;
  const classLevel = await fetchClassLevel(studentData.class_id, schoolId);
  const levelOverrides = (baseAcademicConfig.level_overrides ?? {}) as Record<string, Record<string, unknown>>;
  const academicConfig: Record<string, unknown> = classLevel && levelOverrides[classLevel]
    ? { ...baseAcademicConfig, ...levelOverrides[classLevel] }
    : baseAcademicConfig;
  const reportConfig = (school.report_config ?? {}) as ReportConfigOverrides;

  // The scale comes from academic_config, resolved per class level by
  // fetchAcademicConfig. There is deliberately NO hard-coded fallback: a second scale
  // living here meant a school whose config was missing got a report card graded
  // against 70/60/50/40 that it had never agreed to, silently and differently from
  // every other screen. An empty scale now yields no grade rather than a wrong one.
  const gradingScale: GradeBand[] = Array.isArray(academicConfig.grading_scale)
    ? (academicConfig.grading_scale as GradeBand[])
    : [];

  const promotionCutoff: number | null =
    typeof academicConfig.promotion_cutoff === 'number'
      ? (academicConfig.promotion_cutoff as number)
      : null;

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
    // An unscored subject has no grade. It used to print a bold red F here, beside a
    // total of '—' — the report card said "no score, F" about the same subject.
    const band       = sub.result ? lookupGrade(sub.result.total_score, gradingScale) : null;
    const grade      = band ? band.grade : '—';
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
      grade,                              // printed as configured: A, A1, Credit, 1…
      gradeCss:        gradeCss(band, gradingScale), // colour only
      position,
      classAverage,
    };
  });

  // Read, do not recompute. computeClassResults already produced overall_average for
  // this student, and it is what the approval screen, the principal's student list and
  // the class summary all show. A third derivation here is a third chance to disagree
  // with the other two about the same number.
  const scoredSubjects = (studentRecord?.subjects ?? []).filter(s => s.result !== null);
  const overallAvg = studentRecord?.overall_average ?? 0;
  // The grade comes from the engine too, not from a second lookup here. gradeCss still
  // needs the band for its colour, so resolve that — but the printed grade is the
  // engine's, which is what the approval screen and student list show.
  const overallBand = scoredSubjects.length > 0 ? lookupGrade(overallAvg, gradingScale) : null;
  const overallGradeText = studentRecord?.overall_grade ?? (overallBand ? overallBand.grade : null);

  const { promotionClass, promotionStatus } = computePromotionStatus(
    studentData.term_name,
    scoredSubjects.length,
    overallAvg,
    promotionCutoff
  );

  const templateData = {
    school: {
      name:          school.name,
      logoUrl:       identityConfig.logo_url      ?? null,
      stampUrl:      identityConfig.stamp_url     ?? null,
      motto:         identityConfig.motto         ?? null,
      address:       identityConfig.address       ?? null,
      primaryColour: identityConfig.primary_colour ?? null,
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
      average:      scoredSubjects.length > 0 ? overallAvg.toFixed(2) : '—',
      grade:        overallGradeText ?? '—',
      gradeCss:     gradeCss(overallBand, gradingScale),
      // Same source and same fallback as grade above — a printed grade beside a blank
      // remark is an asymmetry someone loses an hour to later.
      remark:       studentRecord?.overall_remark ?? (overallBand ? overallBand.remark : null),
      position:     studentRecord?.position !== undefined ? ordinal(studentRecord.position) : '—',
      totalStudents: classResult.students.length,
    },
    classTeacherComment: classTeacherComment?.comment_text ?? null,
    formTeacher: formTeacher ? { name: formTeacher.full_name, signatureUrl: formTeacher.signature_url } : null,
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
      .from(REPORT_CARDS_BUCKET)
      .upload(storagePath, Buffer.from(pdfBuffer), {
        contentType: 'application/pdf',
        upsert:      true,
      });

    if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

    // Persist the storage path (not a public URL) — the bucket is private; a signed URL
    // is minted on demand at the point of serving this to a client.
    await upsertReportCard(studentId, termId, schoolId, storagePath);

    return storagePath;
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
      { name: 'Mathematics',      componentScores: ['9.00', '8.00', '65.00'], totalScore: '82.00', grade: 'A', position: '1st', classAverage: '68.5' },
      { name: 'English Language', componentScores: ['7.00', '8.00', '55.00'], totalScore: '70.00', grade: 'B', position: '3rd', classAverage: '60.2' },
      { name: 'Basic Science',    componentScores: ['8.00', '7.00', '50.00'], totalScore: '65.00', grade: 'B', position: '4th', classAverage: '58.0' },
    ],
    overall: {
      average:       '72.33',
      grade:         'B',
      position:      '2nd',
      totalStudents: 32,
    },
    classTeacherComment: 'A pleasure to teach. Keeps up consistent effort across all subjects.',
    formTeacher: { name: 'Sample Teacher', signatureUrl: null },
    principalRemark: 'A commendable result. Keep up the good work.',
    attendance: {
      daysPresent: 58,
      daysAbsent:  2,
      totalDays:   60,
      percentage:  '96.7%',
    },
    promotionClass:  'not-applicable',
    promotionStatus: 'Term Completed',
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
    name:          school.name,
    logoUrl:       identityConfig.logo_url      ?? null,
    stampUrl:      identityConfig.stamp_url     ?? null,
    motto:         identityConfig.motto         ?? null,
    address:       identityConfig.address       ?? null,
    primaryColour: identityConfig.primary_colour ?? null,
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
    setTimeout(() => jobs.delete(job.jobId), 5 * 60_000);
    return;
  }

  job.status    = job.failed === 0 ? 'done' : 'error';
  job.finishedAt = new Date();
  setTimeout(() => jobs.delete(job.jobId), 5 * 60_000);
}
