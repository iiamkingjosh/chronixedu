import path from 'path';
import fs from 'fs';
import Handlebars from 'handlebars';
import { supabaseAdmin } from '../supabaseClient';
import { findSchoolById } from '../db/queries/schools';
import { getStudentProfile } from '../db/queries/students';
import { listSessionsWithTerms } from '../db/queries/sessions';
import { computeClassResults } from './resultEngine';
import type { ClassResult } from './resultEngine';
import { getBrowser, ordinal, gradeClass, lookupGrade, buildSubjectPositions } from './reportCardService';

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

export async function generateTranscript(studentId: string, schoolId: string): Promise<string> {
  const [profile, school, sessions] = await Promise.all([
    getStudentProfile(studentId, schoolId),
    findSchoolById(schoolId),
    listSessionsWithTerms(schoolId),
  ]);

  if (!profile) throw new Error(`Student not found: ${studentId}`);
  if (!school)  throw new Error(`School not found: ${schoolId}`);

  const identityConfig = (school.identity_config ?? {}) as Record<string, string | null>;
  const academicConfig = (school.academic_config ?? {}) as Record<string, unknown>;

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

  const today = new Date();

  const sessionsData: Array<{
    sessionName: string;
    className: string;
    classLevel: string;
    terms: Array<{
      termName: string;
      subjects: Array<{ name: string; totalScore: string; grade: string; position: string; classAverage: string }>;
      overall: { average: string; grade: string; position: string };
    }>;
  }> = [];

  for (const enrollment of profile.enrollments) {
    const session = sessions.find(s => s.id === enrollment.session_id);
    if (!session) continue;

    const terms = session.terms
      .filter(t => new Date(t.start_date) <= today)
      .sort((a, b) => a.start_date.localeCompare(b.start_date));

    const termRows: typeof sessionsData[number]['terms'] = [];

    for (const term of terms) {
      let classResult: ClassResult;
      try {
        classResult = await computeClassResults(enrollment.class_id, term.id, schoolId);
      } catch {
        continue;
      }

      const studentRecord = classResult.students.find(s => s.student_id === studentId);
      if (!studentRecord) continue;

      const scoredSubjects = studentRecord.subjects.filter(s => s.result !== null);
      if (scoredSubjects.length === 0) continue;

      const subjectPositions = buildSubjectPositions(classResult);

      const subjectRows = studentRecord.subjects.map(sub => {
        const totalScore = sub.result ? sub.result.total_score.toFixed(2) : '—';
        const grade      = sub.result ? lookupGrade(sub.result.total_score, gradingScale) : '—';
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
          grade:        gradeClass(grade),
          position,
          classAverage,
        };
      });

      const overallAvg = scoredSubjects.reduce((sum, s) => sum + (s.result?.total_score ?? 0), 0) / scoredSubjects.length;
      const overallGrade = lookupGrade(overallAvg, gradingScale);

      termRows.push({
        termName: term.name,
        subjects: subjectRows,
        overall: {
          average:  overallAvg.toFixed(2),
          grade:    gradeClass(overallGrade),
          position: ordinal(studentRecord.position),
        },
      });
    }

    if (termRows.length === 0) continue;

    sessionsData.push({
      sessionName: enrollment.session_name,
      className:   enrollment.class_name,
      classLevel:  enrollment.class_level,
      terms:       termRows,
    });
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
      fullName:    `${profile.first_name} ${profile.last_name}`,
      admissionNo: profile.admission_no,
      photoUrl:    profile.photo_url,
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
    await page.setContent(html, { waitUntil: 'load', timeout: 15_000 });
    const pdfBuffer = await page.pdf({
      format:          'a4',
      printBackground: true,
      margin:          { top: '5mm', bottom: '5mm', left: '0', right: '0' },
    });

    const storagePath = `transcripts/${schoolId}/${studentId}.pdf`;
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

    return publicUrl;
  } finally {
    await page.close();
  }
}
