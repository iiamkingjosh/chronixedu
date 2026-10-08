import pool from '../db/client';

/**
 * What a school still has to set up, for the principal's checklist (audit, 8 Oct 2026).
 *
 * A new school has no grading scale, pass mark or assessment structure until its principal sets them
 * (doctrine 8), and nothing said so: each gap surfaced later as someone else's refusal (a teacher's
 * empty score sheet, a publish refused, a parent unable to pay). Every item names the page that
 * fills it. Read only; nothing here changes anything.
 */

export interface SetupItem {
  key: string;
  label: string;
  done: boolean;
  detail: string;
  href: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 2026-12-18 → 18 Dec 2026, from the date's own digits (no time zone can move it). */
export function formatDay(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Today's date in Africa/Lagos, YYYY-MM-DD (doctrine 12: user-facing dates are Lagos dates). */
export function lagosToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

interface Snapshot {
  academic_config: Record<string, unknown> | null;
  levels: string[] | null;
  has_session: boolean;
  term: { id: string; name: string; start_date: string; end_date: string } | null;
  classes: number;
  subjects: number;
  teachers: number;
  assignments: number;
  students_in_classes: number;
  assessment_configs: number;
  fee_lines: number;
  payout_status: string | null;
}

/** Levels left without a value for `field`: the level's own override, else the school-wide value. */
function levelsWithout(config: Record<string, unknown>, levels: string[], field: 'grading_scale' | 'promotion_cutoff'): string[] | null {
  const has = (v: unknown) => (field === 'grading_scale' ? Array.isArray(v) && v.length > 0 : typeof v === 'number');
  const schoolWide = has(config[field]);
  if (levels.length === 0) return schoolWide ? [] : null; // null: not set anywhere, and no classes yet
  const overrides = (config.level_overrides ?? {}) as Record<string, Record<string, unknown>>;
  return levels.filter(level => !schoolWide && !has(overrides[level]?.[field]));
}

export async function getSetupStatus(schoolId: string, today: string): Promise<SetupItem[]> {
  const { rows: [r] } = await pool.query<Snapshot>(
    `WITH cur_session AS (
       SELECT id FROM academic_sessions WHERE school_id = $1 AND is_current LIMIT 1
     ),
     cur_term AS (
       SELECT t.id, t.name, t.start_date::text AS start_date, t.end_date::text AS end_date
       FROM terms t WHERE t.school_id = $1 AND t.is_current AND t.session_id = (SELECT id FROM cur_session)
       LIMIT 1
     )
     SELECT
       (SELECT academic_config FROM school_settings WHERE school_id = $1) AS academic_config,
       (SELECT array_agg(DISTINCT level ORDER BY level) FROM classes WHERE school_id = $1) AS levels,
       EXISTS (SELECT 1 FROM cur_session) AS has_session,
       (SELECT row_to_json(ct) FROM cur_term ct) AS term,
       (SELECT count(*)::int FROM classes WHERE school_id = $1) AS classes,
       (SELECT count(*)::int FROM subjects WHERE school_id = $1) AS subjects,
       (SELECT count(*)::int FROM users WHERE school_id = $1 AND role = 'teacher' AND is_active) AS teachers,
       (SELECT count(*)::int FROM teacher_assignments WHERE school_id = $1 AND term_id = (SELECT id FROM cur_term)) AS assignments,
       (SELECT count(DISTINCT sc.student_id)::int
          FROM student_classes sc JOIN students s ON s.id = sc.student_id
         WHERE s.school_id = $1 AND sc.session_id = (SELECT id FROM cur_session)) AS students_in_classes,
       (SELECT count(*)::int FROM assessment_configs WHERE school_id = $1 AND term_id = (SELECT id FROM cur_term)) AS assessment_configs,
       (SELECT count(*)::int FROM fee_structures WHERE school_id = $1 AND term_id = (SELECT id FROM cur_term)) AS fee_lines,
       (SELECT payout_config->>'settlement_status' FROM schools WHERE id = $1) AS payout_status`,
    [schoolId]
  );

  const config = r.academic_config ?? {};
  const levels = r.levels ?? [];
  const items: SetupItem[] = [];

  // The calendar first: most other items are "for this term".
  const term = r.term;
  if (!r.has_session || !term) {
    items.push({ key: 'current_term', label: 'Current term', done: false, href: '/settings/academic-structure',
      detail: 'There is no current session and term. Add them, and make the term current.' });
  } else if (term.end_date < today) {
    items.push({ key: 'current_term', label: 'Current term', done: false, href: '/settings/academic-structure',
      detail: `${term.name} ended on ${formatDay(term.end_date)}. Add the next term and make it current, so attendance and scores go to it.` });
  } else {
    items.push({ key: 'current_term', label: 'Current term', done: true, href: '/settings/academic-structure',
      detail: `${term.name}, ${formatDay(term.start_date)} to ${formatDay(term.end_date)}.` });
  }

  const scaleGaps = levelsWithout(config, levels, 'grading_scale');
  items.push({ key: 'grading_scale', label: 'Grading scale', done: scaleGaps !== null && scaleGaps.length === 0, href: '/settings/grading-scale',
    detail: scaleGaps === null ? 'No grading scale is set, so results cannot be published.'
      : scaleGaps.length > 0 ? `No grading scale for: ${scaleGaps.join(', ')}. Results for those classes cannot be published.`
      : 'Set.' });

  const passGaps = levelsWithout(config, levels, 'promotion_cutoff');
  items.push({ key: 'pass_mark', label: 'Pass mark', done: passGaps !== null && passGaps.length === 0, href: '/settings/grading-scale',
    detail: passGaps === null ? 'No pass mark is set, so report cards cannot say who passed.'
      : passGaps.length > 0 ? `No pass mark for: ${passGaps.join(', ')}.`
      : 'Set.' });

  items.push({ key: 'assessment', label: 'Assessment for this term', done: r.assessment_configs > 0, href: '/settings/assessment-config',
    detail: !term ? 'Needs a current term first.'
      : r.assessment_configs > 0 ? `${term.name} has its assessment structure.`
      : `${term.name} has no assessment structure, so teachers cannot enter scores.` });

  items.push({ key: 'classes', label: 'Classes', done: r.classes > 0, href: '/settings/roster',
    detail: r.classes > 0 ? `${r.classes} class${r.classes === 1 ? '' : 'es'}.` : 'No classes yet.' });
  items.push({ key: 'subjects', label: 'Subjects', done: r.subjects > 0, href: '/settings/roster',
    detail: r.subjects > 0 ? `${r.subjects} subject${r.subjects === 1 ? '' : 's'}.` : 'No subjects yet.' });
  items.push({ key: 'teachers', label: 'Teachers', done: r.teachers > 0, href: '/settings/users',
    detail: r.teachers > 0 ? `${r.teachers} active teacher${r.teachers === 1 ? '' : 's'}.` : 'No teacher accounts yet.' });
  items.push({ key: 'teacher_assignments', label: 'Teaching assignments this term', done: r.assignments > 0, href: '/settings/roster',
    detail: r.assignments > 0 ? `${r.assignments} this term.` : 'No teacher is assigned to a class and subject this term, so nobody can enter scores.' });
  items.push({ key: 'students_in_classes', label: 'Students in classes', done: r.students_in_classes > 0, href: '/registrar/students',
    detail: r.students_in_classes > 0 ? `${r.students_in_classes} in a class this session.` : 'No student is in a class this session.' });
  items.push({ key: 'fee_lines', label: 'Fees for this term', done: r.fee_lines > 0, href: '/bursar/fee-structures',
    detail: r.fee_lines > 0 ? `${r.fee_lines} fee line${r.fee_lines === 1 ? '' : 's'} this term.` : 'No fee lines for this term, so no invoices can be raised. The bursar adds them under Fee Structures.' });
  items.push({ key: 'payout', label: 'Payout account', done: r.payout_status === 'active', href: '/settings/payout',
    detail: r.payout_status === 'active' ? 'Active.' : 'No active payout bank account, so parents cannot pay fees online.' });

  return items;
}
