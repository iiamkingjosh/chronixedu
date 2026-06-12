import pool from '../db/client';
import {
  insertSlot,
  findClassClash,
  findTeacherClash,
  getClassTimetable,
  getTeacherTimetable,
  findSlotById,
  deleteSlot,
} from '../db/queries/timetable';

jest.mock('../db/client', () => ({
  __esModule: true,
  default: { query: jest.fn(), connect: jest.fn() },
}));

const mockQuery = (pool as unknown as { query: jest.Mock }).query;

beforeEach(() => jest.clearAllMocks());

const SCHOOL_ID = 'school-1';
const CLASS_ID = 'class-1';
const TERM_ID = 'term-1';
const SUBJECT_ID = 'subject-1';
const TEACHER_ID = 'teacher-1';

describe('insertSlot', () => {
  it('inserts a timetable slot and returns it', async () => {
    const row = {
      id: 'slot-1',
      school_id: SCHOOL_ID,
      class_id: CLASS_ID,
      term_id: TERM_ID,
      day_of_week: 1,
      period_number: 2,
      subject_id: SUBJECT_ID,
      teacher_id: TEACHER_ID,
      created_at: '2026-06-12T00:00:00.000Z',
    };
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const result = await insertSlot(SCHOOL_ID, {
      class_id: CLASS_ID,
      term_id: TERM_ID,
      day_of_week: 1,
      period_number: 2,
      subject_id: SUBJECT_ID,
      teacher_id: TEACHER_ID,
    });

    expect(result).toEqual(row);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO timetable_slots'),
      [SCHOOL_ID, CLASS_ID, TERM_ID, 1, 2, SUBJECT_ID, TEACHER_ID]
    );
  });
});

describe('findClassClash', () => {
  it('returns null when the class has no slot at that day/period', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await findClassClash(SCHOOL_ID, CLASS_ID, TERM_ID, 1, 2);

    expect(result).toBeNull();
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('ts.class_id = $2'),
      [SCHOOL_ID, CLASS_ID, TERM_ID, 1, 2]
    );
  });

  it('returns the existing slot detail when the class already has a subject at that day/period', async () => {
    const row = {
      id: 'slot-existing',
      class_id: CLASS_ID,
      class_name: 'JSS1A',
      subject_id: 'subject-2',
      subject_name: 'English',
      teacher_id: 'teacher-2',
      teacher_name: 'Mrs. Adeyemi',
      day_of_week: 1,
      period_number: 2,
    };
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const result = await findClassClash(SCHOOL_ID, CLASS_ID, TERM_ID, 1, 2);

    expect(result).toEqual(row);
  });
});

describe('findTeacherClash', () => {
  it('returns null when the teacher has no slot at that day/period', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await findTeacherClash(SCHOOL_ID, TEACHER_ID, TERM_ID, 1, 2);

    expect(result).toBeNull();
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('ts.teacher_id = $2'),
      [SCHOOL_ID, TEACHER_ID, TERM_ID, 1, 2]
    );
  });

  it('returns the existing slot detail when the teacher is already booked at that day/period', async () => {
    const row = {
      id: 'slot-existing',
      class_id: 'class-2',
      class_name: 'JSS1B',
      subject_id: SUBJECT_ID,
      subject_name: 'Mathematics',
      teacher_id: TEACHER_ID,
      teacher_name: 'Mr. Okafor',
      day_of_week: 1,
      period_number: 2,
    };
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const result = await findTeacherClash(SCHOOL_ID, TEACHER_ID, TERM_ID, 1, 2);

    expect(result).toEqual(row);
  });
});

describe('getClassTimetable', () => {
  it('returns the class timetable ordered by day and period', async () => {
    const rows = [
      { id: 'slot-1', day_of_week: 1, period_number: 1, subject_id: SUBJECT_ID, subject_name: 'Mathematics', subject_code: 'MTH', teacher_id: TEACHER_ID, teacher_name: 'Mr. Okafor' },
    ];
    mockQuery.mockResolvedValueOnce({ rows });

    const result = await getClassTimetable(SCHOOL_ID, CLASS_ID, TERM_ID);

    expect(result).toEqual(rows);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY ts.day_of_week, ts.period_number'),
      [SCHOOL_ID, CLASS_ID, TERM_ID]
    );
  });
});

describe('getTeacherTimetable', () => {
  it('returns the teacher timetable ordered by day and period', async () => {
    const rows = [
      { id: 'slot-1', day_of_week: 1, period_number: 1, class_id: CLASS_ID, class_name: 'JSS1A', subject_id: SUBJECT_ID, subject_name: 'Mathematics' },
    ];
    mockQuery.mockResolvedValueOnce({ rows });

    const result = await getTeacherTimetable(SCHOOL_ID, TEACHER_ID, TERM_ID);

    expect(result).toEqual(rows);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY ts.day_of_week, ts.period_number'),
      [SCHOOL_ID, TEACHER_ID, TERM_ID]
    );
  });
});

describe('findSlotById', () => {
  it('returns the slot when found', async () => {
    const row = { id: 'slot-1', school_id: SCHOOL_ID, class_id: CLASS_ID, term_id: TERM_ID, day_of_week: 1, period_number: 1, subject_id: SUBJECT_ID, teacher_id: TEACHER_ID, created_at: '2026-06-12T00:00:00.000Z' };
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const result = await findSlotById('slot-1', SCHOOL_ID);

    expect(result).toEqual(row);
  });

  it('returns null when not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await findSlotById('missing', SCHOOL_ID);

    expect(result).toBeNull();
  });
});

describe('deleteSlot', () => {
  it('deletes the slot scoped to the school', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await deleteSlot('slot-1', SCHOOL_ID);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM timetable_slots'),
      ['slot-1', SCHOOL_ID]
    );
  });
});
