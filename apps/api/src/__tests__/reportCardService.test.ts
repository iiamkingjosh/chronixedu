import puppeteer from 'puppeteer';
import {
  applyReportConfig,
  getTemplate,
  generateReportCardPreview,
} from '../services/reportCardService';
import { findSchoolById } from '../db/queries/schools';
import type { SchoolWithSettings } from '../db/queries/schools';

jest.mock('../db/queries/schools');
jest.mock('../db/queries/reportCards', () => ({
  fetchStudentReportData: jest.fn(),
  fetchSubjectComments: jest.fn(),
  fetchPrincipalRemark: jest.fn(),
  upsertReportCard: jest.fn(),
}));
jest.mock('../services/resultEngine', () => ({
  computeClassResults: jest.fn(),
}));
jest.mock('../supabaseClient', () => ({
  supabaseAdmin: { storage: { from: jest.fn() } },
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
