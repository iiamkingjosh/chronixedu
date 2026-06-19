import { apiFetch, apiFetchBlob } from './api';

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

// ── Shared enums ──────────────────────────────────────────────────────────────

export type SchoolPlan = 'basic' | 'professional' | 'enterprise' | 'trial';
export type SubscriptionStatus = 'active' | 'suspended' | 'cancelled' | 'trial';
export type BillingCycle = 'monthly' | 'annual';
export type AnnouncementType = 'info' | 'warning' | 'critical' | 'maintenance';
export type AnnouncementStatusFilter = 'scheduled' | 'published' | 'expired' | 'all';

// ── Schools ──────────────────────────────────────────────────────────────────

export interface SchoolListItem {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  plan: SchoolPlan | null;
  subscription_status: SubscriptionStatus | null;
  amount_naira: number | null;
  next_billing_date: string | null;
  student_count: number;
  last_activity: string | null;
  created_at: string;
}

export interface SchoolsListResponse {
  schools: SchoolListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface School {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  stamp_url: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  primary_colour: string | null;
  secondary_colour: string | null;
  subscription_tier: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SchoolSettings {
  id: string;
  school_id: string;
  identity_config: Record<string, unknown>;
  academic_config: Record<string, unknown>;
  report_config: Record<string, unknown>;
  notification_config: Record<string, unknown>;
  updated_at: string;
  updated_by: string | null;
}

export interface SchoolUserCount {
  role: string;
  count: string;
}

export interface AuditLogEntry {
  id: string;
  school_id: string;
  user_id: string | null;
  action_type: string;
  entity: string;
  entity_id: string | null;
  old_value: unknown;
  new_value: unknown;
  ip_address: string | null;
  created_at: string;
}

export interface SchoolDetail {
  school: School;
  settings: SchoolSettings | null;
  subscription: PlatformSubscription | null;
  user_counts: SchoolUserCount[];
  recent_activity: AuditLogEntry[];
}

export interface ListSchoolsParams {
  page?: number;
  search?: string;
  status?: 'active' | 'inactive';
  plan?: SchoolPlan;
}

export interface SuspendReactivateResponse {
  school_id: string;
  is_active: boolean;
  reason: string;
}

export async function getSuperAdminSchools(params: ListSchoolsParams = {}): Promise<SchoolsListResponse> {
  const query = new URLSearchParams();
  if (params.page) query.set('page', String(params.page));
  if (params.search) query.set('search', params.search);
  if (params.status) query.set('status', params.status);
  if (params.plan) query.set('plan', params.plan);
  const qs = query.toString();
  const res = await apiFetch<ApiResponse<SchoolsListResponse>>(`/api/super-admin/schools${qs ? `?${qs}` : ''}`);
  return res.data;
}

export async function getSuperAdminSchool(id: string): Promise<SchoolDetail> {
  const res = await apiFetch<ApiResponse<SchoolDetail>>(`/api/super-admin/schools/${id}`);
  return res.data;
}

export async function suspendSchool(id: string, reason: string): Promise<SuspendReactivateResponse> {
  const res = await apiFetch<ApiResponse<SuspendReactivateResponse>>(`/api/super-admin/schools/${id}/suspend`, {
    method: 'PATCH',
    body: JSON.stringify({ reason }),
  });
  return res.data;
}

export async function reactivateSchool(id: string, reason: string): Promise<SuspendReactivateResponse> {
  const res = await apiFetch<ApiResponse<SuspendReactivateResponse>>(`/api/super-admin/schools/${id}/reactivate`, {
    method: 'PATCH',
    body: JSON.stringify({ reason }),
  });
  return res.data;
}

export async function exportSchoolData(id: string): Promise<Blob> {
  return apiFetchBlob(`/api/super-admin/schools/${id}/export`);
}

// ── Subscriptions ────────────────────────────────────────────────────────────

export interface PlatformSubscription {
  id: string;
  school_id: string;
  plan: SchoolPlan;
  subscription_status: SubscriptionStatus;
  amount_naira: number | null;
  billing_cycle: BillingCycle;
  next_billing_date: string | null;
  trial_ends_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionListItem {
  id: string;
  school_id: string;
  school_name: string;
  school_slug: string;
  plan: SchoolPlan;
  subscription_status: SubscriptionStatus;
  amount_naira: number;
  billing_cycle: BillingCycle;
  next_billing_date: string;
  trial_ends_at: string | null;
  created_at: string;
  days_until_billing: number;
}

export interface SubscriptionsSummary {
  total_mrr_naira: number;
  total_annual_naira: number;
  active_count: number;
  trial_count: number;
  suspended_count: number;
}

export interface SubscriptionsListResponse {
  subscriptions: SubscriptionListItem[];
  summary: SubscriptionsSummary;
  total: number;
  page: number;
  limit: number;
}

export interface MRRByPlan {
  plan: string;
  mrr: number;
  count: number;
}

export interface MRRResponse {
  total_mrr: number;
  by_plan: MRRByPlan[];
  currency: 'NGN';
}

export interface ListSubscriptionsParams {
  status?: string;
  plan?: string;
  page?: number;
}

export interface CreateSubscriptionInput {
  school_id: string;
  plan: SchoolPlan;
  billing_cycle: BillingCycle;
  amount_naira: number;
  trial_ends_at?: string;
}

export interface UpdateSubscriptionInput {
  plan?: SchoolPlan;
  subscription_status?: SubscriptionStatus;
  billing_cycle?: BillingCycle;
  amount_naira?: number;
  next_billing_date?: string;
  trial_ends_at?: string;
}

export interface RecordPaymentInput {
  amount: number;
  reference: string;
  payment_date: string;
  notes?: string;
}

export interface RecordPaymentResponse {
  subscription_id: string;
  school_id: string;
  amount_recorded: number;
  reference: string;
  payment_date: string;
}

export interface ExtendTrialResponse {
  subscription_id: string;
  days_added: number;
  new_trial_ends_at: string;
}

export async function getSubscriptions(params: ListSubscriptionsParams = {}): Promise<SubscriptionsListResponse> {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.plan) query.set('plan', params.plan);
  if (params.page) query.set('page', String(params.page));
  const qs = query.toString();
  const res = await apiFetch<ApiResponse<SubscriptionsListResponse>>(`/api/super-admin/subscriptions${qs ? `?${qs}` : ''}`);
  return res.data;
}

export async function getMRR(): Promise<MRRResponse> {
  const res = await apiFetch<ApiResponse<MRRResponse>>('/api/super-admin/subscriptions/mrr');
  return res.data;
}

export async function createSubscription(data: CreateSubscriptionInput): Promise<PlatformSubscription> {
  const res = await apiFetch<ApiResponse<PlatformSubscription>>('/api/super-admin/subscriptions', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  return res.data;
}

export async function updateSubscription(id: string, data: UpdateSubscriptionInput): Promise<PlatformSubscription> {
  const res = await apiFetch<ApiResponse<PlatformSubscription>>(`/api/super-admin/subscriptions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
  return res.data;
}

export async function recordPayment(subId: string, data: RecordPaymentInput): Promise<RecordPaymentResponse> {
  const res = await apiFetch<ApiResponse<RecordPaymentResponse>>(`/api/super-admin/subscriptions/${subId}/record-payment`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
  return res.data;
}

export async function extendTrial(subId: string, days: 7 | 14 | 30): Promise<ExtendTrialResponse> {
  const res = await apiFetch<ApiResponse<ExtendTrialResponse>>(`/api/super-admin/subscriptions/${subId}/extend-trial`, {
    method: 'POST',
    body: JSON.stringify({ days }),
  });
  return res.data;
}

// ── Onboarding ───────────────────────────────────────────────────────────────

export interface OnboardingSessionListItem {
  id: string;
  status: string;
  steps_completed: Record<string, unknown>;
  created_at: string;
  completed_at: string | null;
  school_id: string | null;
  school_name: string | null;
  created_by: string;
}

export interface OnboardingSession {
  id: string;
  school_id: string;
  created_by: string;
  status: string;
  steps_completed: Record<string, unknown>;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StartOnboardingInput {
  school_name: string;
  school_email: string;
}

export interface StartOnboardingResponse {
  session_id: string;
  school_id: string;
  school_slug: string;
}

export interface OnboardingStepResponse {
  step: number;
  completed: boolean;
  session: OnboardingSession;
  principal_created?: boolean;
  temp_password?: string;
}

export interface CompleteOnboardingResponse {
  school_id: string;
  school_name: string;
  principal_email: string | null;
  is_active: boolean;
  message: string;
}

export async function startOnboarding(data: StartOnboardingInput): Promise<StartOnboardingResponse> {
  const res = await apiFetch<ApiResponse<StartOnboardingResponse>>('/api/super-admin/onboarding', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  return res.data;
}

export async function saveOnboardingStep(
  sessionId: string,
  step: number,
  data: Record<string, unknown>
): Promise<OnboardingStepResponse> {
  const res = await apiFetch<ApiResponse<OnboardingStepResponse>>(`/api/super-admin/onboarding/${sessionId}/step/${step}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
  return res.data;
}

export async function completeOnboarding(sessionId: string): Promise<CompleteOnboardingResponse> {
  const res = await apiFetch<ApiResponse<CompleteOnboardingResponse>>(`/api/super-admin/onboarding/${sessionId}/complete`, {
    method: 'POST',
  });
  return res.data;
}

// ── Analytics ────────────────────────────────────────────────────────────────

export interface SuperAdminOverview {
  total_schools: number;
  active_schools: number;
  total_students: number;
  total_mrr_naira: number;
  trial_count: number;
  new_schools_this_month: number;
  last_snapshot_date: string | null;
  computed_at: string;
}

export interface SchoolActivity {
  school_id: string;
  school_name: string;
  is_active: boolean;
  plan: SchoolPlan | null;
  subscription_status: SubscriptionStatus | null;
  activity_score: number;
  is_dormant: boolean;
  logins_30d: number;
  score_entries_30d: number;
  attendance_marks_30d: number;
}

export interface FeatureAdoption {
  feature: string;
  schools_using: number;
  total_active: number;
  adoption_pct: number;
}

export interface GrowthData {
  months: string[];
  schools: number[];
  students: number[];
}

export async function getSuperAdminOverview(): Promise<SuperAdminOverview> {
  const res = await apiFetch<ApiResponse<SuperAdminOverview>>('/api/super-admin/analytics/overview');
  return res.data;
}

export async function getSchoolsActivity(): Promise<SchoolActivity[]> {
  const res = await apiFetch<ApiResponse<SchoolActivity[]>>('/api/super-admin/analytics/schools');
  return res.data;
}

export async function getFeatureAdoption(): Promise<FeatureAdoption[]> {
  const res = await apiFetch<ApiResponse<FeatureAdoption[]>>('/api/super-admin/analytics/feature-adoption');
  return res.data;
}

export async function getGrowthData(): Promise<GrowthData> {
  const res = await apiFetch<ApiResponse<GrowthData>>('/api/super-admin/analytics/growth');
  return res.data;
}

// ── Platform Health ──────────────────────────────────────────────────────────

export interface PlatformMetricsSnapshot {
  id: string;
  snapshot_date: string;
  total_schools: number;
  active_schools: number;
  total_students: number;
  total_mrr_naira: number;
  new_schools_this_month: number;
  churned_schools_this_month: number;
  api_errors_24h: number;
  created_at: string;
}

export interface HealthOverview {
  active_support_sessions: number;
  audit_events_24h: number;
  last_snapshot: PlatformMetricsSnapshot | null;
  error_count_24h: number | null;
  log_note: string | null;
  checked_at: string;
}

export interface CronStatusEntry {
  name: string;
  schedule: string;
  description: string;
  last_run: string | null;
  last_status: 'success' | 'error' | 'never';
  error_message: string | null;
  expected_interval_hours: number;
  is_stale: boolean;
}

export async function getHealthOverview(): Promise<HealthOverview> {
  const res = await apiFetch<ApiResponse<HealthOverview>>('/api/super-admin/health/overview');
  return res.data;
}

export async function getCronStatus(): Promise<CronStatusEntry[]> {
  const res = await apiFetch<ApiResponse<CronStatusEntry[]>>('/api/super-admin/health/crons');
  return res.data;
}

// ── Announcements ────────────────────────────────────────────────────────────

export interface Announcement {
  id: string;
  title: string;
  body: string;
  type: AnnouncementType;
  target_plans: SchoolPlan[];
  scheduled_at: string | null;
  expires_at: string | null;
  published_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  created_by_email: string;
}

export interface CreateAnnouncementInput {
  title: string;
  body: string;
  type: AnnouncementType;
  target_plans: SchoolPlan[];
  scheduled_at?: string;
  expires_at?: string;
}

export interface UpdateAnnouncementInput {
  title?: string;
  body?: string;
  type?: AnnouncementType;
  target_plans?: SchoolPlan[];
  scheduled_at?: string;
  expires_at?: string;
}

export interface PublishAnnouncementResponse {
  announcement_id: string;
  published_at: string;
  recipients_count: number;
}

export async function getAnnouncements(status?: AnnouncementStatusFilter): Promise<Announcement[]> {
  const qs = status ? `?status=${status}` : '';
  const res = await apiFetch<ApiResponse<Announcement[]>>(`/api/super-admin/announcements${qs}`);
  return res.data;
}

export async function createAnnouncement(data: CreateAnnouncementInput): Promise<Announcement> {
  const res = await apiFetch<ApiResponse<Announcement>>('/api/super-admin/announcements', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  return res.data;
}

export async function updateAnnouncement(id: string, data: UpdateAnnouncementInput): Promise<Announcement> {
  const res = await apiFetch<ApiResponse<Announcement>>(`/api/super-admin/announcements/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
  return res.data;
}

export async function publishAnnouncement(id: string): Promise<PublishAnnouncementResponse> {
  const res = await apiFetch<ApiResponse<PublishAnnouncementResponse>>(`/api/super-admin/announcements/${id}/publish`, {
    method: 'POST',
  });
  return res.data;
}

export async function deleteAnnouncement(id: string): Promise<{ deleted: boolean; id: string }> {
  const res = await apiFetch<ApiResponse<{ deleted: boolean; id: string }>>(`/api/super-admin/announcements/${id}`, {
    method: 'DELETE',
  });
  return res.data;
}

// ── Support Sessions ─────────────────────────────────────────────────────────

export interface SupportSession {
  id: string;
  reason: string;
  started_at: string;
  ended_at: string | null;
  admin_email: string;
  impersonated_email: string;
  impersonated_role: string;
  school_name: string;
  status: 'active' | 'ended';
  duration_minutes: number;
}

export interface StartSupportSessionInput {
  school_id: string;
  user_id: string;
  reason: string;
}

export interface StartSupportSessionResponse {
  session_id: string;
  scoped_token: string;
}

export interface EndSupportSessionResponse {
  session_id: string;
  duration_minutes: number;
}

export async function getSupportSessions(): Promise<SupportSession[]> {
  const res = await apiFetch<ApiResponse<SupportSession[]>>('/api/super-admin/support-sessions');
  return res.data;
}

export async function startSupportSession(data: StartSupportSessionInput): Promise<StartSupportSessionResponse> {
  const res = await apiFetch<ApiResponse<StartSupportSessionResponse>>('/api/super-admin/support-sessions', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  return res.data;
}

export async function endSupportSession(id: string): Promise<EndSupportSessionResponse> {
  const res = await apiFetch<ApiResponse<EndSupportSessionResponse>>(`/api/super-admin/support-sessions/${id}/end`, {
    method: 'PATCH',
  });
  return res.data;
}

// ── Audit Logs ───────────────────────────────────────────────────────────────

export interface PlatformAuditLog {
  id: string;
  action_type: string;
  target_school_id: string | null;
  target_user_id: string | null;
  metadata: Record<string, unknown> | null;
  ip_address: string | null;
  support_session_id: string | null;
  created_at: string;
  admin_email: string;
  school_name: string | null;
}

export interface AuditLogsParams {
  page?: number;
  action_type?: string;
  school_id?: string;
  from?: string;
  to?: string;
}

export async function getAuditLogs(params: AuditLogsParams = {}): Promise<PlatformAuditLog[]> {
  const query = new URLSearchParams();
  if (params.page) query.set('page', String(params.page));
  if (params.action_type) query.set('action_type', params.action_type);
  if (params.school_id) query.set('school_id', params.school_id);
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  const qs = query.toString();
  const res = await apiFetch<ApiResponse<PlatformAuditLog[]>>(`/api/super-admin/audit-logs${qs ? `?${qs}` : ''}`);
  return res.data;
}

// ── Platform Admins ──────────────────────────────────────────────────────────

export interface SuspendReactivateAdminResponse {
  admin_id: string;
  is_active: boolean;
  reason: string;
}

export async function suspendPlatformAdmin(id: string, reason: string): Promise<SuspendReactivateAdminResponse> {
  const res = await apiFetch<ApiResponse<SuspendReactivateAdminResponse>>(`/api/super-admin/admins/${id}/suspend`, {
    method: 'PATCH',
    body: JSON.stringify({ reason }),
  });
  return res.data;
}

export async function reactivatePlatformAdmin(id: string, reason: string): Promise<SuspendReactivateAdminResponse> {
  const res = await apiFetch<ApiResponse<SuspendReactivateAdminResponse>>(`/api/super-admin/admins/${id}/reactivate`, {
    method: 'PATCH',
    body: JSON.stringify({ reason }),
  });
  return res.data;
}

export async function deletePlatformAdmin(id: string, confirmationEmail: string): Promise<{ admin_id: string; deleted: boolean }> {
  const res = await apiFetch<ApiResponse<{ admin_id: string; deleted: boolean }>>(`/api/super-admin/admins/${id}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmation_email: confirmationEmail }),
  });
  return res.data;
}
