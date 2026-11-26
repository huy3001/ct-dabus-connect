import { getDabusJobs } from '../../src/services/dabusJobs.service';

function createClient() {
  return {
    searchProducts: jest.fn(async () => [
      { sku: 'one', updatedAt: '2026-11-20T10:00:00.000Z' },
      { sku: 'two', updatedAt: '2026-11-20T12:00:00.000Z' },
    ]),
    searchInventoryItems: jest.fn(async () => []),
    searchOrders: jest.fn(async () => [
      { orderNumber: 'o1', createdAt: '2026-11-20T09:00:00.000Z' },
    ]),
    searchShipments: jest.fn(async () => [
      { trackNumber: 's1', updatedAt: '2026-11-20T11:00:00.000Z' },
    ]),
  };
}

describe('getDabusJobs', () => {
  it('queries all repositories and derives past jobs in parallel', async () => {
    const client = createClient();
    const response = await getDabusJobs({
      client,
      now: new Date('2026-11-20T12:10:00.000Z'),
    });

    expect(client.searchProducts).toHaveBeenCalledTimes(1);
    expect(client.searchInventoryItems).toHaveBeenCalledTimes(1);
    expect(client.searchOrders).toHaveBeenCalledTimes(1);
    expect(client.searchShipments).toHaveBeenCalledTimes(1);
    expect(response.pastJobs).toEqual([
      expect.objectContaining({
        id: 'product-master-sync',
        status: 'SUCCESS',
        recordsObserved: 2,
        lastRunAt: '2026-11-20T12:00:00.000Z',
      }),
      expect.objectContaining({
        id: 'inventory-stock-sync',
        status: 'NO_DATA',
        recordsObserved: 0,
        lastRunAt: null,
      }),
      expect.objectContaining({
        id: 'order-sync',
        status: 'SUCCESS',
        lastRunAt: '2026-11-20T09:00:00.000Z',
      }),
      expect.objectContaining({
        id: 'shipment-sync',
        status: 'SUCCESS',
      }),
    ]);
  });

  it('isolates a failed repository search', async () => {
    const client = createClient();
    client.searchOrders = jest.fn(async () => {
      throw new Error('Dabus unavailable');
    });

    const response = await getDabusJobs({
      client,
      now: new Date('2026-11-20T12:10:00.000Z'),
    });
    expect(response.pastJobs.find((job) => job.entityType === 'orders')).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        recordsObserved: 0,
        errorMessage: 'Dabus unavailable',
      })
    );
    expect(response.pastJobs.find((job) => job.entityType === 'products')?.status)
      .toBe('SUCCESS');
  });

  it('calculates the next UTC run from configured cron schedules', async () => {
    const response = await getDabusJobs({
      client: createClient(),
      now: new Date('2026-11-20T12:10:00.000Z'),
      schedulesJson: JSON.stringify([
        {
          id: 'inventory',
          jobName: 'Inventory Stock Sync',
          cronExpression: '*/15 * * * *',
          scheduleLabel: 'Every 15 minutes',
          enabled: true,
        },
        {
          id: 'disabled',
          jobName: 'Disabled Sync',
          cronExpression: '* * * * *',
          scheduleLabel: 'Every minute',
          enabled: false,
        },
      ]),
    });

    expect(response.upcomingJobs).toEqual([
      {
        id: 'inventory',
        jobName: 'Inventory Stock Sync',
        cronExpression: '*/15 * * * *',
        scheduleLabel: 'Every 15 minutes',
        enabled: true,
        nextRunAt: '2026-11-20T12:15:00.000Z',
      },
    ]);
  });
});
