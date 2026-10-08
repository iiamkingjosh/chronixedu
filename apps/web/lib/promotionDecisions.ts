/**
 * The Promotion Manager's decisions (audit, 8 Oct 2026).
 *
 * Every student used to start ticked "Promoted", with the class they were already in as their "new
 * class", so a run without changes promoted each child into the same class. Now nobody is decided
 * until someone decides: a student with no decision is left out of the run, "Repeats" keeps the
 * current class unless another is chosen, and "Promoted" needs the class they move up to.
 */

export type PromotionChoice = 'promoted' | 'repeat' | null;

export interface PromotionRowState {
  decision: PromotionChoice;
  classId: string;
}

export interface PromotionStudent {
  id: string;
  first_name: string;
  last_name: string;
  class_id: string | null;
}

export interface PromotionPayload {
  decisions: Array<{ student_id: string; class_id: string; decision: 'promoted' | 'repeat' }>;
  /** Readable problems that stop the run; empty when it can go. */
  problems: string[];
  /** How many students have no decision and are left out. */
  undecided: number;
}

export function buildPromotionPayload(students: PromotionStudent[], rows: Record<string, PromotionRowState | undefined>): PromotionPayload {
  const decisions: PromotionPayload['decisions'] = [];
  const problems: string[] = [];
  let undecided = 0;
  for (const s of students) {
    const row = rows[s.id];
    const name = `${s.first_name} ${s.last_name}`;
    if (!row?.decision) { undecided++; continue; }
    if (row.decision === 'promoted') {
      if (!row.classId) { problems.push(`Choose the class ${name} moves up to.`); continue; }
      if (row.classId === s.class_id) {
        problems.push(`${name} is marked promoted into the class they are already in. Choose the class they move up to, or mark them as repeating.`);
        continue;
      }
      decisions.push({ student_id: s.id, class_id: row.classId, decision: 'promoted' });
    } else {
      const classId = row.classId || s.class_id || '';
      if (!classId) { problems.push(`Choose the class ${name} repeats in.`); continue; }
      decisions.push({ student_id: s.id, class_id: classId, decision: 'repeat' });
    }
  }
  if (decisions.length === 0 && problems.length === 0) {
    problems.push('No student has a decision yet. Mark each student as promoted or repeating.');
  }
  return { decisions, problems, undecided };
}
