import { CronExpressionParser } from 'cron-parser';
import { getDabusClient } from '../clients/dabus';

export interface PastJobItem {
  id: string;
  jobName: string;
  entityType: string;
  lastRunAt: string | null;
  recordsObserved: number;
  status: 'SUCCESS' | 'FAILED' | 'NO_DATA';
  errorMessage?: string;
}

export interface UpcomingJobItem {
  id: string;
  jobName: string;
  cronExpression: string;
  scheduleLabel: string;
  nextRunAt: string;
  enabled: boolean;
}

export interface DabusJobsResponse {
  fetchedAt: string;
  pastJobs: PastJobItem[];
  upcomingJobs: UpcomingJobItem[];
}

interface JobDefinition {
  id: string;
  jobName: string;
  entityType: string;
  query: () => Promise<unknown[]>;
}

interface JobSchedule {
  id: string;
  jobName: string;
  cronExpression: string;
  scheduleLabel: string;
  enabled: boolean;
}

export interface DabusJobsClientLike {
  searchProducts(): Promise<unknown[]>;
  searchInventoryItems(): Promise<unknown[]>;
  searchOrders(): Promise<unknown[]>;
  searchShipments(): Promise<unknown[]>;
}

interface JobsDependencies {
  client?: DabusJobsClientLike;
  schedulesJson?: string;
  now?: Date;
}

const DEFAULT_SCHEDULES: JobSchedule[] = [
  {
    id: 'inventory-stock-sync',
    jobName: 'Inventory Stock Sync',
    cronExpression: '*/15 * * * *',
    scheduleLabel: 'Every 15 minutes',
    enabled: true,
  },
  {
    id: 'product-master-sync',
    jobName: 'Product Master Sync',
    cronExpression: '0 * * * *',
    scheduleLabel: 'Every hour',
    enabled: true,
  },
  {
    id: 'shipment-sync',
    jobName: 'Shipment Sync',
    cronExpression: '*/30 * * * *',
    scheduleLabel: 'Every 30 minutes',
    enabled: true,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSchedules(value: string | undefined): JobSchedule[] {
  if (!value) return DEFAULT_SCHEDULES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`DABUS_JOB_SCHEDULES_JSON is not valid JSON: ${String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('DABUS_JOB_SCHEDULES_JSON must be an array');
  }
  return parsed.map((schedule, index) => {
    if (!isRecord(schedule)) {
      throw new Error(`DABUS_JOB_SCHEDULES_JSON[${index}] must be an object`);
    }
    const { id, jobName, cronExpression, scheduleLabel, enabled } = schedule;
    if (
      typeof id !== 'string' ||
      typeof jobName !== 'string' ||
      typeof cronExpression !== 'string' ||
      typeof scheduleLabel !== 'string' ||
      (enabled !== undefined && typeof enabled !== 'boolean')
    ) {
      throw new Error(
        `DABUS_JOB_SCHEDULES_JSON[${index}] has invalid fields`
      );
    }
    return {
      id,
      jobName,
      cronExpression,
      scheduleLabel,
      enabled: enabled ?? true,
    };
  });
}

function latestTimestamp(items: unknown[]): string | null {
  const timestamps = items.flatMap((item) => {
    if (!isRecord(item)) return [];
    const candidate = item.updatedAt ?? item.createdAt;
    if (typeof candidate !== 'string' && !(candidate instanceof Date)) return [];
    const date = new Date(candidate);
    return Number.isNaN(date.getTime()) ? [] : [date.getTime()];
  });
  return timestamps.length
    ? new Date(Math.max(...timestamps)).toISOString()
    : null;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function loadPastJobs(client: DabusJobsClientLike): Promise<PastJobItem[]> {
  const definitions: JobDefinition[] = [
    {
      id: 'product-master-sync',
      jobName: 'Product Master Sync',
      entityType: 'products',
      query: () => client.searchProducts(),
    },
    {
      id: 'inventory-stock-sync',
      jobName: 'Inventory Stock Sync',
      entityType: 'inventory',
      query: () => client.searchInventoryItems(),
    },
    {
      id: 'order-sync',
      jobName: 'Order Sync',
      entityType: 'orders',
      query: () => client.searchOrders(),
    },
    {
      id: 'shipment-sync',
      jobName: 'Shipment Sync',
      entityType: 'shipments',
      query: () => client.searchShipments(),
    },
  ];

  const results = await Promise.allSettled(
    definitions.map((definition) => definition.query())
  );
  return results.map((result, index) => {
    const definition = definitions[index];
    if (result.status === 'rejected') {
      return {
        id: definition.id,
        jobName: definition.jobName,
        entityType: definition.entityType,
        lastRunAt: null,
        recordsObserved: 0,
        status: 'FAILED',
        errorMessage: formatError(result.reason),
      };
    }
    return {
      id: definition.id,
      jobName: definition.jobName,
      entityType: definition.entityType,
      lastRunAt: latestTimestamp(result.value),
      recordsObserved: result.value.length,
      status: result.value.length > 0 ? 'SUCCESS' : 'NO_DATA',
    };
  });
}

function loadUpcomingJobs(
  schedulesJson: string | undefined,
  now: Date
): UpcomingJobItem[] {
  return parseSchedules(schedulesJson)
    .filter((schedule) => schedule.enabled)
    .map((schedule) => {
      const nextRunAt = CronExpressionParser.parse(schedule.cronExpression, {
        currentDate: now,
        tz: 'UTC',
      })
        .next()
        .toISOString();
      if (!nextRunAt) {
        throw new Error(
          `No next run could be calculated for schedule "${schedule.id}"`
        );
      }
      return {
        id: schedule.id,
        jobName: schedule.jobName,
        cronExpression: schedule.cronExpression,
        scheduleLabel: schedule.scheduleLabel,
        enabled: schedule.enabled,
        nextRunAt,
      };
    });
}

export async function getDabusJobs(
  dependencies: JobsDependencies = {}
): Promise<DabusJobsResponse> {
  const client = dependencies.client ?? getDabusClient();
  const now = dependencies.now ?? new Date();
  const [pastJobs] = await Promise.all([loadPastJobs(client)]);
  return {
    fetchedAt: now.toISOString(),
    pastJobs,
    upcomingJobs: loadUpcomingJobs(
      dependencies.schedulesJson ?? process.env.DABUS_JOB_SCHEDULES_JSON,
      now
    ),
  };
}
