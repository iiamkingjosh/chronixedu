import puppeteer from 'puppeteer';
import {
  applyReportConfig,
  getTemplate,
  generateReportCard,
  generateReportCardPreview,
  computePromotionStatus,
} from '../services/reportCardService';
import { findSchoolById } from '../db/queries/schools';
import type { SchoolWithSettings } from '../db/queries/schools';
import {
  fetchStudentReportData,
  fetchClassTeacherComment,
  fetchFormTeacher,
  fetchPrincipalRemark,
  upsertReportCard,
} from '../db/queries/reportCards';
import type { ClassResult } from '../services/resultEngine';

jest.mock('../db/queries/schools');
jest.mock('../db/queries/reportCards', () => ({
  fetchStudentReportData: jest.fn(),
  fetchClassTeacherComment: jest.fn(),
  fetchFormTeacher: jest.fn(),
  fetchPrincipalRemark: jest.fn(),
  upsertReportCard: jest.fn(),
}));
jest.mock('../services/resultEngine', () => ({
  computeClassResults: jest.fn(),
}));
jest.mock('../supabaseClient', () => ({
  supabaseAdmin: {
    storage: {
      from: jest.fn(() => ({
        upload: jest.fn().mockResolvedValue({ error: null }),
        getPublicUrl: jest.fn().mockReturnValue({ data: { publicUrl: 'https://example.com/report-card.pdf' } }),
      })),
    },
  },
  supabase: {},
}));

jest.mock('puppeteer', () => {
  const page = {
    setContent: jest.fn().mockResolvedValue(undefined),
    pdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const browser = {
    isConnected: () => true,
    newPage: jest.fn().mockResolvedValue(page),
    close: jest.fn(),
  };
  return {
    launch: jest.fn().mockResolvedValue(browser),
    __mockPage: page,
    __mockBrowser: browser,
  };
});

const mockPuppeteer = puppeteer as unknown as {
  launch: jest.Mock;
  __mockPage: { setContent: jest.Mock; pdf: jest.Mock };
};

const mockFindSchoolById = findSchoolById as jest.Mock;
const mockFetchStudentReportData = fetchStudentReportData as jest.Mock;
const mockFetchClassTeacherComment = fetchClassTeacherComment as jest.Mock;
const mockFetchFormTeacher = fetchFormTeacher as jest.Mock;
const mockFetchPrincipalRemark = fetchPrincipalRemark as jest.Mock;
const mockUpsertReportCard = upsertReportCard as jest.Mock;

beforeEach(() => jest.clearAllMocks());

function baseTemplateData() {
  return {
    school: { name: 'Test School', logoUrl: null, stampUrl: null, motto: null, address: null },
    term: { name: 'First Term', sessionName: '2025/2026', nextTermResumption: '2026-04-20' },
  };
}

describe('applyReportConfig', () => {
  it('defaults showAttendance to true and remarkFlex to 2 when report_config is empty', () => {
    const data = applyReportConfig(baseTemplateData(), {}, null);
    expect(data.showAttendance).toBe(true);
    expect(data.remarkFlex).toBe(2);
  });

  it('hides attendance and widens the remark box when show_attendance is false', () => {
    const data = applyReportConfig(baseTemplateData(), { show_attendance: false }, null);
    expect(data.showAttendance).toBe(false);
    expect(data.remarkFlex).toBe(3);
  });

  it('sets footerText from footer_text', () => {
    const data = applyReportConfig(baseTemplateData(), { footer_text: 'Issued by Test School' }, null);
    expect(data.footerText).toBe('Issued by Test School');
  });

  it('leaves footerText null when footer_text is absent', () => {
    const data = applyReportConfig(baseTemplateData(), {}, null);
    expect(data.footerText).toBeNull();
  });

  it('sets school.signatureUrl from the supplied signature URL', () => {
    const data = applyReportConfig(baseTemplateData(), {}, 'https://example.com/sig.png');
    expect((data.school as Record<string, unknown>).signatureUrl).toBe('https://example.com/sig.png');
  });

  it('overrides term.nextTermResumption when next_term_resumption is set', () => {
    const data = applyReportConfig(baseTemplateData(), { next_term_resumption: '2026-09-08' }, null);
    expect((data.term as Record<string, unknown>).nextTermResumption).toBe('2026-09-08');
  });

  it('keeps the computed term.nextTermResumption when no override is set', () => {
    const data = applyReportConfig(baseTemplateData(), {}, null);
    expect((data.term as Record<string, unknown>).nextTermResumption).toBe('2026-04-20');
  });
});

describe('computePromotionStatus', () => {
  it('is not applicable for First Term regardless of average', () => {
    const result = computePromotionStatus('First Term', 3, 90, 40);
    expect(result).toEqual({ promotionClass: 'not-applicable', promotionStatus: 'Term Completed' });
  });

  it('is not applicable for Second Term regardless of average', () => {
    const result = computePromotionStatus('Second Term', 3, 10, 40);
    expect(result).toEqual({ promotionClass: 'not-applicable', promotionStatus: 'Term Completed' });
  });

  it('is pending in Third Term when no subjects have been scored', () => {
    const result = computePromotionStatus('Third Term', 0, 0, 40);
    expect(result).toEqual({ promotionClass: 'pending', promotionStatus: 'Pending' });
  });

  it('is promoted in Third Term when the overall average meets the cutoff', () => {
    const result = computePromotionStatus('Third Term', 3, 65, 40);
    expect(result).toEqual({ promotionClass: 'promoted', promotionStatus: 'Promoted' });
  });

  it('is repeat in Third Term when the overall average is below the cutoff', () => {
    const result = computePromotionStatus('Third Term', 3, 30, 40);
    expect(result).toEqual({ promotionClass: 'repeat', promotionStatus: 'Repeat Class' });
  });
});

describe('getTemplate', () => {
  it('compiles the classic template by default', () => {
    const html = getTemplate()({});
    expect(html).toContain('report-card-template" content="classic"');
  });

  it('compiles the modern template when requested', () => {
    const html = getTemplate('modern')({});
    expect(html).toContain('report-card-template" content="modern"');
  });
});

describe('generateReportCardPreview', () => {
  const SCHOOL: SchoolWithSettings = {
    id: 'school-1',
    name: 'Test School',
    slug: 'test-school',
    is_active: true,
    created_at: '2025-01-01',
    updated_at: '2025-01-01',
    identity_config: {
      logo_url: 'https://example.com/logo.png',
      motto: 'Knowledge is Power',
      signature_url: 'https://example.com/sig.png',
    },
    academic_config: {},
    notification_config: {},
    report_config: {},
  };

  it('renders dummy data with real school branding and returns a PDF buffer', async () => {
    mockFindSchoolById.mockResolvedValueOnce(SCHOOL);

    const result = await generateReportCardPreview('school-1', {
      template: 'modern',
      show_attendance: false,
      footer_text: 'Custom footer text',
    });

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(mockPuppeteer.__mockPage.setContent).toHaveBeenCalledTimes(1);

    const html = mockPuppeteer.__mockPage.setContent.mock.calls[0][0] as string;
    expect(html).toContain('report-card-template" content="modern"');
    expect(html).toContain('Test School');
    expect(html).toContain('Custom footer text');
    expect(html).not.toContain('Days Present');
  });

  it('defaults to the classic template when none is specified', async () => {
    mockFindSchoolById.mockResolvedValueOnce(SCHOOL);

    await generateReportCardPreview('school-1', {});

    const html = mockPuppeteer.__mockPage.setContent.mock.calls[0][0] as string;
    expect(html).toContain('report-card-template" content="classic"');
    expect(html).toContain('Days Present');
  });

  it('throws when the school does not exist', async () => {
    mockFindSchoolById.mockResolvedValueOnce(null);
    await expect(generateReportCardPreview('missing', {})).rejects.toThrow('School not found');
  });
});

describe('generateReportCard', () => {
  const SCHOOL: SchoolWithSettings = {
    id: 'school-1',
    name: 'Test School',
    slug: 'test-school',
    is_active: true,
    created_at: '2025-01-01',
    updated_at: '2025-01-01',
    identity_config: {},
    academic_config: {},
    notification_config: {},
    report_config: {},
  };

  const STUDENT_DATA = {
    student_id:   'student-1',
    first_name:   'Jane',
    last_name:    'Doe',
    admission_no: 'CE/2026/0001',
    photo_url:    null,
    class_id:     'class-1',
    class_name:   'JSS 2A',
    class_level:  'JSS 2',
    term_id:      'term-1',
    term_name:    'First Term',
    session_name: '2025/2026',
    next_term_resumption: null,
  };

  const CLASS_RESULT: ClassResult = {
    class_id:    'class-1',
    class_name:  'JSS 2A',
    term_id:     'term-1',
    term_name:   'First Term',
    students: [
      {
        student_id:  'student-1',
        admission_no: 'CE/2026/0001',
        first_name:  'Jane',
        last_name:   'Doe',
        subjects:    [],
        overall_average: 0,
        subjects_scored: 0,
        position:    1,
      },
    ],
    subject_averages: {},
    total_students: 1,
  };

  beforeEach(() => {
    mockFindSchoolById.mockResolvedValue(SCHOOL);
    mockFetchStudentReportData.mockResolvedValue(STUDENT_DATA);
    mockFetchPrincipalRemark.mockResolvedValue(null);
    mockFetchClassTeacherComment.mockResolvedValue(null);
    mockFetchFormTeacher.mockResolvedValue(null);
    mockUpsertReportCard.mockResolvedValue(undefined);
  });

  it('renders the form teacher remark and signature when both are present', async () => {
    mockFetchClassTeacherComment.mockResolvedValue({ comment_text: 'A pleasure to teach.' });
    mockFetchFormTeacher.mockResolvedValue({
      id: 'teacher-1',
      full_name: 'Mr. John Bello',
      title: 'Mr.',
      signature_url: 'https://example.com/teacher-sig.png',
    });

    await generateReportCard('student-1', 'term-1', 'school-1', CLASS_RESULT, new Map());

    const html = mockPuppeteer.__mockPage.setContent.mock.calls[0][0] as string;
    expect(html).toContain('<div class="section-title">Form Teacher\'s Remark</div>');
    expect(html).toContain('A pleasure to teach.');
    expect(html).toContain('https://example.com/teacher-sig.png');
    expect(html).toContain("Class Teacher's Signature");
  });

  it('omits the form teacher remark and signature image when neither is set', async () => {
    await generateReportCard('student-1', 'term-1', 'school-1', CLASS_RESULT, new Map());

    const html = mockPuppeteer.__mockPage.setContent.mock.calls[0][0] as string;
    expect(html).not.toContain('<div class="section-title">Form Teacher\'s Remark</div>');
    expect(html).toContain("Class Teacher's Signature");
  });
});
