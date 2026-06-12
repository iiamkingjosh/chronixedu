import pool from '../client';

export interface TimetableSlotRow {
  id: string;
  school_id: string;
  class_id: string;
  term_id: string;
  day_of_week: number;
  period_number: number;
  subject_id: string;
  teacher_id: string;
  created_at: string;
}

export interface TimetableSlotInput {
  class_id: string;
  term_id: string;
  day_of_week: number;
  period_number: number;
  subject_id: string;
  teacher_id: string;
}

export interface ExistingSlotDetail {
  id: string;
  class_id: string;
  class_name: string;
  subject_id: string;
  subject_name: string;
  teacher_id: string;
  teacher_name: string;
  day_of_week: number;
  period_number: number;
}

export interface ClassTimetableSlot {
  id: string;
  day_of_week: number;
  period_number: number;
  subject_id: string;
  subject_name: string;
  subject_code: string;
  teacher_id: string;
  teacher_name: string;
}

export interface TeacherTimetableSlot {
  id: string;
  day_of_week: number;
  period_number: number;
  class_id: string;
  class_name: string;
  subject_id: string;
  subject_name: string;
}

export async function insertSlot(schoolId: string, input: TimetableSlotInput): Promise<TimetableSlotRow> {
  const result = await pool.query<TimetableSlotRow>(
    `INSERT INTO timetable_slots (school_id, class_id, term_id, day_of_week, period_number, subject_id, teacher_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, school_id, class_id, term_id, day_of_week, period_number, subject_id, teacher_id, created_at`,
    [schoolId, input.class_id, input.term_id, input.day_of_week, input.period_number, input.subject_id, input.teacher_id]
  );
  return result.rows[0];
}

export async function findClassClash(
  schoolId: string,
  classId: string,
  termId: string,
  dayOfWeek: number,
  periodNumber: number
): Promise<ExistingSlotDetail | null> {
  const result = await pool.query<ExistingSlotDetail>(
    `SELECT ts.id, ts.class_id, c.name AS class_name, ts.subject_id, sub.name AS subject_name,
            ts.teacher_id, (u.first_name || ' ' || u.last_name) AS teacher_name,
            ts.day_of_week, ts.period_number
     FROM timetable_slots ts
     JOIN classes c   ON c.id = ts.class_id
     JOIN subjects sub ON sub.id = ts.subject_id
     JOIN users u    ON u.id = ts.teacher_id
     WHERE ts.school_id = $1 AND ts.class_id = $2 AND ts.term_id = $3
       AND ts.day_of_week = $4 AND ts.period_number = $5`,
    [schoolId, classId, termId, dayOfWeek, periodNumber]
  );
  return result.rows[0] ?? null;
}

export async function findTeacherClash(
  schoolId: string,
  teacherId: string,
  termId: string,
  dayOfWeek: number,
  periodNumber: number
): Promise<ExistingSlotDetail | null> {
  const result = await pool.query<ExistingSlotDetail>(
    `SELECT ts.id, ts.class_id, c.name AS class_name, ts.subject_id, sub.name AS subject_name,
            ts.teacher_id, (u.first_name || ' ' || u.last_name) AS teacher_name,
            ts.day_of_week, ts.period_number
     FROM timetable_slots ts
     JOIN classes c   ON c.id = ts.class_id
     JOIN subjects sub ON sub.id = ts.subject_id
     JOIN users u    ON u.id = ts.teacher_id
     WHERE ts.school_id = $1 AND ts.teacher_id = $2 AND ts.term_id = $3
       AND ts.day_of_week = $4 AND ts.period_number = $5`,
    [schoolId, teacherId, termId, dayOfWeek, periodNumber]
  );
  return result.rows[0] ?? null;
}

export async function getClassTimetable(schoolId: string, classId: string, termId: string): Promise<ClassTimetableSlot[]> {
  const result = await pool.query<ClassTimetableSlot>(
    `SELECT ts.id, ts.day_of_week, ts.period_number,
            ts.subject_id, sub.name AS subject_name, sub.code AS subject_code,
            ts.teacher_id, (u.first_name || ' ' || u.last_name) AS teacher_name
     FROM timetable_slots ts
     JOIN subjects sub ON sub.id = ts.subject_id
     JOIN users u      ON u.id = ts.teacher_id
     WHERE ts.school_id = $1 AND ts.class_id = $2 AND ts.term_id = $3
     ORDER BY ts.day_of_week, ts.period_number`,
    [schoolId, classId, termId]
  );
  return result.rows;
}

export async function getTeacherTimetable(schoolId: string, teacherId: string, termId: string): Promise<TeacherTimetableSlot[]> {
  const result = await pool.query<TeacherTimetableSlot>(
    `SELECT ts.id, ts.day_of_week, ts.period_number,
            ts.class_id, c.name AS class_name,
            ts.subject_id, sub.name AS subject_name
     FROM timetable_slots ts
     JOIN classes c    ON c.id = ts.class_id
     JOIN subjects sub ON sub.id = ts.subject_id
     WHERE ts.school_id = $1 AND ts.teacher_id = $2 AND ts.term_id = $3
     ORDER BY ts.day_of_week, ts.period_number`,
    [schoolId, teacherId, termId]
  );
  return result.rows;
}

export async function findSlotById(slotId: string, schoolId: string): Promise<TimetableSlotRow | null> {
  const result = await pool.query<TimetableSlotRow>(
    `SELECT id, school_id, class_id, term_id, day_of_week, period_number, subject_id, teacher_id, created_at
     FROM timetable_slots WHERE id = $1 AND school_id = $2`,
    [slotId, schoolId]
  );
  return result.rows[0] ?? null;
}

export async function deleteSlot(slotId: string, schoolId: string): Promise<void> {
  await pool.query(
    `DELETE FROM timetable_slots WHERE id = $1 AND school_id = $2`,
    [slotId, schoolId]
  );
}
