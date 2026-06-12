/**
 * Result computation service — reads only, never writes to the database.
 * All three public functions compute on demand from current score data.
 */

import pool from '../db/client';
import { resolveAssessmentConfig } from '../db/queries/assessmentConfig';

// ── Domain types ───────────────────────────────────────────────────────────────

interface GradeBand {
  grade: string;
  min: number;
  max: number;
  label: string;
  remark: string;
}

interface AcademicConfig {
  grading_scale: GradeBand[];
  promotion_cutoff: number;
}

export interface ComponentScore {
  component_id: string;
  name: string;
  max_score: number;
  weight_percent: number;
  score: number | null;
  contribution: number; // score / max_score * weight_percent, or 0 if no score
}

export interface StudentSubjectResult {
  total_score: number;
  grade: string;
  remark: string;
  components: ComponentScore[];
}

export interface SubjectResult {
  subject_id: string;
  subject_name: string;
  subject_code: string;
  result: StudentSubjectResult | null; // null = no scores entered for this subject
}

export interface StudentClassResult {
  student_id: string;
  admission_no: string;
  first_name: string;
  last_name: string;
  subjects: SubjectResult[];
  overall_average: number;  // mean of scored subject totals; 0 if none scored
  subjects_scored: number;
  position: number;         // standard competition ranking — ties share same position
}

export interface ClassResult {
  class_id: string;
  class_name: string;
  term_id: string;
  term_name: string;
  students: StudentClassResult[];
  subject_averages: Record<string, { subject_name: string; average: number }>;
  total_students: number;
}

export interface AtRiskStudent {
  student_id: string;
  admission_no: string;
  first_name: string;
  last_name: string;
  class_id: string;
  class_name: string;
  overall_average: number;
  promotion_cutoff: number;
  deficit: number; // promotion_cutoff − overall_average
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

function lookupGrade(score: number, scale: GradeBand[]): GradeBand | null {
  return scale.find(b => score >= b.min && score <= b.max) ?? null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Standard competition ranking: ties share the same position.
 * The next unique position number equals the count of students ranked above + 1.
 * e.g. scores [85, 85, 72, 65] → positions [1, 1, 3, 4]
 */
function assignPositions(
  students: StudentClassResult[]
): StudentClassResult[] {
  const sorted = [...students].sort((a, b) => b.overall_average - a.overall_average);
  let position = 1;
  return sorted.map((s, i) => {
    if (i > 0 && s.overall_average < sorted[i - 1].overall_average) {
      position = i + 1;
    }
    return { ...s, position };
  });
}

function buildComponentScores(
  configComponents: Array<{ id: string; name: string; max_score: number; weight_percent: number }>,
  scoreMap: Map<string, number>
): { components: ComponentScore[]; total: number; hasAny: boolean } {
  let total = 0;
  let hasAny = false;

  const components: ComponentScore[] = configComponents.map(comp => {
    const score = scoreMap.get(comp.id) ?? null;
    const contribution = score !== null
      ? (score / Number(comp.max_score)) * Number(comp.weight_percent)
      : 0;
    if (score !== null) hasAny = true;
    total += contribution;
    return {
      component_id: comp.id,
      name: comp.name,
      max_score: Number(comp.max_score),
      weight_percent: Number(comp.weight_percent),
      score,
      contribution: round2(contribution),
    };
  });

  return { components, total: round2(Math.min(total, 100)), hasAny };
}

// ── DB helpers (private) ────────────────────────────────────────────────────────

async function fetchAcademicConfig(schoolId: string): Promise<AcademicConfig> {
  const result = await pool.query<{ academic_config: AcademicConfig }>(
    `SELECT academic_config FROM school_settings WHERE school_id = $1`,
    [schoolId]
  );
  const cfg = result.rows[0]?.academic_config as AcademicConfig | undefined;
  return {
    grading_scale:    cfg?.grading_scale    ?? [],
    promotion_cutoff: cfg?.promotion_cutoff ?? 40,
  };
}

export async function getStudentClassId(studentId: string, termId: string): Promise<string | null> {
  const result = await pool.query<{ class_id: string }>(
    `SELECT sc.class_id
     FROM student_classes sc
     JOIN terms t ON t.session_id = sc.session_id
     WHERE sc.student_id = $1 AND t.id = $2`,
    [studentId, termId]
  );
  return result.rows[0]?.class_id ?? null;
}

// ── (1) computeStudentSubjectResult ────────────────────────────────────────────

export async function computeStudentSubjectResult(
  studentId: string,
  subjectId: string,
  termId: string,
  schoolId: string
): Promise<StudentSubjectResult | null> {
  const classId = await getStudentClassId(studentId, termId);
  if (!classId) return null;

  const [config, academicConfig, scoresResult] = await Promise.all([
    resolveAssessmentConfig(schoolId, classId, subjectId, termId),
    fetchAcademicConfig(schoolId),
    pool.query<{ component_id: string; score: string }>(
      `SELECT component_id, score::text
       FROM scores
       WHERE student_id = $1 AND subject_id = $2 AND term_id = $3`,
      [studentId, subjectId, termId]
    ),
  ]);

  if (!config || config.components.length === 0) return null;

  const scoreMap = new Map<string, number>(
    scoresResult.rows.map(r => [r.component_id, parseFloat(r.score)])
  );

  const { components, total, hasAny } = buildComponentScores(config.components, scoreMap);
  if (!hasAny) return null;

  const band = lookupGrade(total, academicConfig.grading_scale);

  return {
    total_score: total,
    grade:  band?.grade  ?? 'N/A',
    remark: band?.remark ?? '',
    components,
  };
}

// ── (2) computeClassResults ────────────────────────────────────────────────────

export async function computeClassResults(
  classId: string,
  termId: string,
  schoolId: string
): Promise<ClassResult> {
  // Fetch supporting data in parallel
  const [classRow, termRow, studentsResult, subjectsResult, academicConfig] = await Promise.all([
    pool.query<{ name: string }>(
      `SELECT name FROM classes WHERE id = $1 AND school_id = $2`,
      [classId, schoolId]
    ),
    pool.query<{ name: string; session_id: string }>(
      `SELECT name, session_id FROM terms WHERE id = $1 AND school_id = $2`,
      [termId, schoolId]
    ),
    pool.query<{ student_id: string; admission_no: string; first_name: string; last_name: string }>(
      `SELECT s.id AS student_id, s.admission_no, u.first_name, u.last_name
       FROM student_classes sc
       JOIN students s ON s.id = sc.student_id
       JOIN users   u ON u.id  = s.user_id
       WHERE sc.class_id   = $1
         AND sc.session_id = (SELECT session_id FROM terms WHERE id = $2)
       ORDER BY u.last_name, u.first_name`,
      [classId, termId]
    ),
    pool.query<{ id: string; name: string; code: string }>(
      `SELECT DISTINCT sub.id, sub.name, sub.code
       FROM teacher_assignments ta
       JOIN subjects sub ON sub.id = ta.subject_id
       WHERE ta.class_id = $1 AND ta.term_id = $2 AND ta.school_id = $3
       ORDER BY sub.name`,
      [classId, termId, schoolId]
    ),
    fetchAcademicConfig(schoolId),
  ]);

  const cls      = classRow.rows[0];
  const term     = termRow.rows[0];
  const students = studentsResult.rows;
  const subjects = subjectsResult.rows;

  const empty: ClassResult = {
    class_id: classId, class_name: cls?.name ?? '',
    term_id: termId,   term_name:  term?.name ?? '',
    students: [], subject_averages: {}, total_students: 0,
  };
  if (!cls || !term || students.length === 0) return empty;

  const studentIds = students.map(s => s.student_id);

  // Resolve configs per subject in parallel — typically 5–15 subjects
  const configEntries = await Promise.all(
    subjects.map(async sub => {
      const cfg = await resolveAssessmentConfig(schoolId, classId, sub.id, termId);
      return [sub.id, cfg] as const;
    })
  );
  const configsBySubject = new Map(configEntries);

  // Single query for ALL scores for ALL students in this class this term
  const allScoresResult = await pool.query<{
    student_id: string; subject_id: string; component_id: string; score: string;
  }>(
    `SELECT student_id, subject_id, component_id, score::text
     FROM scores
     WHERE student_id = ANY($1::uuid[]) AND term_id = $2`,
    [studentIds, termId]
  );

  // Build 3-level index: student_id → subject_id → component_id → score
  const scoreIndex = new Map<string, Map<string, Map<string, number>>>();
  for (const row of allScoresResult.rows) {
    if (!scoreIndex.has(row.student_id)) scoreIndex.set(row.student_id, new Map());
    const bySub = scoreIndex.get(row.student_id)!;
    if (!bySub.has(row.subject_id)) bySub.set(row.subject_id, new Map());
    bySub.get(row.subject_id)!.set(row.component_id, parseFloat(row.score));
  }

  // Compute subject results per student entirely in memory
  const studentResults: StudentClassResult[] = students.map(student => {
    let totalOverall = 0;
    let scoredCount  = 0;

    const subjectResults: SubjectResult[] = subjects.map(sub => {
      const config     = configsBySubject.get(sub.id);
      const compIds    = config?.components ?? [];
      const scoreMap   = scoreIndex.get(student.student_id)?.get(sub.id) ?? new Map();

      if (!config || compIds.length === 0) {
        return { subject_id: sub.id, subject_name: sub.name, subject_code: sub.code, result: null };
      }

      const { components, total, hasAny } = buildComponentScores(compIds, scoreMap);
      if (!hasAny) {
        return { subject_id: sub.id, subject_name: sub.name, subject_code: sub.code, result: null };
      }

      const band = lookupGrade(total, academicConfig.grading_scale);
      totalOverall += total;
      scoredCount++;

      return {
        subject_id: sub.id, subject_name: sub.name, subject_code: sub.code,
        result: {
          total_score: total,
          grade:  band?.grade  ?? 'N/A',
          remark: band?.remark ?? '',
          components,
        },
      };
    });

    return {
      student_id:      student.student_id,
      admission_no:    student.admission_no,
      first_name:      student.first_name,
      last_name:       student.last_name,
      subjects:        subjectResults,
      overall_average: scoredCount > 0 ? round2(totalOverall / scoredCount) : 0,
      subjects_scored: scoredCount,
      position:        0, // filled by assignPositions below
    };
  });

  // Class average per subject (only students who have scores for that subject)
  const subject_averages: Record<string, { subject_name: string; average: number }> = {};
  for (const sub of subjects) {
    const scored = studentResults
      .map(s => s.subjects.find(sr => sr.subject_id === sub.id)?.result?.total_score)
      .filter((v): v is number => v !== undefined);
    subject_averages[sub.id] = {
      subject_name: sub.name,
      average: scored.length > 0 ? round2(scored.reduce((a, b) => a + b, 0) / scored.length) : 0,
    };
  }

  return {
    class_id:    classId,
    class_name:  cls.name,
    term_id:     termId,
    term_name:   term.name,
    students:    assignPositions(studentResults),
    subject_averages,
    total_students: students.length,
  };
}

// ── (3) getStudentsAtRisk ──────────────────────────────────────────────────────

export async function getStudentsAtRisk(
  termId: string,
  schoolId: string
): Promise<AtRiskStudent[]> {
  const academicConfig = await fetchAcademicConfig(schoolId);
  const { promotion_cutoff } = academicConfig;

  // All classes that have students enrolled for this term's session
  const classesResult = await pool.query<{ class_id: string; class_name: string }>(
    `SELECT DISTINCT sc.class_id, c.name AS class_name
     FROM student_classes sc
     JOIN classes c ON c.id = sc.class_id
     JOIN terms   t ON t.session_id = sc.session_id
     WHERE t.id = $1
       AND sc.student_id IN (SELECT id FROM students WHERE school_id = $2)
     ORDER BY c.name`,
    [termId, schoolId]
  );

  const atRisk: AtRiskStudent[] = [];

  for (const { class_id, class_name } of classesResult.rows) {
    const result = await computeClassResults(class_id, termId, schoolId);
    for (const student of result.students) {
      if (student.subjects_scored > 0 && student.overall_average < promotion_cutoff) {
        atRisk.push({
          student_id:      student.student_id,
          admission_no:    student.admission_no,
          first_name:      student.first_name,
          last_name:       student.last_name,
          class_id,
          class_name,
          overall_average: student.overall_average,
          promotion_cutoff,
          deficit:         round2(promotion_cutoff - student.overall_average),
        });
      }
    }
  }

  // Sort ascending by average — most at-risk first
  return atRisk.sort((a, b) => a.overall_average - b.overall_average);
}
