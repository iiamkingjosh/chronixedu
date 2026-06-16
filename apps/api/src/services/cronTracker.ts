interface CronRecord {
  name: string;
  schedule: string;
  description: string;
  last_run: Date | null;
  last_status: 'success' | 'error' | 'never';
  error_message: string | null;
}

const cronRegistry = new Map<string, CronRecord>();

export function registerCron(name: string, schedule: string, description: string): void {
  cronRegistry.set(name, {
    name,
    schedule,
    description,
    last_run: null,
    last_status: 'never',
    error_message: null,
  });
}

export function markCronRun(name: string, status: 'success' | 'error', error?: string): void {
  const record = cronRegistry.get(name);
  if (record) {
    record.last_run = new Date();
    record.last_status = status;
    record.error_message = error || null;
  }
}

export function getCronStatus(): CronRecord[] {
  return Array.from(cronRegistry.values());
}
