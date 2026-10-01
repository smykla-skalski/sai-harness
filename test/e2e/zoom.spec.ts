import { browser, expect } from '@wdio/globals';

describe('interface zoom', () => {
  it('shrinks, enlarges, and resets with Command shortcuts', async () => {
    const width = await browser.execute(() => window.innerWidth);
    await browser.keys(['Meta', '-']);
    await browser.waitUntil(async () => (await browser.execute(() => window.innerWidth)) > width, {
      timeoutMsg: 'Command-minus did not shrink the interface',
    });
    const zoomedOutWidth = await browser.execute(() => window.innerWidth);
    expect(zoomedOutWidth).toBeGreaterThan(width);

    await browser.keys(['Meta', '0']);
    await browser.waitUntil(
      async () => (await browser.execute(() => window.innerWidth)) === width,
      {
        timeoutMsg: 'Command-zero did not reset the interface zoom',
      },
    );

    await browser.keys(['Meta', '=']);
    await browser.waitUntil(async () => (await browser.execute(() => window.innerWidth)) < width, {
      timeoutMsg: 'Command-plus did not enlarge the interface',
    });
    await browser.keys(['Meta', '0']);
    await browser.waitUntil(
      async () => (await browser.execute(() => window.innerWidth)) === width,
      { timeoutMsg: 'Command-zero did not restore the interface after zooming in' },
    );
  });
});
