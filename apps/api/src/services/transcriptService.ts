import path from 'path';
import fs from 'fs';
import Handlebars from 'handlebars';
import { supabaseAdmin } from '../supabaseClient';
import { findSchoolById } from '../db/queries/schools';
import { getStudentProfile } from '../db/queries/students';
import { listSessionsWithTerms } from '../db/queries/sessions';
import pool from '../db/client';
import { computeClassResults, resolveGradingScale } from './resultEngine';
import { getBrowser, ordinal, gradeCss, buildSubjectPositions, REPORT_CARDS_BUCKET } from './reportCardService';
import { lookupGrade } from './resultEngine';
import type { GradeBand } from './resultEngine';
import { assetDataUri, refuseNetwork } from './schoolAssets';

// ── Template compilation (lazy, once) ─────────────────────────────────────────

type CompiledTemplate = ReturnType<typeof Handlebars.compile>;

let compiledTemplate: CompiledTemplate | null = null;

function getTemplate(): CompiledTemplate {
  if (!compiledTemplate) {
    const tplPath = path.join(__dirname, '../templates/transcript.hbs');
    const source = fs.readFileSync(tplPath, 'utf-8');
    compiledTemplate = Handlebars.compile(source);
  }
  return compiledTemplate;
}

// ── Core PDF generator ─────────────────────────────────────────────────────────

export interface TranscriptTerm {
  termName: string;
  subjects: Array<{ name: string; totalScore: string; grade: string; gradeCss: string; position: string; classAverage: string }>;
  overall: { average: string; grade: string; gradeCss: string; position: string };
}

export interface TranscriptSession {
  sessionName: string;
  className: string;
  classLevel: string;
  terms: TranscriptTerm[];
}

/**
 * What a transcript shows: each session the student was enrolled in, and each term of it whose
 * results are PUBLISHED for this student (doctrine 5). A transcript is the document a student
 * takes to another school, and it took every term with scores, unpublished marks included (audit,
 * 8 Oct 2026). Grades come from the class's own scale (its level's, else the school's), as the
 * report card's do, and the overall average and grade are the engine's, not a third derivation.
 * A published term whose results cannot be computed fails the transcript rather than vanishing
 * from it.
 */
export async function transcriptSessions(studentId: string, schoolId: string, today: Date = new Date()): Promise<TranscriptSession[]> {
  const [profile, sessions, published] = await Promise.all([
    getStudentProfile(studentId, schoolId),
    listSessionsWithTerms(schoolId),
    pool.query<{ term_id: string }>(
      `SELECT term_id FROM result_status WHERE student_id = $1 AND school_id = $2 AND status = 'published'`,
      [studentId, schoolId]),
  ]);
  if (!profile) throw new Error(`Student not found: ${studentId}`);
  const publishedTerms = new Set(published.rows.map(r => r.term_id));

  const out: TranscriptSession[] = [];
  for (const enrollment of profile.enrollments) {
    const session = sessions.find(s => s.id === enrollment.session_id);
    if (!session) continue;

    const terms = session.terms
      .filter(t => new Date(t.start_date) <= today && publishedTerms.has(t.id))
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
    if (terms.length === 0) continue;

    // No fallback: an empty scale yields no grade rather than a wrong one.
    const gradingScale: GradeBand[] = await resolveGradingScale(schoolId, enrollment.class_id);
    const termRows: TranscriptTerm[] = [];

    for (const term of terms) {
      const classResult = await computeClassResults(enrollment.class_id, term.id, schoolId);
      const studentRecord = classResult.students.find(s => s.student_id === studentId);
      if (!studentRecord) continue;

      const scoredSubjects = studentRecord.subjects.filter(s => s.result !== null);
      if (scoredSubjects.length === 0) continue;

      const subjectPositions = buildSubjectPositions(classResult);

      const subjectRows = studentRecord.subjects.map(sub => {
        const totalScore = sub.result ? sub.result.total_score.toFixed(2) : '—';
        const band       = sub.result ? lookupGrade(sub.result.total_score, gradingScale) : null;
        const grade      = band ? band.grade : '—';
        const posMap     = subjectPositions.get(sub.subject_id);
        const posNum     = posMap?.get(studentId);
        const position   = posNum !== undefined ? ordinal(posNum) : '—';

        let classTotal = 0;
        let classCount = 0;
        for (const s of classResult.students) {
          const r = s.subjects.find(x => x.subject_id === sub.subject_id)?.result;
          if (r) { classTotal += r.total_score; classCount++; }
        }
        const classAverage = classCount > 0 ? (classTotal / classCount).toFixed(1) : '—';

        return {
          name:         sub.subject_name,
          totalScore,
          grade,
          gradeCss:     gradeCss(band, gradingScale),
          position,
          classAverage,
        };
      });

      const overallAvg = studentRecord.overall_average ?? 0;
      const overallBand = lookupGrade(overallAvg, gradingScale);

      termRows.push({
        termName: term.name,
        subjects: subjectRows,
        overall: {
          average:  overallAvg.toFixed(2),
          grade:    studentRecord.overall_grade ?? (overallBand ? overallBand.grade : '—'),
          gradeCss: gradeCss(overallBand, gradingScale),
          position: ordinal(studentRecord.position),
        },
      });
    }

    if (termRows.length === 0) continue;
    out.push({
      sessionName: enrollment.session_name,
      className:   enrollment.class_name,
      classLevel:  enrollment.class_level,
      terms:       termRows,
    });
  }
  return out;
}

/**
 * Renders a student's transcript PDF and stores it. Returns the storage path (not a URL) —
 * the object lives in a private bucket, so callers must mint a signed URL via
 * `signReportCardAsset` at the point of serving it to a client.
 */
export async function generateTranscript(studentId: string, schoolId: string): Promise<string> {
  const [profile, school, sessionsData] = await Promise.all([
    getStudentProfile(studentId, schoolId),
    findSchoolById(schoolId),
    transcriptSessions(studentId, schoolId),
  ]);

  if (!profile) throw new Error(`Student not found: ${studentId}`);
  if (!school)  throw new Error(`School not found: ${schoolId}`);

  const identityConfig = (school.identity_config ?? {}) as Record<string, string | null>;

  // The images go inside the page, read from the private bucket; the renderer fetches nothing.
  const [logoImage, stampImage, photoImage] = await Promise.all([
    assetDataUri(identityConfig.logo_url),
    assetDataUri(identityConfig.stamp_url),
    assetDataUri(profile.photo_url),
  ]);

  const templateData = {
    school: {
      name:     school.name,
      logoUrl:  logoImage,
      stampUrl: stampImage,
      motto:    identityConfig.motto      ?? null,
      address:  identityConfig.address    ?? null,
    },
    student: {
      fullName:    `${profile.first_name} ${profile.last_name}`,
      admissionNo: profile.admission_no,
      photoUrl:    photoImage,
      dob:         profile.dob,
      gender:      profile.gender,
    },
    sessions: sessionsData,
    generatedAt: new Date().toLocaleDateString('en-GB', {
      day: '2-digit', month: 'long', year: 'numeric',
    }),
  };

  const html = getTemplate()(templateData);

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await refuseNetwork(page);
    await page.setContent(html, { waitUntil: 'load', timeout: 15_000 });
    const pdfBuffer = await page.pdf({
      format:          'a4',
      printBackground: true,
      margin:          { top: '5mm', bottom: '5mm', left: '0', right: '0' },
    });

    const storagePath = `transcripts/${schoolId}/${studentId}.pdf`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from(REPORT_CARDS_BUCKET)
      .upload(storagePath, Buffer.from(pdfBuffer), {
        contentType: 'application/pdf',
        upsert:      true,
      });

    if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

    return storagePath;
  } finally {
    await page.close();
  }
}
