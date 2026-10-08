import fs from 'fs';
import path from 'path';

jest.mock('../db/client', () => ({ __esModule: true, default: { query: jest.fn() } }));

import { channelsFor, attendanceAlertRule, NOTIFICATION_EVENTS } from '../services/notificationSettings';

describe('channelsFor', () => {
  it('uses the defaults where a school has chosen nothing', () => {
    expect(channelsFor({}, 'results_published')).toEqual({ in_app: true, email: true, sms: false });
    expect(channelsFor(null, 'message')).toEqual({ in_app: true, email: false, sms: false });
  });

  it("uses a school's choice for each channel it set, and the default for the rest", () => {
    const config = { events: { results_published: { email: false }, message: { email: true, in_app: false } } };
    expect(channelsFor(config, 'results_published')).toEqual({ in_app: true, email: false, sms: false });
    expect(channelsFor(config, 'message')).toEqual({ in_app: false, email: true, sms: false });
  });

  it('ignores a stored value that is not true or false, so a hand edit cannot switch a channel on', () => {
    expect(channelsFor({ events: { results_published: { email: 'no', sms: 1 } } }, 'results_published'))
      .toEqual({ in_app: true, email: true, sms: false });
  });
});

describe('attendanceAlertRule', () => {
  it('is 3 absences in 7 days until a school chooses, and its own rule after', () => {
    expect(attendanceAlertRule({})).toEqual({ threshold: 3, window_days: 7 });
    expect(attendanceAlertRule({ attendance_alert: { threshold: 2, window_days: 5 } })).toEqual({ threshold: 2, window_days: 5 });
    expect(attendanceAlertRule({ attendance_alert: { threshold: 0, window_days: 'week' } })).toEqual({ threshold: 3, window_days: 7 });
  });
});

describe('the settings page and the senders use the same defaults', () => {
  it('apps/web/lib/notificationDefaults.json is the API’s file, and names every event', () => {
    const api = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/notificationDefaults.json'), 'utf8'));
    const web = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../web/lib/notificationDefaults.json'), 'utf8'));
    expect(web).toEqual(api);
    expect(NOTIFICATION_EVENTS.length).toBeGreaterThan(0);
  });
});
